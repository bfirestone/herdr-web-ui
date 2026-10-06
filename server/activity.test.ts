import { describe, expect, it } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ACTIVITY_WRITE_INTERVAL_MS, ActivityTracker } from "./activity.ts";

function clock(start = 1_000_000) {
  let now = start;
  return { now: () => now, tick: (ms: number) => { now += ms; } };
}

describe("ActivityTracker", () => {
  it("stamps a pane when its settled status is working, and only then", () => {
    const c = clock();
    const tracker = new ActivityTracker(null, () => "1:1", c.now);
    expect(tracker.observe("p", "idle")).toBe(false);
    expect(tracker.at("p")).toBeNull();
    expect(tracker.observe("p", "working")).toBe(true);
    expect(tracker.at("p")).toBe(c.now());
    c.tick(5);
    expect(tracker.observe("p", "blocked")).toBe(false);
    expect(tracker.observe("p", "done")).toBe(false);
    expect(tracker.at("p")).toBe(c.now() - 5);
    expect(tracker.apply([{ pane_id: "p" }, { pane_id: "q" }])).toEqual([{ pane_id: "p", last_working_at: c.now() - 5 }, { pane_id: "q" }]);
  });

  it("stamps a working pane the first snapshot shows, before any event said so", () => {
    const c = clock();
    const tracker = new ActivityTracker(null, () => "1:1", c.now);
    const revision = tracker.begin();
    tracker.reconcile([{ pane_id: "p", agent_status: "working" }, { pane_id: "q", agent_status: "idle" }], revision);
    expect(tracker.at("p")).toBe(c.now());
    expect(tracker.at("q")).toBeNull();
    // a stamp already known is not moved by a later snapshot
    c.tick(60_000);
    tracker.reconcile([{ pane_id: "p", agent_status: "working" }], tracker.begin());
    expect(tracker.at("p")).toBe(c.now() - 60_000);
  });

  it("keeps a stamp an older snapshot never saw, and never recreates one after the pane ended", () => {
    const c = clock();
    const tracker = new ActivityTracker(null, () => "1:1", c.now);
    // a snapshot is requested, then a pane appears and works, then the snapshot (without it) lands
    const older = tracker.begin();
    tracker.observe("new", "working");
    tracker.reconcile([{ pane_id: "other", agent_status: "idle" }], older);
    expect(tracker.at("new")).toBe(c.now());
    // a snapshot is requested showing a pane working, the pane ends, then the snapshot lands
    tracker.observe("gone", "working");
    const stale = tracker.begin();
    tracker.drop("gone");
    tracker.reconcile([{ pane_id: "gone", agent_status: "working" }], stale);
    expect(tracker.at("gone")).toBeNull();
    // a pane missing from a current snapshot is forgotten
    tracker.reconcile([{ pane_id: "other", agent_status: "idle" }], tracker.begin());
    expect(tracker.at("new")).toBeNull();
  });

  it("coalesces writes to one per interval, writes the trailing change, and flushes on stop", () => {
    const dir = mkdtempSync(join(tmpdir(), "herdr-activity-"));
    const file = join(dir, "activity.json");
    try {
      const c = clock();
      const tracker = new ActivityTracker(file, () => "1:1", c.now);
      tracker.observe("p", "working");
      expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({ herdr: "1:1", panes: { p: c.now() } });
      c.tick(1000);
      tracker.observe("q", "working");
      // inside the interval: not on disk yet, a trailing write is scheduled
      expect(JSON.parse(readFileSync(file, "utf8")).panes).toEqual({ p: c.now() - 1000 });
      tracker.stop();
      expect(JSON.parse(readFileSync(file, "utf8")).panes).toEqual({ p: c.now() - 1000, q: c.now() });
      // a new tracker against the same herdr loads them; another herdr starts clean
      expect(new ActivityTracker(file, () => "1:1", c.now).at("q")).toBe(c.now());
      expect(new ActivityTracker(file, () => "2:2", c.now).at("q")).toBeNull();
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it("forgets every stamp when herdr restarts under a running server, and ignores a snapshot from the old herdr", () => {
    let identity = "1:1";
    const c = clock();
    const tracker = new ActivityTracker(null, () => identity, c.now);
    tracker.observe("p", "working");
    const fromOldHerdr = tracker.begin();
    identity = "2:2";
    expect(tracker.at("p")).toBeNull();
    tracker.reconcile([{ pane_id: "p", agent_status: "working" }], fromOldHerdr);
    expect(tracker.at("p")).toBeNull();
    tracker.reconcile([{ pane_id: "p", agent_status: "working" }], tracker.begin());
    expect(tracker.at("p")).toBe(c.now());
  });

  it("writes no file without a herdr identity", () => {
    const dir = mkdtempSync(join(tmpdir(), "herdr-activity-"));
    const file = join(dir, "activity.json");
    try {
      const tracker = new ActivityTracker(file, () => null, () => 1);
      tracker.observe("p", "working");
      tracker.stop();
      expect(existsSync(file)).toBe(false);
      expect(ACTIVITY_WRITE_INTERVAL_MS).toBe(5000);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});
