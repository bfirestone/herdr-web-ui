import type { AgentStatus, HerdrPane, SessionSnapshot } from "../../shared/protocol.ts";

/**
 * Merges a pushed `pane-status` into the last snapshot so the sidebar badge updates
 * instantly; the debounced /api/session refetch that follows brings the derived
 * workspace/tab rollups back in line. Pure: returns the same object when nothing changed.
 */
export function applyPaneStatus(snapshot: SessionSnapshot, paneId: string, status: AgentStatus, background?: number, lastWorkingAt?: number): SessionSnapshot {
  let paneChanged = false;
  const panes = snapshot.panes.map((pane: HerdrPane) => {
    // a frame that says nothing of background tasks leaves the count as it was; same for the stamp
    const tasks = background === undefined ? pane.background_tasks : background > 0 ? background : undefined;
    const stamp = lastWorkingAt ?? pane.last_working_at;
    if (pane.pane_id !== paneId || (pane.agent_status === status && pane.background_tasks === tasks && pane.last_working_at === stamp)) return pane;
    paneChanged = true;
    const { background_tasks: _before, last_working_at: _stamp, ...rest } = pane;
    return { ...rest, agent_status: status, ...(tasks === undefined ? {} : { background_tasks: tasks }), ...(stamp === undefined ? {} : { last_working_at: stamp }) };
  });
  if (!paneChanged) return snapshot;
  const agents = snapshot.agents.map((agent) =>
    agent.pane_id === paneId && agent.agent_status !== status ? { ...agent, agent_status: status } : agent,
  );
  return { ...snapshot, panes, agents };
}
