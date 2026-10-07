import { useEffect, useMemo, useState } from "react";
import { Ellipsis, GitBranch, Pencil, X } from "lucide-react";

import "./RadarSidebar.css";

import type { PaneInfo, SessionSnapshot, WorkspaceInfo } from "../../shared/protocol.ts";
import { paneTitle } from "../../shared/notify-policy.ts";
import type { AppActions } from "../lib/actions.ts";
import { useT } from "../lib/i18n.ts";
import { useMachineApi } from "../lib/machineContext.tsx";
import { radarGroups, radarRecent, type RadarGroup, type RadarRow, type RadarState } from "../lib/radar.ts";
import { useSettings } from "../lib/settings.ts";
import { knownStatus, STATUS_WORD } from "../lib/status.ts";
import { customTabLabel } from "../lib/tabName.ts";
import { AgentMark } from "./AgentMark.tsx";
import { RowMenu, type RowMenuItem } from "./RowMenu.tsx";
import { displayPaneTitle } from "./Sidebar.tsx";
import { useWorkspaceMenu } from "./useWorkspaceMenu.tsx";

/** the tiers re-derive on this beat; crossings are minute-grained, so a minute is enough */
const TICK_MS = 60_000;

/** the glyph in front of the title: shape carries the state, so the row reads without colour */
const MARK: Readonly<Record<RadarState, string>> = {
  working: "◠",
  blocked: "?",
  done: "✓",
  idle_fresh: "·",
  idle: "·",
  idle_stale: "·",
  unknown: "◌",
};

export interface RadarSidebarProps {
  snapshot: SessionSnapshot | null;
  selectedPaneId: string | null;
  actions: AppActions;
}

/**
 * herdr-radar's Agents panel, in the browser: one row per agent pane under its workspace, worktrees
 * as a tree, a split's panes together, everything by activity (lib/radar.ts). The order control
 * is drawn once above the PC list (MachineSidebar), not here.
 */
export function RadarSidebar({ snapshot, selectedPaneId, actions }: RadarSidebarProps) {
  const t = useT();
  const { settings } = useSettings();
  const { closePane, renamePane, renameWorkspace } = useMachineApi();
  const [now, setNow] = useState(() => Date.now());
  const [rowMenu, setRowMenu] = useState<{ anchor: HTMLElement; pane: PaneInfo; title: string } | null>(null);
  const [editingPaneId, setEditingPaneId] = useState<string | null>(null);
  const [paneLabel, setPaneLabel] = useState("");
  const [editingWorkspaceId, setEditingWorkspaceId] = useState<string | null>(null);
  const [workspaceLabel, setWorkspaceLabel] = useState("");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), TICK_MS);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    if (error === null) return;
    const timer = window.setTimeout(() => setError(null), 5000);
    return () => window.clearTimeout(timer);
  }, [error]);

  const groups = useMemo(() => (snapshot && settings.radarOrder === "active" ? radarGroups(snapshot, now) : []), [snapshot, settings.radarOrder, now]);
  const flat = useMemo(() => (snapshot && settings.radarOrder === "recent" ? radarRecent(snapshot, now) : []), [snapshot, settings.radarOrder, now]);
  const tabs = useMemo(() => new Map((snapshot?.tabs ?? []).map((tab) => [tab.tab_id, tab])), [snapshot?.tabs]);
  const workspaces = useMemo(() => new Map((snapshot?.workspaces ?? []).map((workspace) => [workspace.workspace_id, workspace])), [snapshot?.workspaces]);

  const noteError = (message: string): void => setError(message);
  const beginPaneRename = (pane: PaneInfo): void => { setEditingPaneId(pane.pane_id); setPaneLabel(pane.label ?? ""); };
  const beginWorkspaceRename = (workspace: WorkspaceInfo): void => { setEditingWorkspaceId(workspace.workspace_id); setWorkspaceLabel(workspace.label); };
  const savePaneRename = (pane: PaneInfo): void => {
    const label = paneLabel.trim();
    setEditingPaneId(null);
    void renamePane(pane.pane_id, label).catch((reason: unknown) => noteError(t("Rename failed: {reason}", { reason: reason instanceof Error ? reason.message : String(reason) })));
  };
  const saveWorkspaceRename = (workspaceId: string): void => {
    const label = workspaceLabel.trim();
    setEditingWorkspaceId(null);
    void renameWorkspace(workspaceId, label).catch((reason: unknown) => noteError(t("Rename failed: {reason}", { reason: reason instanceof Error ? reason.message : String(reason) })));
  };

  // a workspace action from a header targets the selected pane in it, else the pane herdr has in front, else the first
  const resolveCurrentPane = (workspace: WorkspaceInfo, panes: PaneInfo[]): PaneInfo =>
    panes.find((pane) => pane.pane_id === selectedPaneId)
    ?? panes.find((pane) => pane.pane_id === snapshot?.layouts?.find((layout) => layout.tab_id === workspace.active_tab_id)?.focused_pane_id)
    ?? panes.find((pane) => pane.focused)
    ?? panes[0]!;

  const workspaceMenu = useWorkspaceMenu({
    snapshot,
    actions,
    resolveCurrentPane,
    onRenameWorkspace: (workspace) => beginWorkspaceRename(workspace),
    onRenamePane: beginPaneRename,
    onError: noteError,
  });

  /** the title a row shows: never a repeat of its header; then the tab's name, then the agent's */
  const rowLabel = (row: RadarRow, workspace: WorkspaceInfo | undefined): string => {
    const title = displayPaneTitle(row.pane);
    if (!workspace || title !== workspace.label) return title;
    const tab = tabs.get(row.pane.tab_id);
    return (tab && customTabLabel(tab)) || row.pane.agent || title;
  };

  /** line two: in active, the tab's name when given and not already the title; in recent, the workspace, then the tab */
  const rowPlace = (row: RadarRow, workspace: WorkspaceInfo | undefined, label: string): string => {
    const tab = tabs.get(row.pane.tab_id);
    const tabName = tab ? customTabLabel(tab) : null;
    const parts = settings.radarOrder === "recent" ? [workspace?.label ?? null, tabName] : [tabName];
    return parts.filter((part): part is string => part !== null && part !== label).join(" · ");
  };

  /** a row's own menu: the pane, not its workspace (the header's ⋯ has the workspace items) */
  const paneMenuItems = (pane: PaneInfo): RowMenuItem[] => [
    { id: "rename-pane", label: t("Rename pane"), icon: Pencil, run: () => beginPaneRename(pane) },
    { id: "close-pane", label: t("Close pane"), icon: X, danger: true, divider: true, run: () => {
      void closePane(pane.pane_id).catch((reason: unknown) => noteError(t("Close failed: {reason}", { reason: reason instanceof Error ? reason.message : String(reason) })));
    } },
  ];

  const renderRow = (row: RadarRow) => {
    const workspace = workspaces.get(row.pane.workspace_id);
    const label = rowLabel(row, workspace);
    const place = rowPlace(row, workspace, label);
    const selected = row.pane.pane_id === selectedPaneId;
    const editing = editingPaneId === row.pane.pane_id;
    const word = t(STATUS_WORD[knownStatus(row.pane.agent_status)]);
    const menuOpen = rowMenu?.pane.pane_id === row.pane.pane_id;
    return (
      <li className={`radar-row pane-item${row.splitChild ? " is-split-child" : ""}${selected ? " is-selected" : ""}`} data-state={row.state} data-pane={row.pane.pane_id} key={row.pane.pane_id}>
        <div className="pane-row">
          <div
            className="pane-select"
            role="button"
            tabIndex={0}
            aria-current={selected ? "true" : undefined}
            title={`${row.pane.pane_id} — ${paneTitle(row.pane)}${row.pane.cwd ? ` — ${row.pane.cwd}` : ""} — ${t("Agent {status}", { status: word })}`}
            onClick={() => actions.selectPane(row.pane.pane_id)}
            onKeyDown={(event) => {
              if (event.key !== "Enter" && event.key !== " ") return;
              event.preventDefault();
              actions.selectPane(row.pane.pane_id);
            }}
          >
            <span className="agent-mark-holder" title={row.pane.agent ?? ""}>
              <AgentMark agent={row.pane.agent ?? ""} size={22} />
            </span>
            <span className="pane-copy">
              <span className="pane-primary">
                <span className="radar-mark" aria-hidden="true">{MARK[row.state]}</span>
                {editing ? (
                  <input
                    className="input pane-rename-input"
                    aria-label={t("Pane name")}
                    autoFocus
                    value={paneLabel}
                    onClick={(event) => event.stopPropagation()}
                    onChange={(event) => setPaneLabel(event.target.value)}
                    onBlur={() => setEditingPaneId(null)}
                    onKeyDown={(event) => {
                      event.stopPropagation();
                      if (event.key === "Enter") savePaneRename(row.pane);
                      if (event.key === "Escape") setEditingPaneId(null);
                    }}
                  />
                ) : (
                  <span className="pane-title">{label}</span>
                )}
              </span>
              {place && <span className="pane-meta"><span className="pane-subtitle">{place}</span></span>}
            </span>
          </div>
          <div className="pane-actions">
            <button type="button" className="sidebar-row-action row-menu-toggle" aria-label={t("More for {title}", { title: label })} aria-haspopup="menu" aria-expanded={menuOpen} onClick={(event) => menuOpen ? setRowMenu(null) : setRowMenu({ anchor: event.currentTarget, pane: row.pane, title: label })}>
              <Ellipsis aria-hidden="true" />
            </button>
          </div>
        </div>
      </li>
    );
  };

  const renderGroup = (group: RadarGroup, child = false) => {
    const { workspace } = group;
    const panes = (snapshot?.panes ?? []).filter((pane) => pane.workspace_id === workspace.workspace_id);
    const editing = editingWorkspaceId === workspace.workspace_id;
    const menuOpen = workspaceMenu.isOpen(workspace.workspace_id, "radar");
    return (
      <li className={`radar-group${group.stale ? " is-stale" : ""}`} key={workspace.workspace_id} data-workspace={workspace.workspace_id}>
        <div className="radar-header">
          {(child || group.orphanRepo !== null) && <GitBranch aria-hidden="true" />}
          {editing ? (
            <input
              className="input pane-rename-input workspace-rename-input"
              aria-label={t("Workspace name")}
              autoFocus
              value={workspaceLabel}
              onChange={(event) => setWorkspaceLabel(event.target.value)}
              onBlur={() => setEditingWorkspaceId(null)}
              onKeyDown={(event) => {
                event.stopPropagation();
                if (event.key === "Enter") saveWorkspaceRename(workspace.workspace_id);
                if (event.key === "Escape") setEditingWorkspaceId(null);
              }}
            />
          ) : (
            <span className="radar-header-name" title={workspace.label}>
              {group.orphanRepo !== null && <span className="radar-header-repo">{group.orphanRepo} › </span>}
              {workspace.label}
            </span>
          )}
          <button type="button" className="sidebar-row-action row-menu-toggle" aria-label={t("More for {title}", { title: workspace.label })} aria-haspopup="menu" aria-expanded={menuOpen} onClick={(event) => menuOpen ? workspaceMenu.close() : workspaceMenu.open(event.currentTarget, workspace, resolveCurrentPane(workspace, panes), "radar", workspace.label, group.orphanRepo ?? "")}>
            <Ellipsis aria-hidden="true" />
          </button>
        </div>
        <ul className="radar-list">{group.rows.map(renderRow)}</ul>
        {group.children.length > 0 && <ul className="radar-list radar-children">{group.children.map((inner) => renderGroup(inner, true))}</ul>}
      </li>
    );
  };

  const empty = snapshot !== null && (settings.radarOrder === "active" ? groups.length === 0 : flat.length === 0);
  return (
    <div className="machine-workspaces">
      <nav className="sidebar-list" aria-label={t("Agents by activity")}>
        {!snapshot && <p className="tree-state" role="status">{t("Loading workspaces…")}</p>}
        {empty && <p className="tree-state" role="status">{t("No agents running")}</p>}
        {settings.radarOrder === "active"
          ? <ul className="radar-list">{groups.map((group) => renderGroup(group))}</ul>
          : <ul className="radar-list">{flat.map(renderRow)}</ul>}
        {error && <p className="sidebar-inline-error" role="alert">{error}</p>}
      </nav>
      {rowMenu && <RowMenu anchor={rowMenu.anchor} title={rowMenu.title} items={paneMenuItems(rowMenu.pane)} onClose={() => setRowMenu(null)} />}
      {workspaceMenu.element}
    </div>
  );
}
