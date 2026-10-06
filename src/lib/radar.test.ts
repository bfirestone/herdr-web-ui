import { describe, expect, it } from "bun:test";
import type { HerdrPane, SessionSnapshot, WorkspaceInfo } from "../../shared/protocol.ts";
import { FRESH_MS, STALE_MS, radarGroups, radarPaneOrder, radarRecent, radarState, type RadarOrder, type RadarRow, type RadarState } from "./radar.ts";

// --- Contract assertions ---
// These verify the design spec. Do NOT modify without updating the approved plan.
describe("radar contracts", () => {
  it("holds the shared contracts", () => {
    const state: RadarState = "idle_stale";
    const order: RadarOrder = "recent";
    const pane = { pane_id: "p", workspace_id: "w", tab_id: "t", terminal_id: "x", revision: 1, focused: false, agent_status: "idle", last_working_at: 0 } as HerdrPane;
    const row: RadarRow = { pane, state: "working", splitChild: false };
    const ms: [number, number] = [FRESH_MS, STALE_MS];
    void state; void order; void row; void ms;
    expect(FRESH_MS).toBe(15 * 60_000);
    expect(STALE_MS).toBe(120 * 60_000);
  });
});

// --- Behavior tests (added by T3) ---

const NOW = 10 * 60 * 60_000;
const min = (n: number) => NOW - n * 60_000;

interface P { id: string; ws: string; tab: string; agent?: string | null; status?: string; at?: number; label?: string; title?: string }
interface W { id: string; label: string; worktree?: { repo_key: string; repo_name: string; linked: boolean } }

function fixture(workspaces: W[], panes: P[]): SessionSnapshot {
  return {
    protocol: 22, version: "t", layouts: [], tabs: [], agents: [],
    workspaces: workspaces.map((w, i) => ({
      workspace_id: w.id, label: w.label, number: i + 1, focused: false, agent_status: "idle", active_tab_id: `${w.id}:t1`, pane_count: 1, tab_count: 1,
      worktree: w.worktree ? { checkout_path: `/r/${w.id}`, is_linked_worktree: w.worktree.linked, repo_key: w.worktree.repo_key, repo_name: w.worktree.repo_name, repo_root: `/r/${w.worktree.repo_key}` } : null,
    } as WorkspaceInfo)),
    panes: panes.map((p) => ({
      pane_id: p.id, workspace_id: p.ws, tab_id: p.tab, terminal_id: p.id, revision: 1, focused: false,
      agent: p.agent === undefined ? "claude" : p.agent, agent_status: p.status ?? "idle",
      ...(p.at === undefined ? {} : { last_working_at: p.at }), ...(p.label ? { label: p.label } : {}), ...(p.title ? { terminal_title: p.title } : {}),
    })),
  } as unknown as SessionSnapshot;
}

const ids = (groups: ReturnType<typeof radarGroups>): unknown[] => groups.map((g) => [g.workspace.workspace_id, g.rows.map((r) => r.pane.pane_id), g.children.map((c) => [c.workspace.workspace_id, c.rows.map((r) => r.pane.pane_id)])]);

describe("radarState", () => {
  it("splits idle by age at exactly the thresholds, and passes the attention states through", () => {
    expect(radarState("idle", NOW - FRESH_MS, NOW)).toBe("idle_fresh");
    expect(radarState("idle", NOW - FRESH_MS - 1000, NOW)).toBe("idle");
    expect(radarState("idle", NOW - STALE_MS + 1000, NOW)).toBe("idle");
    expect(radarState("idle", NOW - STALE_MS, NOW)).toBe("idle_stale");
    expect(radarState("idle", undefined, NOW)).toBe("idle");
    expect(radarState("working", NOW - STALE_MS, NOW)).toBe("working");
    expect(radarState("blocked", undefined, NOW)).toBe("blocked");
    expect(radarState("done", NOW - STALE_MS, NOW)).toBe("done");
    expect(radarState("unknown", NOW, NOW)).toBe("unknown");
    expect(radarState("something-new", NOW, NOW)).toBe("unknown");
  });
});

describe("radarGroups", () => {
  it("lists agent panes only, under their workspace, busiest workspace first, unstamped last", () => {
    const snapshot = fixture(
      [{ id: "a", label: "api" }, { id: "b", label: "web" }, { id: "c", label: "shell-only" }, { id: "d", label: "never" }],
      [
        { id: "a1", ws: "a", tab: "a:t1", at: min(30) },
        { id: "b1", ws: "b", tab: "b:t1", at: min(5), status: "working" },
        { id: "b2", ws: "b", tab: "b:t2", at: min(90) },
        { id: "b3", ws: "b", tab: "b:t3" },
        { id: "c1", ws: "c", tab: "c:t1", agent: null },
        { id: "d1", ws: "d", tab: "d:t1" },
      ],
    );
    expect(ids(radarGroups(snapshot, NOW))).toEqual([["b", ["b1", "b2", "b3"], []], ["a", ["a1"], []], ["d", ["d1"], []]]);
    const b = radarGroups(snapshot, NOW)[0]!;
    expect(b.rows.map((r) => r.state)).toEqual(["working", "idle", "idle"]);
    expect(b.rows.every((r) => !r.splitChild)).toBe(true);
  });

  it("keeps a worktree family together, parent first, and a busy child sinks with a dormant parent", () => {
    const snapshot = fixture(
      [
        { id: "repo", label: "repo", worktree: { repo_key: "k", repo_name: "repo", linked: false } },
        { id: "other", label: "other" },
        { id: "wt", label: "feature/x", worktree: { repo_key: "k", repo_name: "repo", linked: true } },
      ],
      [
        { id: "r1", ws: "repo", tab: "repo:t1", at: min(200) },
        { id: "o1", ws: "other", tab: "other:t1", at: min(60) },
        { id: "w1", ws: "wt", tab: "wt:t1", at: min(1), status: "working" },
      ],
    );
    // the family's best member (w1, 1 min) ranks the family above `other` (60 min)
    expect(ids(radarGroups(snapshot, NOW))).toEqual([["repo", ["r1"], [["wt", ["w1"]]]], ["other", ["o1"], []]]);
    expect(radarGroups(snapshot, NOW)[0]!.children[0]!.orphanRepo).toBeNull();
  });

  it("makes a linked worktree an orphan when its main checkout is closed or holds only shells", () => {
    const closed = fixture(
      [{ id: "wt", label: "feature/x", worktree: { repo_key: "k", repo_name: "repo", linked: true } }],
      [{ id: "w1", ws: "wt", tab: "wt:t1", at: min(1) }],
    );
    expect(radarGroups(closed, NOW).map((g) => [g.workspace.workspace_id, g.orphanRepo])).toEqual([["wt", "repo"]]);
    const shells = fixture(
      [
        { id: "repo", label: "repo", worktree: { repo_key: "k", repo_name: "repo", linked: false } },
        { id: "wt", label: "feature/x", worktree: { repo_key: "k", repo_name: "repo", linked: true } },
      ],
      [{ id: "r1", ws: "repo", tab: "repo:t1", agent: null }, { id: "w1", ws: "wt", tab: "wt:t1", at: min(1) }],
    );
    expect(radarGroups(shells, NOW).map((g) => [g.workspace.workspace_id, g.orphanRepo, g.children.length])).toEqual([["wt", "repo", 0]]);
  });

  it("keeps a split's panes adjacent with the layout head first, even unstamped, and never between another unit's rows", () => {
    const snapshot = fixture(
      [{ id: "a", label: "api" }],
      [
        { id: "head", ws: "a", tab: "a:t1" },
        { id: "lone", ws: "a", tab: "a:t2", at: min(10) },
        { id: "child-new", ws: "a", tab: "a:t1", at: min(2) },
        { id: "child-old", ws: "a", tab: "a:t1", at: min(50) },
        { id: "child-none", ws: "a", tab: "a:t1" },
      ],
    );
    const [group] = radarGroups(snapshot, NOW);
    expect(group!.rows.map((r) => [r.pane.pane_id, r.splitChild])).toEqual([["head", false], ["child-new", true], ["child-old", true], ["child-none", true], ["lone", false]]);
  });

  it("ranks wholly unstamped units last and marks a group stale only when every row is", () => {
    const snapshot = fixture(
      [{ id: "a", label: "api" }, { id: "s", label: "sleepy" }],
      [
        { id: "u1", ws: "a", tab: "a:t1" },
        { id: "u2", ws: "a", tab: "a:t1" },
        { id: "l1", ws: "a", tab: "a:t2", at: min(500) },
        { id: "s1", ws: "s", tab: "s:t1", at: min(300) },
        { id: "s2", ws: "s", tab: "s:t2", at: min(400) },
      ],
    );
    const groups = radarGroups(snapshot, NOW);
    expect(ids(groups)).toEqual([["s", ["s1", "s2"], []], ["a", ["l1", "u1", "u2"], []]]);
    expect(groups.map((g) => g.stale)).toEqual([true, false]);
  });
});

describe("radarRecent and radarPaneOrder", () => {
  it("flattens every agent pane by recency, unstamped last, with no split adjacency", () => {
    const snapshot = fixture(
      [{ id: "a", label: "api" }, { id: "b", label: "web" }],
      [
        { id: "head", ws: "a", tab: "a:t1", at: min(1) },
        { id: "child", ws: "a", tab: "a:t1", at: min(30) },
        { id: "b1", ws: "b", tab: "b:t1", at: min(10) },
        { id: "none", ws: "b", tab: "b:t2" },
        { id: "shell", ws: "b", tab: "b:t3", agent: null },
      ],
    );
    const rows = radarRecent(snapshot, NOW);
    expect(rows.map((r) => r.pane.pane_id)).toEqual(["head", "b1", "child", "none"]);
    expect(rows.every((r) => !r.splitChild)).toBe(true);
    expect(radarPaneOrder(snapshot, "recent", NOW)).toEqual(["head", "b1", "child", "none"]);
    expect(radarPaneOrder(snapshot, "active", NOW)).toEqual(["head", "child", "b1", "none"]);
  });

  it("lists a family's panes parent first then children in the active order", () => {
    const snapshot = fixture(
      [
        { id: "repo", label: "repo", worktree: { repo_key: "k", repo_name: "repo", linked: false } },
        { id: "wt", label: "feature/x", worktree: { repo_key: "k", repo_name: "repo", linked: true } },
      ],
      [{ id: "r1", ws: "repo", tab: "repo:t1", at: min(100) }, { id: "w1", ws: "wt", tab: "wt:t1", at: min(1) }],
    );
    expect(radarPaneOrder(snapshot, "active", NOW)).toEqual(["r1", "w1"]);
    expect(radarPaneOrder(snapshot, "recent", NOW)).toEqual(["w1", "r1"]);
  });
});
