import { useCallback, useEffect, useState, type ReactNode } from "react";
import { FolderOpen, GitBranch, Pencil, Plus, Trash2, X } from "lucide-react";

import type { PaneInfo, SessionSnapshot, WorkspaceInfo } from "../../shared/protocol.ts";
import { useMachineApi, useMachineId } from "../lib/machineContext.tsx";
import type { AppActions } from "../lib/actions.ts";
import { focusWorkspaceListToggle } from "../lib/focus.ts";
import { useT } from "../lib/i18n.ts";
import { ConfirmDialog } from "./ConfirmDialog.tsx";
import { RowMenu, type RowMenuItem } from "./RowMenu.tsx";
import { WorktreeDialog, type WorktreeDialogMode } from "./WorktreeDialog.tsx";

/** The row whose ⋯ menu is open: a workspace, seen through the pane its row shows. */
interface MenuState { anchor: HTMLElement; workspace: WorkspaceInfo; pane: PaneInfo; scope: string; title: string; place: string }
interface ConfirmState { title: string; body: string; action?: string; run: () => Promise<void>; escalation?: { label: string; code: string; run: () => Promise<void> } }

export interface WorkspaceMenuOptions {
  snapshot: SessionSnapshot | null;
  actions: AppActions;
  /** the pane a workspace action targets once the menu's own pane has closed: the layout's precedence (selected, last viewed, in front) */
  resolveCurrentPane: (workspace: WorkspaceInfo, panes: PaneInfo[]) => PaneInfo;
  onRenameWorkspace: (workspace: WorkspaceInfo, scope: string) => void;
  onRenamePane: (pane: PaneInfo) => void;
  onError: (message: string, workspaceId?: string) => void;
}

export interface WorkspaceMenu {
  /** open the menu for a row; `scope` tells two rows of one workspace apart (the folder layout lists one workspace under several folders) */
  open: (anchor: HTMLElement, workspace: WorkspaceInfo, pane: PaneInfo, scope: string, title: string, place: string) => void;
  close: () => void;
  isOpen: (workspaceId: string, scope: string) => boolean;
  /** the RowMenu, ConfirmDialog and WorktreeDialog, rendered once by the layout */
  element: ReactNode;
}

/**
 * herdr's own actions on a workspace row: rename, a new tab (prefix+c), its worktrees (prefix+shift+g),
 * close, and a worktree checkout's deletion. One hook for every sidebar layout, so the items, their
 * confirmations and the dialogs stay the same whichever layout drew the row.
 */
export function useWorkspaceMenu({ snapshot, actions, resolveCurrentPane, onRenameWorkspace, onRenamePane, onError }: WorkspaceMenuOptions): WorkspaceMenu {
  const t = useT();
  const machineId = useMachineId();
  const { closePane, closeWorkspace, removeWorktree } = useMachineApi();
  const [menu, setMenu] = useState<MenuState | null>(null);
  const [confirm, setConfirm] = useState<ConfirmState | null>(null);
  const [worktreeDialog, setWorktreeDialog] = useState<{ mode: WorktreeDialogMode; workspace: WorkspaceInfo } | null>(null);
  // no menu item reports an error yet; the option is part of the shared contract
  void onError;

  const close = useCallback(() => setMenu(null), []);

  // A close takes the workspace with it, so it asks first, as herdr's ui.confirm_close does.
  // The row is gone afterwards, so focus moves to the header's workspace-list toggle.
  const leave = async (run: () => Promise<void>): Promise<void> => {
    await run();
    setConfirm(null);
    focusWorkspaceListToggle();
  };

  const menuItems = (state: MenuState): RowMenuItem[] => {
    // the roster may have moved on since the menu opened (a pane closed from another client):
    // what an item does follows the latest snapshot, not what the row showed at the click
    const workspace = snapshot?.workspaces.find((candidate) => candidate.workspace_id === state.workspace.workspace_id) ?? state.workspace;
    const panes = snapshot?.panes.filter((pane) => pane.workspace_id === workspace.workspace_id) ?? [];
    const paneCount = Math.max(1, panes.length);
    // the pane the row showed may have closed under the open menu: the items then act on the
    // pane the row shows now, never on an id herdr no longer has
    const pane = panes.find((candidate) => candidate.pane_id === state.pane.pane_id) ?? (panes.length > 0 ? resolveCurrentPane(workspace, panes) : state.pane);
    // a worktree workspace: its checkout can be deleted; the repository's workspace: its open
    // worktree workspaces close with it, which herdr refuses without close_group
    const linked = workspace.worktree?.is_linked_worktree === true;
    const worktrees = linked ? [] : (snapshot?.workspaces.filter((candidate) => candidate.worktree?.is_linked_worktree && candidate.worktree.repo_key === workspace.worktree?.repo_key) ?? []);
    // herdr's own actions on a workspace: rename, a new tab (prefix+c), its worktrees (prefix+shift+g), close
    const items: RowMenuItem[] = [
      { id: "rename-workspace", label: t("Rename workspace"), icon: Pencil, run: () => onRenameWorkspace(workspace, state.scope) },
      { id: "rename-pane", label: t("Rename pane"), icon: Pencil, run: () => onRenamePane(pane) },
      { id: "new-tab", label: t("New tab"), icon: Plus, run: () => actions.openNewTab({ machineId, workspaceId: workspace.workspace_id }) },
      ...(linked ? [] : [
        { id: "new-worktree", label: t("New worktree"), icon: GitBranch, run: () => setWorktreeDialog({ mode: "create", workspace }) },
        { id: "open-worktree", label: t("Open worktree…"), icon: FolderOpen, run: () => setWorktreeDialog({ mode: "open", workspace }) },
      ] satisfies RowMenuItem[]),
    ];
    const deleteItems: RowMenuItem[] = linked ? [{
      id: "delete-worktree", label: t("Delete worktree checkout…"), icon: Trash2, danger: true,
      run: () => setConfirm({
        title: t("Delete the checkout of {name}?", { name: workspace.label }),
        body: t("The folder at {path} is deleted and the workspace closes. The branch stays.", { path: workspace.worktree?.checkout_path ?? "" }),
        action: t("Delete"),
        run: () => leave(async () => { await removeWorktree({ workspace_id: workspace.workspace_id }); }),
        // git refuses a checkout with unsaved changes: the refusal shows, and the action becomes a forced one
        escalation: { label: t("Delete anyway"), code: "dirty_worktree_requires_force", run: () => leave(async () => { await removeWorktree({ workspace_id: workspace.workspace_id, force: true }); }) },
      }),
    }] : [];
    // a lone pane takes its workspace with it; a row with several panes closes them all; a
    // repository's open worktree workspaces go with either
    const closeItem: RowMenuItem = paneCount === 1
      ? { id: "close", label: t("Close"), icon: X, danger: true, divider: true, run: () => setConfirm({
          title: t("Close {title}?", { title: state.title }),
          body: worktrees.length > 0 ? t("Its workspace and its {m} worktree workspaces close with it; the agents in them stop, and the checkouts stay.", { m: worktrees.length }) : t("Its workspace closes with it, and the agent and shell in it stop."),
          run: () => leave(() => worktrees.length > 0 ? closeWorkspace(workspace.workspace_id, true) : closePane(pane.pane_id)),
        }) }
      : { id: "close", label: t("Close workspace"), icon: X, danger: true, divider: true, run: () => setConfirm({
          title: t("Close workspace {name}?", { name: workspace.label }),
          body: worktrees.length > 0 ? t("{n} panes and {m} worktree workspaces close with it; the agents in them stop, and the checkouts stay.", { n: paneCount, m: worktrees.length }) : t("{n} panes close with it, and the agents in them stop.", { n: paneCount }),
          run: () => leave(() => closeWorkspace(workspace.workspace_id, worktrees.length > 0)),
        }) };
    return [...items, closeItem, ...deleteItems];
  };

  // the roster moves under an open menu: a row that left takes its menu with it, and focus
  // goes where a closed row's focus goes
  useEffect(() => {
    if (!menu) return;
    const alive = snapshot?.workspaces.some((workspace) => workspace.workspace_id === menu.workspace.workspace_id);
    if (alive && menu.anchor.isConnected) return;
    setMenu(null);
    focusWorkspaceListToggle();
  });

  const element = <>
    {menu && <RowMenu anchor={menu.anchor} title={menu.title} subtitle={menu.place} items={menuItems(menu)} onClose={close} />}
    {confirm && <ConfirmDialog title={confirm.title} body={confirm.body} confirmLabel={confirm.action ?? t("Close")} onConfirm={confirm.run} escalation={confirm.escalation} onClose={() => setConfirm(null)} />}
    {worktreeDialog && <WorktreeDialog mode={worktreeDialog.mode} workspace={worktreeDialog.workspace} onClose={() => setWorktreeDialog(null)} onOpened={(opened) => { setWorktreeDialog(null); actions.selectPane(opened.pane_id); }} />}
  </>;

  return {
    open: (anchor, workspace, pane, scope, title, place) => setMenu({ anchor, workspace, pane, scope, title, place }),
    close,
    isOpen: (workspaceId, scope) => menu?.workspace.workspace_id === workspaceId && menu.scope === scope,
    element,
  };
}
