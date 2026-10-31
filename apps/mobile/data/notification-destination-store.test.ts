import { beforeEach, describe, expect, it, vi } from "vitest";

const secureStore = vi.hoisted(() => ({
  value: null as string | null,
  holdSet: false,
  releaseSet: null as (() => void) | null,
}));

vi.mock("expo-secure-store", () => ({
  getItemAsync: vi.fn(async () => secureStore.value),
  setItemAsync: vi.fn(async (_key: string, value: string) => {
    if (secureStore.holdSet) {
      await new Promise<void>((resolve) => {
        secureStore.releaseSet = resolve;
      });
    }
    secureStore.value = value;
  }),
  deleteItemAsync: vi.fn(async () => {
    secureStore.value = null;
  }),
}));

import {
  confirmNotificationDestinationHandled,
  queueNotificationDestination,
  useNotificationDestinationStore,
} from "./notification-destination-store";

const payload = {
  version: 1,
  workspace_id: "11111111-1111-4111-8111-111111111111",
  workspace_slug: "example-workspace",
  issue_id: "22222222-2222-4222-8222-222222222222",
  comment_id: "33333333-3333-4333-8333-333333333333",
  event_id: "55555555-5555-4555-8555-555555555555",
  event_type: "mentioned",
};

beforeEach(() => {
  secureStore.value = null;
  secureStore.holdSet = false;
  secureStore.releaseSet = null;
  useNotificationDestinationStore.setState({
    hydrated: false,
    pending: null,
    recovery: null,
    revision: 0,
  });
});

describe("notification destination persistence", () => {
  it("persists a destination before exposing it for navigation", async () => {
    secureStore.holdSet = true;
    const queued = queueNotificationDestination(payload);
    await Promise.resolve();

    expect(useNotificationDestinationStore.getState().pending).toBeNull();

    secureStore.releaseSet?.();
    await expect(queued).resolves.toBe("queued");
    expect(secureStore.value).not.toBeNull();
    expect(useNotificationDestinationStore.getState().pending?.key).toBe(
      payload.event_id,
    );
  });

  it("hydrates a valid cold-start destination", async () => {
    secureStore.value = JSON.stringify({
      key: payload.event_id,
      nonce: "tap-1",
      target: { kind: "issue", destination: payload },
    });

    await useNotificationDestinationStore.getState().hydrate();

    expect(useNotificationDestinationStore.getState()).toMatchObject({
      hydrated: true,
      pending: {
        key: payload.event_id,
        nonce: "tap-1",
      },
    });
  });

  it("coalesces repeated taps into one pending target with a fresh nonce", async () => {
    await queueNotificationDestination(payload);
    const first = useNotificationDestinationStore.getState().pending;
    await queueNotificationDestination(payload);
    const second = useNotificationDestinationStore.getState().pending;

    expect(second?.key).toBe(first?.key);
    expect(second?.nonce).not.toBe(first?.nonce);
    expect(JSON.parse(secureStore.value ?? "null")).toEqual(second);
  });

  it("consumes only the exact route instance that confirmed handling", async () => {
    await queueNotificationDestination(payload);
    const first = useNotificationDestinationStore.getState().pending!;
    await queueNotificationDestination(payload);
    const second = useNotificationDestinationStore.getState().pending!;

    await expect(
      confirmNotificationDestinationHandled(first.key, first.nonce),
    ).resolves.toBe(false);
    expect(useNotificationDestinationStore.getState().pending).toEqual(second);

    await expect(
      confirmNotificationDestinationHandled(second.key, second.nonce),
    ).resolves.toBe(true);
    expect(useNotificationDestinationStore.getState().pending).toBeNull();
    expect(secureStore.value).toBeNull();
  });

  it("clears a login-resume destination when the user cancels", async () => {
    await queueNotificationDestination(payload);

    await useNotificationDestinationStore.getState().cancel();

    expect(useNotificationDestinationStore.getState().pending).toBeNull();
    expect(secureStore.value).toBeNull();
  });

  it("drops obsolete persisted state rather than attempting to route it", async () => {
    secureStore.value = JSON.stringify({ version: 0, route: "/admin" });

    await useNotificationDestinationStore.getState().hydrate();

    expect(useNotificationDestinationStore.getState()).toMatchObject({
      hydrated: true,
      pending: null,
    });
    expect(secureStore.value).toBeNull();
  });
});
