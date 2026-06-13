# Android Notifications Plan

## Recommendation

Use UnifiedPush for Android push delivery, with ntfy supported as the recommended self-hosted UnifiedPush distributor. Do not use raw ntfy topics as Multica's primary app notification path.

This keeps notification delivery Android-native and event-driven: the server publishes one push when it creates an inbox item, Android wakes Multica through the push distributor, and the app deep-links to the relevant inbox item or issue. It avoids WebSocket or HTTP polling while the app is backgrounded.

## Options Compared

### UnifiedPush

UnifiedPush is the better fit for the Android fork because it separates Multica from a single push vendor. Users can run ntfy as the distributor for self-hosted or de-Googled devices, while other distributors can handle devices that already use Firebase Cloud Messaging.

Strengths:

- Delivers to the Multica app, not a separate notification app.
- Supports self-hosted delivery through ntfy's UnifiedPush distributor mode.
- Avoids battery-heavy polling and does not require keeping the Multica WebSocket alive in the background.
- Gives the app control over notification tap handling, unread refresh, and deep links.
- Keeps the server contract provider-neutral: store an endpoint URL and POST encrypted or signed notification payloads to it.

Costs:

- Android-only native integration is required; Expo Go cannot validate this path.
- Users on self-hosted or de-Googled devices may need to install and configure a UnifiedPush distributor such as ntfy.
- The server needs push subscription storage, registration endpoints, and send retry/backoff logic.

### Raw ntfy Topics

Raw ntfy is attractive for self-hosting because the server can publish to an HTTP topic with very little code. It is not the right primary app notification path.

Strengths:

- Very small server implementation.
- Easy to self-host and debug with curl or the ntfy CLI.
- Does not require Firebase or an app-store push entitlement.

Costs:

- Notifications generally appear in the ntfy app, not Multica, unless Multica keeps its own background subscription alive.
- A Multica-owned background subscription would mean polling or a persistent background connection, which is bad for Android battery and unreliable under Doze.
- Topic names become bearer secrets and need careful rotation and revocation.
- Deep-link routing, per-device state, and per-user mute behavior become awkward compared with a first-class app push subscription.

Raw ntfy is still valuable as the recommended UnifiedPush distributor for users who want a self-hosted path.

## Must-Agree Product Semantics

Android push should mirror the existing web/desktop behavior in `packages/core/realtime/use-realtime-sync.ts`:

- Only `inbox:new` should create a system notification.
- `notification_preferences.system_notifications = "muted"` must suppress OS notifications.
- Tapping a notification should route to the same logical target as desktop: the workspace inbox entry, using the inbox item id and `issue_id ?? item.id`.
- In-app unread counts remain owned by the inbox cache and realtime invalidation path, not by push delivery.
- Push is best-effort. Missing a push must not lose data because the inbox remains the source of truth.

Mobile-specific differences:

- Android must receive notifications while the app process is backgrounded or killed, so the WebSocket-based desktop approach is insufficient.
- Permission prompting should be deferred until the user enables notifications or first opens notification settings, not shown during login.
- Registration should be per device. Signing out should unregister the device token/endpoint locally and best-effort delete it server-side.

## Server Contract

Add a provider-neutral mobile push subscription table:

```sql
CREATE TABLE mobile_push_subscription (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  provider TEXT NOT NULL CHECK (provider IN ('unifiedpush')),
  endpoint TEXT NOT NULL,
  device_name TEXT,
  app_variant TEXT NOT NULL DEFAULT 'production',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_success_at TIMESTAMPTZ,
  last_failure_at TIMESTAMPTZ,
  failure_count INTEGER NOT NULL DEFAULT 0,
  disabled_at TIMESTAMPTZ,
  UNIQUE (user_id, endpoint)
);
```

Register endpoints with authenticated, user-scoped APIs:

- `GET /api/mobile-push/subscriptions`
- `POST /api/mobile-push/subscriptions`
- `DELETE /api/mobile-push/subscriptions/{id}`

`POST` body:

```json
{
  "provider": "unifiedpush",
  "endpoint": "https://ntfy.example.com/up/...",
  "device_name": "Pixel 8",
  "app_variant": "staging"
}
```

Send push from the server-side notification path after an inbox item is created and before or after the existing `inbox:new` WebSocket publish. The send path should:

- Load active subscriptions for the recipient user.
- Respect `system_notifications` from notification preferences.
- Send a compact payload with `workspace_id`, `workspace_slug`, `inbox_item_id`, `issue_id`, `title`, and `body`.
- Use a short HTTP timeout and bounded retries.
- Disable or back off subscriptions after repeated permanent failures.
- Never block inbox item creation on push delivery.

## Android App Contract

Add an Android-only notifications module in `apps/mobile`:

- Request notification runtime permission on Android 13+ when the user enables system notifications.
- Register with a UnifiedPush distributor and receive the endpoint callback.
- POST the endpoint to `/api/mobile-push/subscriptions`.
- Store the local subscription id in secure storage.
- On logout, best-effort unregister from the distributor and delete the server subscription.
- On notification tap, navigate to `/${workspace_slug}/inbox` with enough route state to select the inbox item or issue.
- On foreground receipt, prefer cache invalidation and in-app unread indicators over showing a duplicate banner.

Expo implication: this requires a development build / prebuild path with Android native code or a vetted React Native UnifiedPush native module. It cannot be validated in Expo Go. Keep iOS unchanged until an APNs or Expo Push decision is made.

## Implementation Sequence

1. Add the database table, sqlc queries, API handlers, and handler tests for subscription registration and deletion.
2. Add a small server sender package for UnifiedPush endpoint POSTs with timeout, retry classification, and subscription failure bookkeeping.
3. Wire the sender into `server/cmd/server/notification_listeners.go` where inbox notifications are created, after preference filtering.
4. Add mobile API methods and zod schemas for the subscription endpoints.
5. Add an Android-only UnifiedPush registration service and a settings row showing whether this device is registered.
6. Add notification tap routing to the workspace inbox target.
7. Validate on an Android device with ntfy installed as the UnifiedPush distributor, including background, killed-app, muted preference, logout, and endpoint rotation cases.

## Why This Is Not Implemented Directly In This Ticket

The current mobile app is still Expo-managed and has no checked-in Android native project or push subscription server contract. Implementing UnifiedPush now would require committing a native Android integration and a new persistent server API. That is the correct direction, but it is large enough that the product decision should be explicit before the fork takes on the maintenance cost.

The decision needed before coding is whether the Android fork is willing to require a development-build/native Android module for push support. If yes, the plan above is ready to implement. If no, raw ntfy can be offered as a low-effort external notification bridge, but it should be labelled as an external ntfy notification integration rather than first-class Multica app notifications.
