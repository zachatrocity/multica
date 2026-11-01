import Constants from "expo-constants";
import { Platform } from "react-native";
import { api } from "./api";
import {
  androidAlerts,
  type AndroidAlertRegistration,
} from "@/modules/multica-android-alerts";

const ENDPOINT_WAIT_MS = 30_000;
const ENDPOINT_POLL_MS = 250;

function appVariant(): string {
  const value = Constants.expoConfig?.extra?.APP_ENV;
  return typeof value === "string" && value.length > 0 ? value : "development";
}

export async function waitForAndroidAlertRegistration(
  timeoutMs = ENDPOINT_WAIT_MS,
): Promise<AndroidAlertRegistration> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const registration = androidAlerts.getRegistration();
    if (registration) return registration;
    const state = androidAlerts.getState();
    if (state.registration_status === "failed") {
      throw new Error(state.registration_failure ?? "UnifiedPush registration failed");
    }
    await new Promise<void>((resolve) => setTimeout(resolve, ENDPOINT_POLL_MS));
  }
  throw new Error("UnifiedPush registration timed out");
}

async function registerWithServer(
  registration: AndroidAlertRegistration,
  deviceId: string,
): Promise<void> {
  const registered = await api.registerAndroidPushEndpoint({
    device_id: deviceId,
    endpoint: registration.endpoint,
    p256dh: registration.p256dh,
    auth: registration.auth,
    app_variant: appVariant(),
  });
  if (!registered.id) throw new Error("The server did not accept this device");
}

export async function registerAndroidAlertTransport(): Promise<void> {
  if (Platform.OS !== "android" || !androidAlerts.isSupported) {
    throw new Error("Android alerts require an Android development build");
  }
  androidAlerts.createChannels();
  await androidAlerts.registerWithNtfy();
  const registration = await waitForAndroidAlertRegistration();
  await registerWithServer(registration, androidAlerts.getDeviceId());
}

export async function syncAndroidAlertTransport(): Promise<void> {
  if (Platform.OS !== "android" || !androidAlerts.isSupported) return;
  androidAlerts.createChannels();
  const state = androidAlerts.getState();
  if (!state.distributor_package) return;

  const initial = androidAlerts.getRegistration();
  if (initial) {
    await registerWithServer(initial, state.device_id);
  }
  if (!(await androidAlerts.refreshRegistration())) return;
  if (!initial) {
    await registerWithServer(
      await waitForAndroidAlertRegistration(5_000),
      state.device_id,
    );
    return;
  }

  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const refreshed = androidAlerts.getRegistration();
    if (
      refreshed &&
      (refreshed.endpoint !== initial.endpoint ||
        refreshed.p256dh !== initial.p256dh ||
        refreshed.auth !== initial.auth)
    ) {
      await registerWithServer(refreshed, state.device_id);
      return;
    }
    await new Promise<void>((resolve) => setTimeout(resolve, ENDPOINT_POLL_MS));
  }
}
export async function disconnectAndroidAlertTransport(): Promise<void> {
  if (Platform.OS !== "android" || !androidAlerts.isSupported) return;
  const deviceId = androidAlerts.getDeviceId();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 3_000);
  try {
    if (deviceId) {
      await api.revokeAndroidPushDevice(deviceId, { signal: controller.signal });
    }
  } catch {
    // Best effort: the server expires inactive endpoints and the local secret
    // still must be removed even when the device is offline.
  } finally {
    clearTimeout(timeout);
    await androidAlerts.unregister().catch(() => undefined);
  }
}
