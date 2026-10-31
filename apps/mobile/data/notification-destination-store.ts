import * as SecureStore from "expo-secure-store";
import { create } from "zustand";
import { z } from "zod";
import {
  decodeNotificationDestination,
  notificationDestinationKey,
  NotificationDestinationSchema,
  type PendingNotificationDestination,
} from "@/lib/notification-destination";
import type {
  NotificationRecoveryReason,
  NotificationResolution,
} from "@/lib/notification-destination-resolver";

const PENDING_DESTINATION_KEY = "multica_pending_notification_destination_v1";

const PersistedPendingDestinationSchema = z
  .object({
    key: z.string().min(1).max(128),
    nonce: z.string().min(1).max(64),
    target: z.union([
      z
        .object({
          kind: z.literal("issue"),
          destination: NotificationDestinationSchema,
        })
        .strict(),
      z
        .object({
          kind: z.literal("workspace_inbox"),
          workspace: z
            .object({
              workspaceId: z.string().uuid(),
              workspaceSlug: z
                .string()
                .min(1)
                .max(63)
                .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
            })
            .strict(),
          reason: z.enum(["malformed", "unsupported_version"]),
        })
        .strict(),
    ]),
  })
  .strict();

export interface NotificationRecoveryState {
  reason: NotificationRecoveryReason;
  workspaceId?: string;
  workspaceSlug?: string;
  workspaceName?: string;
  pendingKey: string;
}

interface NotificationDestinationState {
  hydrated: boolean;
  pending: PendingNotificationDestination | null;
  recovery: NotificationRecoveryState | null;
  revision: number;
  hydrate: () => Promise<void>;
  queue: (payload: unknown) => Promise<"queued" | "fallback" | "rejected">;
  confirmHandled: (key: string, nonce: string) => Promise<boolean>;
  cancel: () => Promise<void>;
  retry: () => Promise<void>;
  setRecovery: (resolution: Extract<NotificationResolution, { kind: "recovery" }>) => void;
}

let nonceSequence = 0;
let storageWrites: Promise<unknown> = Promise.resolve();

function nextNonce(): string {
  nonceSequence += 1;
  return `${Date.now()}-${nonceSequence}`;
}

function serializeStorage<T>(operation: () => Promise<T>): Promise<T> {
  const result = storageWrites.then(operation, operation);
  storageWrites = result.catch(() => undefined);
  return result;
}


export const useNotificationDestinationStore =
  create<NotificationDestinationState>((set, get) => ({
    hydrated: false,
    pending: null,
    recovery: null,
    revision: 0,

    hydrate: async () => {
      await serializeStorage(async () => {
        const stored = await SecureStore.getItemAsync(PENDING_DESTINATION_KEY);
        if (!stored) {
          set({ hydrated: true });
          return;
        }

        try {
          const parsed = PersistedPendingDestinationSchema.safeParse(
            JSON.parse(stored),
          );
          if (parsed.success) {
            set({ pending: parsed.data, hydrated: true });
            return;
          }
        } catch {
          // Invalid or obsolete persisted state is removed below.
        }

        await SecureStore.deleteItemAsync(PENDING_DESTINATION_KEY);
        set({ pending: null, hydrated: true });
      });
    },

    queue: async (payload) => {
      const decoded = decodeNotificationDestination(payload);
      if (decoded.kind === "rejected") return "rejected";

      const nonce = nextNonce();
      const pending: PendingNotificationDestination =
        decoded.kind === "issue"
          ? {
              key: notificationDestinationKey(decoded.destination),
              nonce,
              target: {
                kind: "issue",
                destination: decoded.destination,
              },
            }
          : {
              key: `workspace-fallback:${decoded.workspace.workspaceId}`,
              nonce,
              target: {
                kind: "workspace_inbox",
                workspace: decoded.workspace,
                reason: decoded.reason,
              },
            };

      await serializeStorage(async () => {
        await SecureStore.setItemAsync(
          PENDING_DESTINATION_KEY,
          JSON.stringify(pending),
        );
        set((state) => ({
          hydrated: true,
          pending,
          recovery: null,
          revision: state.revision + 1,
        }));
      });
      return decoded.kind === "issue" ? "queued" : "fallback";
    },

    confirmHandled: (key, nonce) =>
      serializeStorage(async () => {
        const current = get().pending;
        if (!current || current.key !== key || current.nonce !== nonce) {
          return false;
        }
        await SecureStore.deleteItemAsync(PENDING_DESTINATION_KEY);
        set((state) => ({
          pending: null,
          recovery: null,
          revision: state.revision + 1,
        }));
        return true;
      }),

    cancel: () =>
      serializeStorage(async () => {
        await SecureStore.deleteItemAsync(PENDING_DESTINATION_KEY);
        set((state) => ({
          pending: null,
          recovery: null,
          revision: state.revision + 1,
        }));
      }),

    retry: async () => {
      await serializeStorage(async () => {
        const pending = get().pending;
        if (!pending) return;
        const retried = { ...pending, nonce: nextNonce() };
        await SecureStore.setItemAsync(
          PENDING_DESTINATION_KEY,
          JSON.stringify(retried),
        );
        set((state) => ({
          pending: retried,
          recovery: null,
          revision: state.revision + 1,
        }));
      });
    },

    setRecovery: (resolution) => {
      set({
        recovery: {
          reason: resolution.reason,
          workspaceId: resolution.workspace?.id,
          workspaceSlug: resolution.workspace?.slug,
          workspaceName: resolution.workspace?.name,
          pendingKey: resolution.pendingKey,
        },
      });
    },
  }));

/** Stage-3 transport calls this before any navigation is attempted. */
export async function queueNotificationDestination(
  payload: unknown,
): Promise<"queued" | "fallback" | "rejected"> {
  return useNotificationDestinationStore.getState().queue(payload);
}

export async function confirmNotificationDestinationHandled(
  key: string,
  nonce: string,
): Promise<boolean> {
  return useNotificationDestinationStore
    .getState()
    .confirmHandled(key, nonce);
}

export async function cancelPendingNotificationDestination(): Promise<void> {
  await useNotificationDestinationStore.getState().cancel();
}
