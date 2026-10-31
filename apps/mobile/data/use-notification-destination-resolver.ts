import { useEffect, useRef, useState } from "react";
import { router } from "expo-router";
import { onlineManager, useQueryClient } from "@tanstack/react-query";
import type { Workspace } from "@multica/core/types";
import { api, ApiError } from "@/data/api";
import { useAuthStore } from "@/data/auth-store";
import {
  confirmNotificationDestinationHandled,
  useNotificationDestinationStore,
} from "@/data/notification-destination-store";
import { issueDetailOptions, issueTimelineOptions } from "@/data/queries/issues";
import { workspaceListOptions } from "@/data/queries/workspaces";
import { useWorkspaceStore } from "@/data/workspace-store";
import {
  resolveNotificationDestination,
  type NotificationTimelineEntry,
} from "@/lib/notification-destination-resolver";

function isOfflineError(error: unknown): boolean {
  return (
    (error instanceof ApiError && error.status === 0) ||
    error instanceof TypeError ||
    (error instanceof Error &&
      /network request failed|failed to fetch|network is offline/i.test(
        error.message,
      ))
  );
}

export function NotificationDestinationResolver() {
  const queryClient = useQueryClient();
  const user = useAuthStore((state) => state.user);
  const authLoading = useAuthStore((state) => state.isLoading);
  const hydrated = useNotificationDestinationStore((state) => state.hydrated);
  const pending = useNotificationDestinationStore((state) => state.pending);
  const revision = useNotificationDestinationStore((state) => state.revision);
  const hydrate = useNotificationDestinationStore((state) => state.hydrate);
  const setRecovery = useNotificationDestinationStore(
    (state) => state.setRecovery,
  );
  const processingRef = useRef(false);
  const lastAttemptRef = useRef<string | null>(null);
  const [runnerVersion, setRunnerVersion] = useState(0);

  useEffect(() => {
    void hydrate();
  }, [hydrate]);

  useEffect(() => {
    if (!hydrated || authLoading || !pending || processingRef.current) return;

    const attemptKey = `${pending.key}:${pending.nonce}:${user?.id ?? "signed-out"}`;
    if (lastAttemptRef.current === attemptKey) return;
    processingRef.current = true;

    void (async () => {
      const workspaceOptions = workspaceListOptions();
      const resolution = await resolveNotificationDestination(pending, {
        authenticated: user != null,
        online: onlineManager.isOnline(),
        listWorkspaces: () =>
          queryClient.fetchQuery({
            ...workspaceOptions,
            staleTime: 0,
            retry: false,
          }),
        getCachedWorkspaces: () =>
          queryClient.getQueryData<Workspace[]>(workspaceOptions.queryKey),
        activateWorkspace: (workspace) =>
          useWorkspaceStore
            .getState()
            .setCurrentWorkspace(workspace.id, workspace.slug),
        loadIssue: async (workspaceId, issueId) => {
          await queryClient.fetchQuery({
            ...issueDetailOptions(workspaceId, issueId),
            staleTime: 0,
            retry: false,
          });
        },
        hasCachedIssue: (workspaceId, issueId) =>
          queryClient.getQueryData(
            issueDetailOptions(workspaceId, issueId).queryKey,
          ) != null,
        loadTimeline: (workspaceId, issueId) =>
          queryClient.fetchQuery({
            ...issueTimelineOptions(workspaceId, issueId),
            staleTime: 0,
            retry: false,
          }) as Promise<NotificationTimelineEntry[]>,
        getCachedTimeline: (workspaceId, issueId) =>
          queryClient.getQueryData<NotificationTimelineEntry[]>(
            issueTimelineOptions(workspaceId, issueId).queryKey,
          ),
        isUnavailableError: (error) =>
          error instanceof ApiError &&
          (error.status === 403 || error.status === 404),
        isOfflineError,
      });

      const latest = useNotificationDestinationStore.getState().pending;
      if (
        !latest ||
        latest.key !== pending.key ||
        latest.nonce !== pending.nonce
      ) {
        return;
      }

      if (resolution.kind === "login") {
        router.replace("/login");
      } else if (resolution.kind === "issue") {
        router.navigate({
          pathname: "/[workspace]/issue/[id]",
          params: {
            workspace: resolution.workspace.slug,
            id: resolution.issueId,
            highlight: resolution.commentId,
            h: resolution.nonce,
            notificationKey: resolution.pendingKey,
            notificationNonce: resolution.nonce,
            notificationNotice: resolution.notice,
          },
        });
      } else if (resolution.kind === "inbox") {
        router.navigate({
          pathname: "/[workspace]/inbox",
          params: { workspace: resolution.workspace.slug },
        });
        await confirmNotificationDestinationHandled(
          pending.key,
          pending.nonce,
        );
      } else {
        setRecovery(resolution);
        router.navigate("/notification-recovery");
      }
    })()
      .catch(() => {
        const latest = useNotificationDestinationStore.getState().pending;
        if (
          latest &&
          latest.key === pending.key &&
          latest.nonce === pending.nonce
        ) {
          setRecovery({
            kind: "recovery",
            reason: "temporary_error",
            pendingKey: pending.key,
          });
          router.navigate("/notification-recovery");
        }
      })
      .finally(() => {
        lastAttemptRef.current = attemptKey;
        processingRef.current = false;
        const latest = useNotificationDestinationStore.getState().pending;
        if (
          latest &&
          (latest.key !== pending.key || latest.nonce !== pending.nonce)
        ) {
          setRunnerVersion((version) => version + 1);
        }
      });
  }, [
    authLoading,
    hydrated,
    pending,
    queryClient,
    revision,
    runnerVersion,
    setRecovery,
    user,
  ]);

  return null;
}
