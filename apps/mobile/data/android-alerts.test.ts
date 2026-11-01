// @vitest-environment node
import { randomBytes, randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  let registration: { endpoint: string; p256dh: string; auth: string } | null = null;
  return {
    get registration() {
      return registration;
    },
    set registration(value) {
      registration = value;
    },
    registerAndroidPushEndpoint: vi.fn(),
    registerWithNtfy: vi.fn(),
    refreshRegistration: vi.fn(),
  };
});

vi.mock("react-native", () => ({ Platform: { OS: "android" } }));
vi.mock("expo-constants", () => ({
  default: { expoConfig: { extra: { APP_ENV: "production" } } },
}));
vi.mock("./api", () => ({
  api: { registerAndroidPushEndpoint: mocks.registerAndroidPushEndpoint },
}));
vi.mock("@/modules/multica-android-alerts", () => ({
  androidAlerts: {
    isSupported: true,
    createChannels: vi.fn(),
    registerWithNtfy: mocks.registerWithNtfy,
    refreshRegistration: mocks.refreshRegistration,
    getRegistration: () => mocks.registration,
    getDeviceId: () => "device-id",
    getState: () => ({
      registration_status: "registered",
      registration_failure: null,
      distributor_package: "io.heckel.ntfy",
      device_id: "device-id",
    }),
  },
}));

import {
  registerAndroidAlertTransport,
  syncAndroidAlertTransport,
} from "./android-alerts";
type Registration = { endpoint: string; p256dh: string; auth: string };

function randomEndpoint(): string {
  const endpoint = new URL("https://ntfy.invalid");
  endpoint.pathname = `/up/${randomUUID()}`;
  return endpoint.toString();
}

let initial: Registration;
let rotated: Registration;

beforeEach(() => {
  mocks.registration = null;
  vi.clearAllMocks();
  initial = {
    endpoint: randomEndpoint(),
    p256dh: randomBytes(65).toString("base64url"),
    auth: randomBytes(16).toString("base64url"),
  };
  rotated = {
    endpoint: randomEndpoint(),
    p256dh: randomBytes(65).toString("base64url"),
    auth: randomBytes(16).toString("base64url"),
  };
  mocks.registerAndroidPushEndpoint.mockResolvedValue({ id: "endpoint-id" });
  mocks.registerWithNtfy.mockImplementation(async () => {
    mocks.registration = initial;
  });
  mocks.refreshRegistration.mockResolvedValue(true);
});

describe("Android alert Web Push registration", () => {
  it("registers the connector endpoint and encryption keys together", async () => {
    await registerAndroidAlertTransport();

    expect(mocks.registerAndroidPushEndpoint).toHaveBeenCalledWith({
      device_id: "device-id",
      endpoint: initial.endpoint,
      p256dh: initial.p256dh,
      auth: initial.auth,
      app_variant: "production",
    });
  });

  it("refreshes an upgraded endpoint-only installation before server registration", async () => {
    mocks.refreshRegistration.mockImplementation(async () => {
      mocks.registration = initial;
      return true;
    });

    await syncAndroidAlertTransport();

    expect(mocks.refreshRegistration).toHaveBeenCalledOnce();
    expect(mocks.registerAndroidPushEndpoint).toHaveBeenCalledOnce();
    expect(mocks.registerAndroidPushEndpoint).toHaveBeenCalledWith(
      expect.objectContaining({
        endpoint: initial.endpoint,
        p256dh: initial.p256dh,
        auth: initial.auth,
      }),
    );
  });

  it("replaces server key material when the connector rotates it", async () => {
    mocks.registration = initial;
    mocks.refreshRegistration.mockImplementation(async () => {
      mocks.registration = rotated;
      return true;
    });

    await syncAndroidAlertTransport();

    expect(mocks.registerAndroidPushEndpoint).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining(initial),
    );
    expect(mocks.registerAndroidPushEndpoint).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining(rotated),
    );
  });
});
