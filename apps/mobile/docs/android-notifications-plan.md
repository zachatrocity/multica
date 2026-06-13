# Android Notifications Plan

## Recommendation

For the existing Expo app, use `expo-notifications` with Expo Push Service as the default Android notification path. Keep UnifiedPush with ntfy as the self-hosted / de-Googled alternative. Do not use raw ntfy topics as Multica's primary app notification path.

Expo Push Service is the easiest path because it fits the current Expo development-build workflow, gives the app an `ExpoPushToken`, and lets the server send one provider-neutral HTTPS request to Expo instead of owning Firebase Cloud Messaging directly. Expo still delivers Android pushes through FCM under the hood, so this is not the right path for users who need a fully self-hosted or Google-free stack. For that case, UnifiedPush plus ntfy remains the better architecture.

## Options Compared

### Expo Push Service

Expo Push Service is the lowest-friction path for this codebase. The app installs `expo-notifications`, asks for notification permission, obtains an `ExpoPushToken`, and registers that token with Multica. The server sends notification payloads to Expo's push API; Expo handles delivery to FCM for Android and APNs for iOS.

Strengths:

- Best fit for the current Expo app and EAS/development-build workflow.
- Avoids writing and operating a direct FCM sender for Android.
- Gives one cross-platform token model if iOS notifications are added later.
- Delivers to the Multica app, so notification taps can route into the workspace inbox or issue.
- Expo Push Service is free to use within Expo's documented project rate limits.

Costs:

- Requires Firebase/FCM credentials for Android and EAS/project configuration.
- Requires a development build for Android push; Expo Go cannot validate remote push notifications on Android.
- Adds Expo as a notification relay between Multica and FCM/APNs.
- Not self-hosted and not suitable for de-Googled Android devices that cannot use FCM.

### UnifiedPush

UnifiedPush is the better fit when the Android fork wants a self-hosted or Google-independent notification path. Users can run ntfy as the distributor for self-hosted or de-Googled devices, while other distributors can handle devices that already use Firebase Cloud Messaging.

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
- It does not give the same easy iOS path that Expo Push Service would.

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

Add a provider-neutral mobile push subscription table so Expo can be the default provider without blocking a later UnifiedPush/ntfy path:

```sql
CREATE TABLE mobile_push_subscription (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  provider TEXT NOT NULL CHECK (provider IN ('expo', 'unifiedpush')),
  token TEXT NOT NULL,
  device_name TEXT,
  app_variant TEXT NOT NULL DEFAULT 'production',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_success_at TIMESTAMPTZ,
  last_failure_at TIMESTAMPTZ,
  failure_count INTEGER NOT NULL DEFAULT 0,
  disabled_at TIMESTAMPTZ,
  UNIQUE (user_id, provider, token)
);
```

Register endpoints with authenticated, user-scoped APIs:

- `GET /api/mobile-push/subscriptions`
- `POST /api/mobile-push/subscriptions`
- `DELETE /api/mobile-push/subscriptions/{id}`

`POST` body:

```json
{
  "provider": "expo",
  "token": "ExponentPushToken[...]",
  "device_name": "Pixel 8",
  "app_variant": "staging"
}
```

Send push from the server-side notification path after an inbox item is created and before or after the existing `inbox:new` WebSocket publish. The send path should:

- Load active subscriptions for the recipient user.
- Respect `system_notifications` from notification preferences.
- Send a compact payload with `workspace_id`, `workspace_slug`, `inbox_item_id`, `issue_id`, `title`, and `body`.
- For `provider = 'expo'`, send the payload to Expo Push Service.
- For `provider = 'unifiedpush'`, POST to the UnifiedPush endpoint URL stored in `token`.
- Use a short HTTP timeout and bounded retries.
- Disable or back off subscriptions after repeated permanent failures.
- Never block inbox item creation on push delivery.

## Android App Contract

Add Expo notifications support in `apps/mobile`:

- Request notification runtime permission on Android 13+ when the user enables system notifications.
- Call `Notifications.getExpoPushTokenAsync` with the Expo project id and receive the `ExpoPushToken`.
- POST the token to `/api/mobile-push/subscriptions` with `provider = 'expo'`.
- Store the local subscription id in secure storage.
- On logout, best-effort unregister from the distributor and delete the server subscription.
- On notification tap, navigate to `/${workspace_slug}/inbox` with enough route state to select the inbox item or issue.
- On foreground receipt, prefer cache invalidation and in-app unread indicators over showing a duplicate banner.

Expo implication: Android remote push requires a development build and Firebase/FCM credentials. Expo Go is not enough for Android remote push validation. If the project later chooses UnifiedPush, add an Android-only native module as a second provider rather than replacing the Expo token path.

## Implementation Sequence

1. Add the database table, sqlc queries, API handlers, and handler tests for subscription registration and deletion.
2. Install `expo-notifications`, configure Android FCM credentials for the Expo/EAS project, and add Android notification channel setup.
3. Wire the sender into `server/cmd/server/notification_listeners.go` where inbox notifications are created, after preference filtering.
4. Add mobile API methods and zod schemas for the subscription endpoints.
5. Add Expo push-token registration and a settings row showing whether this device is registered.
6. Add notification tap routing to the workspace inbox target.
7. Validate on an Android device or Google Play-enabled emulator, including background, killed-app, muted preference, logout, token rotation, and Expo push receipts.
8. Add UnifiedPush/ntfy only if self-hosted or de-Googled Android delivery is a product requirement.

## References

- Expo push notification setup: https://docs.expo.dev/push-notifications/push-notifications-setup/
- Expo Notifications SDK: https://docs.expo.dev/versions/latest/sdk/notifications/
- Send notifications with Expo Push Service: https://docs.expo.dev/push-notifications/sending-notifications/
- Expo push notification FAQ: https://docs.expo.dev/push-notifications/faq/

## Why This Is Not Implemented Directly In This Ticket

The current mobile app does not have notification dependencies, FCM credentials, or a push subscription server contract yet. Expo Push Service makes this much smaller than a UnifiedPush-first implementation, but it still requires a persistent server API and project-level Android push credentials.

The decision needed before coding is whether Expo Push Service is acceptable as a hosted relay and FCM-backed Android path. If yes, the next implementation ticket should build the Expo provider first. If no, use UnifiedPush with ntfy as the self-hosted distributor, accepting the native Android integration and user setup cost.
