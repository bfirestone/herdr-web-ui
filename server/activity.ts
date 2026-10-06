import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

import type { AgentStatus } from "../shared/protocol.ts";
import { herdrSocketId } from "./completion.ts";

/**
 * When each pane's agent last worked, for the radar roster's order and idle tiers.
 *
 * herdr reports what an agent is doing, never when it last did it, so `idle` covers both the
 * session glanced at a minute ago and the one abandoned two days back. The status collector
 * sees every transition, so the stamp is taken here from the SETTLED status (completion.ts
 * turns OmO's `unknown` into `working`), and served on each pane as `last_working_at`.
 *
 * Kept in a file, like completions.json, so a restart of this server loses nothing: keyed by
 * the herdr socket's identity, because a herdr started anew reuses pane ids. A working agent
 * flips status often, so writes coalesce to one per ACTIVITY_WRITE_INTERVAL_MS with a trailing
 * write, and stop() flushes what is pending.
 *
 * Snapshots are asynchronous and can overtake events (completion.ts has the same problem): a
 * snapshot requested at revision r may stamp or forget only panes unchanged since r.
 */
export const ACTIVITY_WRITE_INTERVAL_MS = 5_000;

export class ActivityTracker {
  private readonly stamps = new Map<string, number>();
  /** advanced by every change; the revision each pane last changed at */
  private revision = 0;
  private readonly changedAt = new Map<string, number>();
  /** the revision herdr's identity last changed at: a snapshot requested before it is another herdr's */
  private rekeyedAt = 0;
  private identity: string | null;
  private saved = "";
  private lastWrite = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private readonly file: string | null = null,
    private readonly herdr: () => string | null = herdrSocketId,
    private readonly clock: () => number = Date.now,
  ) {
    this.identity = herdr();
    if (file === null || this.identity === null) return;
    try {
      const state = JSON.parse(readFileSync(file, "utf8")) as { herdr?: unknown; panes?: unknown };
      if (state.herdr !== this.identity) return;
      const panes = state.panes && typeof state.panes === "object" && !Array.isArray(state.panes) ? state.panes as Record<string, unknown> : {};
      for (const [pane, at] of Object.entries(panes)) if (typeof at === "number" && Number.isFinite(at)) this.stamps.set(pane, at);
      this.saved = this.serialize(this.identity);
    } catch { /* none yet, or unreadable: start empty */ }
  }

  /** Call when a snapshot is requested: what its reconcile is measured from. */
  begin(): number {
    this.rekey();
    return this.revision;
  }

  /** A settled status: `working` stamps the pane now. True when the stamp moved. */
  observe(paneId: string, status: AgentStatus, now = this.clock()): boolean {
    this.rekey();
    if (status !== "working") return false;
    return this.stamp(paneId, now);
  }

  at(paneId: string): number | null {
    this.rekey();
    return this.stamps.get(paneId) ?? null;
  }

  /** The pane ended. */
  drop(paneId: string): void {
    this.rekey();
    const had = this.stamps.delete(paneId);
    this.touch(paneId);
    if (had) this.schedule(true);
  }

  /**
   * A snapshot requested at `revision` has landed: its working panes with no stamp are stamped
   * now (a pane mid-turn when the server started, before the collector's first baseline), and
   * panes it no longer lists are forgotten. Panes that changed since the request are left alone,
   * and a snapshot from before herdr restarted says nothing.
   */
  reconcile(panes: readonly { pane_id: string; agent_status: AgentStatus }[], revision: number, now = this.clock()): void {
    this.rekey();
    if (revision < this.rekeyedAt) return;
    const untouched = (pane: string): boolean => (this.changedAt.get(pane) ?? 0) <= revision;
    let changed = false;
    for (const pane of panes) {
      if (pane.agent_status === "working" && !this.stamps.has(pane.pane_id) && untouched(pane.pane_id)) changed = this.stamp(pane.pane_id, now) || changed;
    }
    const live = new Set(panes.map((pane) => pane.pane_id));
    for (const pane of [...this.stamps.keys()]) {
      if (live.has(pane) || !untouched(pane)) continue;
      this.stamps.delete(pane);
      this.touch(pane);
      changed = true;
    }
    if (changed) this.schedule(true);
  }

  /** The panes with their stamps on; a pane without one is returned as is. */
  apply<T extends { pane_id: string }>(panes: readonly T[]): (T & { last_working_at?: number })[] {
    return panes.map((pane) => {
      const at = this.stamps.get(pane.pane_id);
      return at === undefined ? pane : { ...pane, last_working_at: at };
    });
  }

  /** Orderly shutdown: the pending write lands now. */
  stop(): void {
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
    this.write();
  }

  private stamp(paneId: string, now: number): boolean {
    if (this.stamps.get(paneId) === now) return false;
    this.stamps.set(paneId, now);
    this.touch(paneId);
    this.schedule(false);
    return true;
  }

  private touch(paneId: string): void {
    this.changedAt.set(paneId, ++this.revision);
  }

  /** herdr restarted under this server: its pane ids are another herdr's, and so is anything still being read. */
  private rekey(): void {
    const current = this.herdr();
    if (current === null || current === this.identity) return;
    this.identity = current;
    this.stamps.clear();
    this.changedAt.clear();
    this.rekeyedAt = ++this.revision;
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
    this.saved = "";
  }

  /** At most one write per interval; a change inside it is written when the interval ends, or at stop(). */
  private schedule(force: boolean): void {
    if (this.file === null) return;
    const now = this.clock();
    if (force || now - this.lastWrite >= ACTIVITY_WRITE_INTERVAL_MS) { this.write(); return; }
    if (this.timer) return;
    this.timer = setTimeout(() => { this.timer = null; this.write(); }, ACTIVITY_WRITE_INTERVAL_MS - (now - this.lastWrite));
    this.timer.unref?.();
  }

  /** Written whole, and only on a change: a crash mid-write must not leave half a file. */
  private write(): void {
    if (this.file === null || this.identity === null) return;
    const state = this.serialize(this.identity);
    if (state === this.saved) return;
    this.lastWrite = this.clock();
    try {
      mkdirSync(dirname(this.file), { recursive: true, mode: 0o700 });
      const temporary = `${this.file}.${process.pid}.tmp`;
      writeFileSync(temporary, state, { mode: 0o600 });
      renameSync(temporary, this.file);
      this.saved = state;
    } catch (error) {
      // a full disk costs the stamps after a restart, never the sidebar now
      console.error(`activity state: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private serialize(herdr: string): string {
    return JSON.stringify({ herdr, panes: Object.fromEntries([...this.stamps].sort(([a], [b]) => a.localeCompare(b))) });
  }
}
