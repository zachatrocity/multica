import type { Workspace } from "@multica/core/types";
import type { PendingNotificationDestination } from "./notification-destination";

export type NotificationIssueNotice = "comment_unavailable" | "offline";
export type NotificationRecoveryReason =
  | "workspace_unavailable"
  | "issue_unavailable"
  | "offline"
  | "temporary_error";

export type NotificationResolution =
  | { kind: "login" }
  | {
      kind: "issue";
      workspace: Workspace;
      issueId: string;
      commentId?: string;
      nonce: string;
      pendingKey: string;
      notice?: NotificationIssueNotice;
    }
  | {
      kind: "inbox";
      workspace: Workspace;
      pendingKey: string;
    }
  | {
      kind: "recovery";
      reason: NotificationRecoveryReason;
      workspace?: Workspace;
      pendingKey: string;
    };

export interface NotificationTimelineEntry {
  id: string;
  type: string;
  deleted_at?: string | null;
}

export interface NotificationResolverDependencies {
  authenticated: boolean;
  online: boolean;
  listWorkspaces: () => Promise<Workspace[]>;
  getCachedWorkspaces: () => Workspace[] | undefined;
  activateWorkspace: (workspace: Workspace) => Promise<void>;
  loadIssue: (workspaceId: string, issueId: string) => Promise<void>;
  hasCachedIssue: (workspaceId: string, issueId: string) => boolean;
  loadTimeline: (
    workspaceId: string,
    issueId: string,
  ) => Promise<NotificationTimelineEntry[]>;
  getCachedTimeline: (
    workspaceId: string,
    issueId: string,
  ) => NotificationTimelineEntry[] | undefined;
  isUnavailableError: (error: unknown) => boolean;
  isOfflineError: (error: unknown) => boolean;
}

function liveCommentExists(
  entries: NotificationTimelineEntry[] | undefined,
  commentId: string,
): boolean {
  return (
    entries?.some(
      (entry) =>
        entry.type === "comment" &&
        entry.id === commentId &&
        entry.deleted_at == null,
    ) ?? false
  );
}

/**
 * Resolves only stable identifiers and always matches workspace membership by
 * id. The payload slug is a routing hint, never authorization. Network-backed
 * checks run before navigation; cached content is admitted only while the
 * device is known offline and is surfaced as offline content.
 */
export async function resolveNotificationDestination(
  pending: PendingNotificationDestination,
  dependencies: NotificationResolverDependencies,
): Promise<NotificationResolution> {
  if (!dependencies.authenticated) return { kind: "login" };

  const workspaceId =
    pending.target.kind === "issue"
      ? pending.target.destination.workspace_id
      : pending.target.workspace.workspaceId;

  let workspaces: Workspace[] | undefined;
  let membershipOffline = !dependencies.online;
  if (dependencies.online) {
    try {
      workspaces = await dependencies.listWorkspaces();
    } catch (error) {
      if (!dependencies.isOfflineError(error)) {
        return {
          kind: "recovery",
          reason: "temporary_error",
          pendingKey: pending.key,
        };
      }
      membershipOffline = true;
    }
  }
  workspaces ??= dependencies.getCachedWorkspaces();

  const workspace = workspaces?.find((candidate) => candidate.id === workspaceId);
  if (!workspace) {
    return {
      kind: "recovery",
      reason: membershipOffline ? "offline" : "workspace_unavailable",
      pendingKey: pending.key,
    };
  }

  await dependencies.activateWorkspace(workspace);

  if (pending.target.kind === "workspace_inbox") {
    return { kind: "inbox", workspace, pendingKey: pending.key };
  }

  const { destination } = pending.target;
  let openedFromCache = false;
  if (dependencies.online) {
    try {
      await dependencies.loadIssue(workspace.id, destination.issue_id);
    } catch (error) {
      if (dependencies.isUnavailableError(error)) {
        return {
          kind: "recovery",
          reason: "issue_unavailable",
          workspace,
          pendingKey: pending.key,
        };
      }
      if (
        !dependencies.isOfflineError(error) ||
        !dependencies.hasCachedIssue(workspace.id, destination.issue_id)
      ) {
        return {
          kind: "recovery",
          reason: dependencies.isOfflineError(error)
            ? "offline"
            : "temporary_error",
          workspace,
          pendingKey: pending.key,
        };
      }
      openedFromCache = true;
    }
  } else if (dependencies.hasCachedIssue(workspace.id, destination.issue_id)) {
    openedFromCache = true;
  } else {
    return {
      kind: "recovery",
      reason: "offline",
      workspace,
      pendingKey: pending.key,
    };
  }

  let commentId = destination.comment_id;
  let notice: NotificationIssueNotice | undefined = openedFromCache
    ? "offline"
    : undefined;

  if (commentId) {
    let entries: NotificationTimelineEntry[] | undefined;
    if (dependencies.online && !openedFromCache) {
      try {
        entries = await dependencies.loadTimeline(
          workspace.id,
          destination.issue_id,
        );
      } catch (error) {
        if (!dependencies.isOfflineError(error)) {
          return {
            kind: "recovery",
            reason: "temporary_error",
            workspace,
            pendingKey: pending.key,
          };
        }
        entries = dependencies.getCachedTimeline(
          workspace.id,
          destination.issue_id,
        );
        notice = "offline";
      }
    } else {
      entries = dependencies.getCachedTimeline(
        workspace.id,
        destination.issue_id,
      );
    }

    if (!liveCommentExists(entries, commentId)) {
      commentId = undefined;
      if (notice !== "offline") notice = "comment_unavailable";
    }
  }

  return {
    kind: "issue",
    workspace,
    issueId: destination.issue_id,
    commentId,
    nonce: pending.nonce,
    pendingKey: pending.key,
    notice,
  };
}
