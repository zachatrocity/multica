# Android alerts through ntfy and UnifiedPush

Multica uses ntfy as a UnifiedPush distributor. The Multica Android app owns the visible notification, Android channels, privacy behavior, and tap routing. The backend encrypts a small versioned payload with the subscription's RFC 8291 Web Push keys and publishes the ciphertext to the endpoint returned by UnifiedPush; it does not publish ordinary ntfy topic notifications.

## Prerequisites

- A reachable ntfy server with HTTPS.
- Auth enabled on ntfy by default. Create a dedicated publisher token; topic or endpoint obscurity is not authorization. Private-network deployments may explicitly opt into unauthenticated publishing as described below.
- ACLs limiting that token to publishing on the UnifiedPush endpoint namespace used by the distributor.
- The ntfy Android app installed and configured as the device's UnifiedPush distributor.
- Multica and ntfy clocks synchronized. Endpoint expiry and retry scheduling use server time.

Do not use a public ntfy host by default. Multica does not deploy ntfy or create its users, tokens, or ACLs.

## Backend configuration

For authenticated publishing (the default), set all three variables together and restart the backend:

```dotenv
MULTICA_NTFY_BASE_URL=https://ntfy.example.com
MULTICA_NTFY_ACCESS_TOKEN=tk_your_dedicated_publish_token
MULTICA_NTFY_SECRET_KEY=base64-encoded-32-byte-key
```

Generate the encryption key with `openssl rand -base64 32`. Keep it stable and back it up with the database. It encrypts UnifiedPush endpoints, P-256 public keys, and authentication secrets at rest. Losing it makes existing device registrations unreadable; devices must reconnect.

`MULTICA_NTFY_BASE_URL` is an allowlist boundary, not a client default. Registration rejects endpoints on another scheme, host, or path prefix, preventing clients from turning the backend into an arbitrary HTTP requester. For a development-only plain-HTTP ntfy server, explicitly set `MULTICA_NTFY_ALLOW_INSECURE_HTTP=true`; production should terminate TLS.

Docker Compose passes these variables through to the backend. The integration remains disabled when all three are empty. A partial or malformed configuration stops backend startup rather than storing plaintext endpoints or publishing without authentication.

### Explicit unauthenticated publishing

For a server whose access is controlled by a trusted private network, set
`MULTICA_NTFY_ALLOW_UNAUTHENTICATED=true` and leave `MULTICA_NTFY_ACCESS_TOKEN`
empty. `MULTICA_NTFY_BASE_URL` and `MULTICA_NTFY_SECRET_KEY` remain required;
HTTPS, endpoint-origin validation, and encryption at rest are unchanged.
No Authorization header is sent when the token is empty. If a token is supplied,
it is still used even with the opt-in enabled; authorization errors never fall
back to anonymous publishing. Unset/false opt-in preserves the token requirement.

This does not configure or secure ntfy. Anyone who can reach an unauthenticated
server and knows a topic may publish or read it according to the server ACLs.
The operator must enforce the intended network boundary. Do not enable this on
a publicly accessible server by default.

## ntfy configuration

Configure ntfy according to its authentication and access-control documentation. The exact ACL commands depend on the ntfy deployment and endpoint namespace. For authenticated mode, required outcome:

1. Anonymous publishing is denied.
2. The Multica token can publish only to the UnifiedPush endpoint namespace used by the distributor.
3. The Android distributor can receive those messages.
4. Reverse proxies preserve `Authorization`, request bodies, and successful 2xx responses.
5. Request-size limits allow Multica's bounded RFC 8291 ciphertext; decrypted payloads contain only bounded display copy, never full conversation bodies.

Never place the access token or a UnifiedPush endpoint in a URL, screenshot, log, issue, analytics property, or notification copy.

## Runtime contract

Authenticated account-level APIs register and rotate one complete Web Push subscription per `device_id`: endpoint, uncompressed P-256 public key, and 16-byte authentication secret. Registration is HTTPS-protected, validates the base64url key material, and encrypts every field at rest. Responses expose connection metadata only; subscription material is never returned. The Android client must call the authenticated device-revocation API before clearing its session on logout.

Workspace alert preferences are separate from inbox inclusion preferences. A device connection can serve multiple workspaces, but each workspace starts disabled. Enabling a workspace applies these defaults:

- Mentions: on
- Assignments: on
- Review, blocked, and failure handoffs: on
- Comments: off
- Routine status and issue updates: off

Real event and test deliveries use the same durable delivery worker. The
versioned payload contains stable event/workspace/resource identifiers,
`workspace_slug`, bounded server-generated display copy, and the reviewed
`action_needed` or `activity` channel classification. It never contains an
endpoint, access token, arbitrary route/URL, or an unbounded issue/comment
body. The Android service constructs a separate strict routing object from the
reviewed identifier fields before opening the app.

Every ntfy publish uses binary `aes128gcm` content coding with `Content-Type:
application/octet-stream` and a bounded `TTL`. The ephemeral sender key and salt
are generated per delivery. ntfy HTTP authentication remains an independent
transport control: enabling anonymous publishing does not disable payload
encryption, and Web Push keys are not sender tokens.

The Android client deduplicates by `event_id` because a network failure after
ntfy accepted a request can cause a retry with the same identifier. It replaces
notifications by workspace + issue, groups active notifications by workspace,
and uses the app's authenticated destination resolver for taps. Payload fields
remain untrusted identifiers: the resolver re-checks authentication, workspace
membership, and issue access before navigation.

## Android app behavior

In the app, open **More → Settings → Notifications → Set up Android alerts**.
The connection flow only accepts an installed ntfy UnifiedPush distributor.
It registers the returned endpoint with Multica before requesting Android 13+
notification permission; declining permission leaves workspace delivery
disabled and exposes a direct link to Android's app settings.

Multica creates two app-owned Android channels:

- **Action needed** — mentions, assignments, review handoffs, blocked work, and failures.
- **Activity** — comments and routine issue activity.

Android owns sound, vibration, and importance for both channels. The settings
screen rechecks app permission and each channel after returning from system
settings. Lock-screen copy is private by default, and the app stores the
UnifiedPush subscription material with an Android Keystore key. Signing out
calls the authenticated device-revocation endpoint, unregisters from ntfy, and
clears the local subscription even when server revocation cannot complete.

## Failure and retention behavior

- Inbox inclusion and Android delivery are selected independently. Muting an inbox group does not mute an enabled Android category, and ntfy failure never rolls back an inbox write.
- HTTP 401/403 quarantines the endpoint; 404/410 disables it.
- Timeouts, 429 responses, and 5xx responses retry with bounded backoff. Retried payloads keep the same event identifier.
- Registration refreshes endpoint expiry. Inactive endpoints expire after 90 days.
- Disabling or revoking an endpoint removes queued work. Disabled/quarantined endpoints and delivery history are deleted after 30 days.
- Delivery only considers supported events created after both endpoint activation and workspace enablement, so reconnecting does not replay old activity.

UnifiedPush and ntfy are best-effort transports. Android force-stop, distributor battery restrictions, network loss, and vendor background policy can delay delivery. The in-app inbox remains the source of truth.

## Upgrade deployment

Deploy migration `606_android_push_webpush_keys` with the backend before
installing the upgraded APK. The migration quarantines endpoint-only
registrations created by older APKs; they are never used for plaintext
delivery. On first authenticated app start, versionCode `2026110101` asks the
existing distributor for the current endpoint and key set, then replaces the
quarantined row. A reconnect from the notification settings screen performs the
same registration if background refresh cannot complete.

Keep the existing ntfy base URL, publisher authentication choice, and
`MULTICA_NTFY_SECRET_KEY`. No VAPID or other sender token is required. After the
backend and APK are upgraded, send a test alert from the app. Server-side and
emulator checks prove the encrypted contract; a real-phone notification remains
a required deployment verification because distributor and OEM background
behavior cannot be reproduced by unit tests.

## Backup and rotation

Back up PostgreSQL and `MULTICA_NTFY_SECRET_KEY` together. Rotate the ntfy publisher token in ntfy and `MULTICA_NTFY_ACCESS_TOKEN` atomically. Changing `MULTICA_NTFY_SECRET_KEY` requires every Android device to reconnect. UnifiedPush endpoint or Web Push key rotation is handled by re-registering the complete subscription for the same `device_id`; pending and future deliveries use only the replacement key material.
