import type { AgentStatus, HerdrPane, SessionSnapshot, WorkspaceInfo } from "../../shared/protocol.ts";

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

const PENDING = "radar implementation pending T3";

/** working, blocked and done pass through; idle splits by age since the stamp; no stamp reads as plain idle */
export function radarState(status: AgentStatus, lastWorkingAt: number | undefined, now: number): RadarState {
  void status; void lastWorkingAt; void now;
  throw new Error(PENDING);
}

/** the `active` order: workspace groups by activity, worktree families kept together, split units adjacent */
export function radarGroups(snapshot: SessionSnapshot, now: number): RadarGroup[] {
  void snapshot; void now;
  throw new Error(PENDING);
}

/** the `recent` order: every agent pane flat by activity, unstamped last */
export function radarRecent(snapshot: SessionSnapshot, now: number): RadarRow[] {
  void snapshot; void now;
  throw new Error(PENDING);
}

/** every displayed pane id, top to bottom, for adjacent-pane navigation */
export function radarPaneOrder(snapshot: SessionSnapshot, order: RadarOrder, now: number): string[] {
  void snapshot; void order; void now;
  throw new Error(PENDING);
}
