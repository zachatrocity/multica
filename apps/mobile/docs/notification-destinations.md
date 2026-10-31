# Android notification destinations

Notification transport and in-app navigation are separate. UnifiedPush/ntfy code hands the decoded JSON object to `queueNotificationDestination` from `data/notification-destination-store.ts`; it must not construct or open a route itself.

## Version 1 payload

```json
{
  "version": 1,
  "workspace_id": "11111111-1111-4111-8111-111111111111",
  "workspace_slug": "example-workspace",
  "issue_id": "22222222-2222-4222-8222-222222222222",
  "comment_id": "33333333-3333-4333-8333-333333333333",
  "inbox_item_id": "44444444-4444-4444-8444-444444444444",
  "event_id": "55555555-5555-4555-8555-555555555555",
  "event_type": "mentioned"
}
```

Required: `version`, `workspace_id`, `workspace_slug`, `issue_id`, `event_type`, and at least one of `inbox_item_id` or `event_id`. `comment_id` is optional. Every resource identifier is a UUID. The workspace slug is a routing hint; membership is matched by stable workspace id and the current server-returned slug wins.

Allowed event types:

- `issue_assigned`
- `unassigned`
- `assignee_changed`
- `status_changed`
- `priority_changed`
- `start_date_changed`
- `due_date_changed`
- `new_comment`
- `mentioned`
- `review_requested`
- `task_failed`
- `agent_blocked`

The object is strict. URLs, hosts, route names, unknown event types, unknown fields, malformed identifiers, and unsupported versions are never used as navigation. If the workspace id and slug remain valid, invalid issue payloads fall back to that revalidated workspace inbox; otherwise the tap is rejected.

Display title/body/excerpts are not routing data and do not belong in this object. Endpoint/topic credentials never belong in notification content, destination data, logs, or analytics.

## Lifecycle

1. Call and await `queueNotificationDestination(payload)`. It writes the pending destination to Android secure storage before exposing it to the root resolver.
2. The resolver waits for auth hydration. Signed-out users see private resume copy; passwordless verification does not clear the pending target.
3. The resolver refreshes workspace membership, activates the server-returned workspace, and fetches the issue and optional comment before navigating.
4. Navigation uses Expo Router `navigate`, not `push`, so repeated taps reuse the issue destination. A fresh nonce still retriggers the existing comment scroll-and-flash behavior.
5. The issue screen calls `confirmNotificationDestinationHandled(key, nonce)` only after the authorized issue has loaded. A stale screen cannot consume a newer repeated tap.

Malformed payloads consume after the revalidated inbox route is dispatched. Login cancellation, recovery actions, and workspace selection explicitly clear the pending target.

## Recovery

- Missing workspace membership: choose another workspace; never fall through by slug.
- Forbidden/deleted issue: show unavailable recovery with workspace inbox and workspace-picker actions.
- Deleted comment: open the issue without an anchor and show a dismissible nonfatal message.
- Offline with cached workspace and issue: open saved content with an offline message.
- Offline without cache: retain the destination and offer Retry or workspace inbox when available.
- Unsupported/malformed version: revalidate the workspace and open its inbox only.

The resolver never opens a browser or app URL supplied by a notification.
