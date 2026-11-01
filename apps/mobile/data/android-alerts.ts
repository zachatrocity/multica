import Constants from "expo-constants";
import { Platform } from "react-native";
import { api } from "./api";
import { androidAlerts } from "@/modules/multica-android-alerts";

const ENDPOINT_WAIT_MS = 30_000;
const ENDPOINT_POLL_MS = 250;

function appVariant(): string {
  const value = Constants.expoConfig?.extra?.APP_ENV;
  return typeof value === "string" && value.length > 0 ? value : "development";
}

export async function waitForAndroidAlertEndpoint(
  timeoutMs = ENDPOINT_WAIT_MS,
): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const endpoint = androidAlerts.getEndpoint();
    if (endpoint) return endpoint;
    const state = androidAlerts.getState();
    if (state.registration_status === "failed") {
      throw new Error(state.registration_failure ?? "UnifiedPush registration failed");
    }
    await new Promise<void>((resolve) => setTimeout(resolve, ENDPOINT_POLL_MS));
  }
  throw new Error("UnifiedPush registration timed out");
}

export async function registerAndroidAlertTransport(): Promise<void> {
  if (Platform.OS !== "android" || !androidAlerts.isSupported) {
    throw new Error("Android alerts require an Android development build");
  }
  androidAlerts.createChannels();
  await androidAlerts.registerWithNtfy();
  const endpoint = await waitForAndroidAlertEndpoint();
  const deviceId = androidAlerts.getDeviceId();
  const registered = await api.registerAndroidPushEndpoint({
    device_id: deviceId,
    endpoint,
    app_variant: appVariant(),
  });
  if (!registered.id) throw new Error("The server did not accept this device");
}

export async function syncAndroidAlertTransport(): Promise<void> {
  if (Platform.OS !== "android" || !androidAlerts.isSupported) return;
  androidAlerts.createChannels();
  const state = androidAlerts.getState();
  if (!state.endpoint_available || !state.distributor_package) return;
  const initialEndpoint = androidAlerts.getEndpoint();
  if (!initialEndpoint) return;
  const register = async (endpoint: string) => {
    const registered = await api.registerAndroidPushEndpoint({
      device_id: state.device_id,
      endpoint,
      app_variant: appVariant(),
    });
    if (!registered.id) throw new Error("The server did not accept this device");
  };
  await register(initialEndpoint);
  await androidAlerts.refreshRegistration();
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const rotatedEndpoint = androidAlerts.getEndpoint();
    if (rotatedEndpoint && rotatedEndpoint !== initialEndpoint) {
      await register(rotatedEndpoint);
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
