# Android Notifications

Multica mobile uses Expo Push Service as the default Android notification path. The app registers an Expo push token with the Multica server after the user enables System notifications, and the server sends native pushes for persisted inbox notifications.

## Default Hosted Path: Expo Push Service

Expo Push Service is the default because it fits the current Expo development-build workflow and keeps the server provider-neutral. Android delivery still uses Firebase Cloud Messaging under the hood, so this is not a de-Googled or fully self-hosted path.

Required setup for each app variant:

- Install app dependencies with `pnpm install` after `expo-notifications` is added.
- Set `EXPO_EAS_PROJECT_ID` in the active mobile env file. This must match the EAS project that owns the Android build.
- Configure Firebase/FCM credentials for the Expo/EAS project. Android remote push cannot be validated in Expo Go; use a development build or production build.
- Run a prebuild/build for the target variant so the `expo-notifications` config plugin writes Android notification metadata.

Development:

- Use `.env.development.local` with a LAN-reachable `EXPO_PUBLIC_API_URL` and `EXPO_EAS_PROJECT_ID`.
- Start the API locally and run `pnpm --filter @multica/mobile android`.
- Use a real Android device or Google Play-enabled emulator. Remote push depends on FCM.

Staging:

- Put the staging API URL and staging EAS project id in `.env.staging`.
- Configure staging Firebase credentials on the staging EAS project.
- Build with `pnpm --filter @multica/mobile android:staging`.

Production:

- Put `EXPO_PUBLIC_API_URL=https://api.multica.ai` and the production EAS project id in `.env.production`.
- Configure production Firebase credentials on the production EAS project.
- Build with `pnpm --filter @multica/mobile android:prod`.

Self-hosted deployments using the Expo path:

- The self-hosted API can send through Expo Push Service without storing Firebase server credentials.
- The Android app build still needs an EAS project id and Firebase/FCM credentials attached to that Expo project.
- Operators should treat Expo as a hosted relay between the self-hosted Multica server and FCM.

## Runtime Behavior

- The app only asks for notification permission when System notifications are enabled in mobile settings.
- Registration is per user/device/app variant and stored server-side in `mobile_push_subscription`.
- Logout best-effort deletes the stored server subscription.
- Foreground notifications do not show duplicate native banners; the app invalidates the inbox cache and lets realtime/in-app UI show the update.
- Notification taps deep-link to the target issue when an `issue_id` is present, otherwise to the workspace inbox.
- Push is best-effort. The inbox remains the source of truth if delivery fails.

## Server Contract

Authenticated mobile clients use the active workspace context for access control:

- `GET /api/mobile-push/subscriptions`
- `POST /api/mobile-push/subscriptions`
- `DELETE /api/mobile-push/subscriptions/{id}`

`POST` body:

```json
{
  "provider": "expo",
  "token": "ExponentPushToken[...]",
  "device_name": "Android device",
  "app_variant": "staging"
}
```

The server sends native pushes after inbox rows are created. It respects `notification_preferences.system_notifications = "muted"` and does not block inbox creation on push delivery.

## Self-Hosted or De-Googled Alternative: UnifiedPush with ntfy

Use UnifiedPush when the Android app must avoid Google/Firebase or when the notification distributor must be self-hosted. ntfy is the recommended distributor for this path because it already supports UnifiedPush distributor mode.

Tradeoffs:

- UnifiedPush requires Android-native integration; it is not validated in Expo Go.
- Users may need to install and configure a distributor such as ntfy.
- Delivery can still deep-link into Multica because notifications arrive in the Multica app, not a separate ntfy-only notification stream.
- It avoids background polling and avoids keeping Multica WebSocket connections alive while the app is backgrounded.

Raw ntfy topics are not first-class Multica app notifications. Topic names act like bearer secrets, notifications generally appear in the ntfy app, and making Multica subscribe directly would require polling or a long-running background connection that is unreliable under Android Doze.
