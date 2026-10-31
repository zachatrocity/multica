import { z } from "zod";

export const NOTIFICATION_DESTINATION_VERSION = 1 as const;

export const notificationEventTypes = [
  "issue_assigned",
  "unassigned",
  "assignee_changed",
  "status_changed",
  "priority_changed",
  "start_date_changed",
  "due_date_changed",
  "new_comment",
  "mentioned",
  "review_requested",
  "task_failed",
  "agent_blocked",
] as const;

const uuid = z.string().uuid();
const workspaceSlug = z
  .string()
  .min(1)
  .max(63)
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);

export const NotificationDestinationSchema = z
  .object({
    version: z.literal(NOTIFICATION_DESTINATION_VERSION),
    workspace_id: uuid,
    workspace_slug: workspaceSlug,
    issue_id: uuid,
    comment_id: uuid.optional(),
    inbox_item_id: uuid.optional(),
    event_id: uuid.optional(),
    event_type: z.enum(notificationEventTypes),
  })
  .strict()
  .refine((value) => value.inbox_item_id != null || value.event_id != null, {
    message: "A stable inbox_item_id or event_id is required",
  });

export type NotificationDestination = z.infer<
  typeof NotificationDestinationSchema
>;

export interface NotificationWorkspaceTarget {
  workspaceId: string;
  workspaceSlug: string;
}

export type DecodedNotificationDestination =
  | {
      kind: "issue";
      destination: NotificationDestination;
    }
  | {
      kind: "workspace_fallback";
      workspace: NotificationWorkspaceTarget;
      reason: "malformed" | "unsupported_version";
    }
  | {
      kind: "rejected";
      reason: "malformed" | "unsupported_version";
    };

export type PendingNotificationTarget =
  | {
      kind: "issue";
      destination: NotificationDestination;
    }
  | {
      kind: "workspace_inbox";
      workspace: NotificationWorkspaceTarget;
      reason: "malformed" | "unsupported_version";
    };

export interface PendingNotificationDestination {
  key: string;
  nonce: string;
  target: PendingNotificationTarget;
}

const WorkspaceTargetSchema = z
  .object({
    workspace_id: uuid,
    workspace_slug: workspaceSlug,
  })
  .passthrough();

/**
 * Parses routing facts only. The schema is intentionally strict: notification
 * data may not supply URLs, hosts, route names, or future fields that the app
 * has not explicitly reviewed. A payload with a valid workspace but an invalid
 * issue destination degrades to that workspace's inbox after membership is
 * rechecked; an unresolvable payload is ignored.
 */
export function decodeNotificationDestination(
  payload: unknown,
): DecodedNotificationDestination {
  const parsed = NotificationDestinationSchema.safeParse(payload);
  if (parsed.success) {
    return { kind: "issue", destination: parsed.data };
  }

  const version =
    payload && typeof payload === "object" && "version" in payload
      ? (payload as { version?: unknown }).version
      : undefined;
  const reason =
    version !== undefined && version !== NOTIFICATION_DESTINATION_VERSION
      ? "unsupported_version"
      : "malformed";
  const workspace = WorkspaceTargetSchema.safeParse(payload);

  if (!workspace.success) return { kind: "rejected", reason };
  return {
    kind: "workspace_fallback",
    workspace: {
      workspaceId: workspace.data.workspace_id,
      workspaceSlug: workspace.data.workspace_slug,
    },
    reason,
  };
}

export function notificationDestinationKey(
  destination: NotificationDestination,
): string {
  return destination.event_id ?? destination.inbox_item_id!;
}
