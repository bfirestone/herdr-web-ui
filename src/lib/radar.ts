import type { AgentStatus, HerdrPane, SessionSnapshot, WorkspaceInfo } from "../../shared/protocol.ts";
import { rosterPanes } from "./dagPane.ts";
import { knownStatus } from "./status.ts";

/**
 * The radar roster: herdr-radar's rules for the Agents panel, derived from a snapshot and a clock.
 * Pure: no React, no DOM. The component re-derives on every snapshot and once a minute.
 */

/** working, blocked and done as herdr settles them; idle split by age since the pane last worked */
export type RadarState = "working" | "blocked" | "done" | "idle_fresh" | "idle" | "idle_stale" | "unknown";
/** `active`: grouped by workspace, ordered by activity at both levels; `recent`: one flat list by activity */
export type RadarOrder = "active" | "recent";
/** an idle pane reads as just stopped this long after its last turn */
export const FRESH_MS = 15 * 60_000;
/** an idle pane reads as stale, and its row dims, this long after its last turn */
export const STALE_MS = 120 * 60_000;

export interface RadarRow {
  pane: HerdrPane;
  state: RadarState;
  /** not the first agent pane of a tab with several: drawn hanging off the head */
  splitChild: boolean;
}

export interface RadarGroup {
  workspace: WorkspaceInfo;
  rows: RadarRow[];
  /** linked worktrees whose main checkout is an open workspace with an agent, in order */
  children: RadarGroup[];
  /** a linked worktree whose main checkout has no displayed agent group (closed, or open with only shells): the repo name goes on the header instead of a tree corner */
  orphanRepo: string | null;
  /** every row is idle_stale: the header dims with them */
  stale: boolean;
}

/** working, blocked and done pass through; idle splits by age since the stamp; no stamp reads as plain idle */
export function radarState(status: AgentStatus, lastWorkingAt: number | undefined, now: number): RadarState {
  const known = knownStatus(status);
  if (known !== "idle") return known;
  if (lastWorkingAt === undefined) return "idle";
  const age = now - lastWorkingAt;
  if (age <= FRESH_MS) return "idle_fresh";
  if (age >= STALE_MS) return "idle_stale";
  return "idle";
}

/** Equal minutes never interleave two groups: radar's own grain. */
function minuteKey(pane: HerdrPane): number | null {
  return typeof pane.last_working_at === "number" ? Math.floor(pane.last_working_at / 60_000) : null;
}

/** Larger minute first, unstamped after every stamped, then the earlier of two snapshot positions. */
function byRecency(a: number | null, b: number | null, tieA: number, tieB: number): number {
  if (a !== b) {
    if (a === null) return 1;
    if (b === null) return -1;
    return b - a;
  }
  return tieA - tieB;
}

const best = (keys: (number | null)[]): number | null => keys.reduce<number | null>((acc, key) => (key === null ? acc : acc === null ? key : Math.max(acc, key)), null);

interface Entry { pane: HerdrPane; index: number; key: number | null; state: RadarState }

/** The agent panes the roster shows, in snapshot order, with their state. */
function entries(snapshot: SessionSnapshot, now: number): Entry[] {
  return rosterPanes(snapshot.panes as HerdrPane[])
    .map((pane, index) => ({ pane, index, key: minuteKey(pane), state: radarState(pane.agent_status, pane.last_working_at, now) }))
    .filter((entry) => typeof entry.pane.agent === "string" && entry.pane.agent !== "");
}

/** One workspace's rows in the active order: tab units by their newest member, the head first in each. */
function workspaceRows(members: Entry[]): RadarRow[] {
  const units = new Map<string, Entry[]>();
  for (const entry of members) {
    const unit = units.get(entry.pane.tab_id) ?? [];
    unit.push(entry);
    units.set(entry.pane.tab_id, unit);
  }
  const ordered = [...units.values()].sort((a, b) => byRecency(best(a.map((e) => e.key)), best(b.map((e) => e.key)), a[0]!.index, b[0]!.index));
  return ordered.flatMap((unit) => {
    const [head, ...rest] = unit;
    const children = rest.sort((a, b) => byRecency(a.key, b.key, a.index, b.index));
    const split = unit.length > 1;
    return [{ pane: head!.pane, state: head!.state, splitChild: false }, ...children.map((e) => ({ pane: e.pane, state: e.state, splitChild: split }))];
  });
}

/** the `active` order: workspace groups by activity, worktree families kept together, split units adjacent */
export function radarGroups(snapshot: SessionSnapshot, now: number): RadarGroup[] {
  const all = entries(snapshot, now);
  const byWorkspace = new Map<string, Entry[]>();
  for (const entry of all) {
    const members = byWorkspace.get(entry.pane.workspace_id) ?? [];
    members.push(entry);
    byWorkspace.set(entry.pane.workspace_id, members);
  }
  // groups exist only for workspaces with an agent pane; the parent of a family must have one too
  const groups = new Map<string, { group: RadarGroup; key: number | null; index: number }>();
  snapshot.workspaces.forEach((workspace, index) => {
    const members = byWorkspace.get(workspace.workspace_id);
    if (!members) return;
    const rows = workspaceRows(members);
    groups.set(workspace.workspace_id, {
      group: { workspace, rows, children: [], orphanRepo: null, stale: rows.every((row) => row.state === "idle_stale") },
      key: best(members.map((e) => e.key)),
      index,
    });
  });
  const parentByRepo = new Map<string, string>();
  for (const workspace of snapshot.workspaces) {
    if (workspace.worktree && !workspace.worktree.is_linked_worktree && groups.has(workspace.workspace_id) && !parentByRepo.has(workspace.worktree.repo_key)) {
      parentByRepo.set(workspace.worktree.repo_key, workspace.workspace_id);
    }
  }
  const top: { group: RadarGroup; key: number | null; index: number }[] = [];
  const childrenOf = new Map<string, { group: RadarGroup; key: number | null; index: number }[]>();
  for (const [workspaceId, entry] of groups) {
    const worktree = entry.group.workspace.worktree;
    const parent = worktree?.is_linked_worktree ? parentByRepo.get(worktree.repo_key) : undefined;
    if (parent !== undefined && parent !== workspaceId) {
      const siblings = childrenOf.get(parent) ?? [];
      siblings.push(entry);
      childrenOf.set(parent, siblings);
      continue;
    }
    if (worktree?.is_linked_worktree) entry.group.orphanRepo = worktree.repo_name;
    top.push(entry);
  }
  for (const entry of top) {
    const children = (childrenOf.get(entry.group.workspace.workspace_id) ?? []).sort((a, b) => byRecency(a.key, b.key, a.index, b.index));
    entry.group.children = children.map((child) => child.group);
    // a family ranks by its best member: the parent's own key, or a busier child's
    entry.key = best([entry.key, ...children.map((child) => child.key)]);
  }
  return top.sort((a, b) => byRecency(a.key, b.key, a.index, b.index)).map((entry) => entry.group);
}

/** the `recent` order: every agent pane flat by activity, unstamped last */
export function radarRecent(snapshot: SessionSnapshot, now: number): RadarRow[] {
  return entries(snapshot, now)
    .sort((a, b) => byRecency(a.key, b.key, a.index, b.index))
    .map((entry) => ({ pane: entry.pane, state: entry.state, splitChild: false }));
}

/** every displayed pane id, top to bottom, for adjacent-pane navigation */
export function radarPaneOrder(snapshot: SessionSnapshot, order: RadarOrder, now: number): string[] {
  if (order === "recent") return radarRecent(snapshot, now).map((row) => row.pane.pane_id);
  const walk = (group: RadarGroup): string[] => [...group.rows.map((row) => row.pane.pane_id), ...group.children.flatMap(walk)];
  return radarGroups(snapshot, now).flatMap(walk);
}
