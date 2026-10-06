import { describe, expect, it } from "bun:test";
import type { HerdrPane } from "../../shared/protocol.ts";
import { FRESH_MS, STALE_MS, type RadarOrder, type RadarRow, type RadarState } from "./radar.ts";

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
