import { describe, expect, it } from "bun:test";
import type { AgentStatus, HerdrPane, SessionSnapshot } from "../../shared/protocol.ts";
import { applyPaneStatus } from "./snapshot.ts";

function snapshotFixture(): SessionSnapshot {
  return {
    protocol: 22,
    version: "test",
    workspaces: [],
    tabs: [],
    layouts: [],
    panes: [
      { pane_id: "w1:p1", workspace_id: "w1", tab_id: "w1:t1", terminal_id: "t1", revision: 1, focused: true, agent_status: "working" },
      { pane_id: "w1:p2", workspace_id: "w1", tab_id: "w1:t1", terminal_id: "t2", revision: 1, focused: false, agent_status: "idle" },
    ],
    agents: [
      { pane_id: "w1:p1", workspace_id: "w1", tab_id: "w1:t1", terminal_id: "t1", revision: 1, focused: true, agent_status: "working" },
    ],
  } as unknown as SessionSnapshot;
}

describe("applyPaneStatus", () => {
  it("updates the pane and its agent entry to the pushed status", () => {
    const current = snapshotFixture();
    const next = applyPaneStatus(current, "w1:p1", "blocked" as AgentStatus);
    expect(next.panes.find((pane) => pane.pane_id === "w1:p1")?.agent_status).toBe("blocked");
    expect(next.agents.find((agent) => agent.pane_id === "w1:p1")?.agent_status).toBe("blocked");
    // untouched panes keep their object identity: React re-renders only what changed
    expect(next.panes.find((pane) => pane.pane_id === "w1:p2")).toBe(current.panes[1]);
  });

  it("carries a pane's background task count, and leaves it alone when a frame says nothing of it", () => {
    const current = snapshotFixture();
    const counted = applyPaneStatus(current, "w1:p1", "working", 2);
    expect(counted.panes.find((pane) => pane.pane_id === "w1:p1")).toMatchObject({ agent_status: "working", background_tasks: 2 });
    // a frame of another source (herdr's own status event) has no count: the one known stays
    const done = applyPaneStatus(counted, "w1:p1", "done" as AgentStatus);
    expect(done.panes.find((pane) => pane.pane_id === "w1:p1")).toMatchObject({ agent_status: "done", background_tasks: 2 });
    expect(applyPaneStatus(done, "w1:p1", "done" as AgentStatus, 2)).toBe(done);
    // none left: the field goes, so the badge does
    const none = applyPaneStatus(done, "w1:p1", "done" as AgentStatus, 0);
    expect("background_tasks" in none.panes.find((pane) => pane.pane_id === "w1:p1")!).toBe(false);
  });

  it("returns the same snapshot object when the status already matches", () => {
    const current = snapshotFixture();
    expect(applyPaneStatus(current, "w1:p1", "working")).toBe(current);
  });

  it("returns the same snapshot object when the pane is unknown", () => {
    const current = snapshotFixture();
    expect(applyPaneStatus(current, "w9:p9", "done" as AgentStatus)).toBe(current);
  });

  it("carries a pane's last_working_at, keeps the one known when a frame has none, and re-renders on a moved stamp alone", () => {
    const current = snapshotFixture();
    const stamped = applyPaneStatus(current, "w1:p1", "working", undefined, 1000);
    expect(stamped.panes.find((pane) => pane.pane_id === "w1:p1")).toMatchObject({ agent_status: "working", last_working_at: 1000 });
    const same = applyPaneStatus(stamped, "w1:p1", "working");
    expect(same).toBe(stamped);
    const moved = applyPaneStatus(stamped, "w1:p1", "working", undefined, 2000);
    expect(moved).not.toBe(stamped);
    expect(moved.panes.find((pane) => pane.pane_id === "w1:p1")).toMatchObject({ last_working_at: 2000 });
  });

  // --- Contract assertions ---
  it("holds the shared wire contract", () => {
    const pane: HerdrPane = { ...snapshotFixture().panes[0]!, last_working_at: 0 };
    void pane;
  });
});
