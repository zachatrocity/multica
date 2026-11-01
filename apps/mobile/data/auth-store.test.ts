import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  class MockApiError extends Error {
    readonly status: number;

    constructor(message: string, status: number) {
      super(message);
      this.name = "ApiError";
      this.status = status;
    }
  }

  return {
    ApiError: MockApiError,
    clearToken: vi.fn(),
    disconnectAndroidAlertTransport: vi.fn(),
    getMe: vi.fn(),
    getPersistedWorkspaceSlug: vi.fn(),
    getToken: vi.fn(),
    hydratePersistedSlug: vi.fn(),
    invalidateSessionEpoch: vi.fn(),
    setToken: vi.fn(),
    setStoredToken: vi.fn(),
  };
});

vi.mock("./api", () => ({
  ApiError: mocks.ApiError,
  api: {
    getMe: mocks.getMe,
    setToken: mocks.setToken,
  },
}));
vi.mock("./secure-storage", () => ({
  clearToken: mocks.clearToken,
  getToken: mocks.getToken,
  setToken: mocks.setStoredToken,
}));
vi.mock("./session-epoch", () => ({
  invalidateSessionEpoch: mocks.invalidateSessionEpoch,
}));
vi.mock("./workspace-store", () => ({
  getPersistedWorkspaceSlug: mocks.getPersistedWorkspaceSlug,
  useWorkspaceStore: {
    getState: () => ({ hydratePersistedSlug: mocks.hydratePersistedSlug }),
  },
}));
vi.mock("./android-alerts", () => ({
  disconnectAndroidAlertTransport: mocks.disconnectAndroidAlertTransport,
}));

import {
  STARTUP_IDENTITY_TIMEOUT_MS,
  STARTUP_STORAGE_TIMEOUT_MS,
  useAuthStore,
} from "./auth-store";

const userOne = { id: "user-1", email: "one@example.test" };
const userTwo = { id: "user-2", email: "two@example.test" };

describe("auth startup", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.resetAllMocks();
    vi.spyOn(console, "warn").mockImplementation(() => {});
    mocks.getPersistedWorkspaceSlug.mockResolvedValue("acme");
    mocks.getToken.mockResolvedValue("saved-token");
    mocks.clearToken.mockResolvedValue(undefined);
    useAuthStore.setState({
      user: null,
      isLoading: true,
      startupPhase: "restoring-workspace",
      startupFailure: null,
    });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("surfaces a retryable network failure without deleting the saved session", async () => {
    mocks.getMe.mockRejectedValue(new Error("network details must stay private"));

    await useAuthStore.getState().initialize();

    expect(useAuthStore.getState()).toMatchObject({
      user: null,
      isLoading: false,
      startupPhase: "checking-session",
      startupFailure: { phase: "checking-session", code: "network" },
    });
    expect(mocks.clearToken).not.toHaveBeenCalled();
    expect(mocks.setToken).toHaveBeenCalledWith("saved-token");
    expect(console.warn).toHaveBeenCalledWith(
      "[startup] initialization failed",
      { phase: "checking-session", code: "network" },
    );
  });

  it("bounds a hanging secure-storage read", async () => {
    const { promise: hangingTokenRead } = Promise.withResolvers<never>();
    mocks.getToken.mockReturnValue(hangingTokenRead);
    const initialization = useAuthStore.getState().initialize();
    await vi.advanceTimersByTimeAsync(STARTUP_STORAGE_TIMEOUT_MS);
    await initialization;

    expect(useAuthStore.getState()).toMatchObject({
      isLoading: false,
      startupPhase: "restoring-session",
      startupFailure: { phase: "restoring-session", code: "timeout" },
    });
    expect(mocks.getMe).not.toHaveBeenCalled();
    expect(mocks.clearToken).not.toHaveBeenCalled();
  });

  it("ignores a timed-out identity check that resolves after a successful retry", async () => {
    const {
      promise: firstIdentity,
      resolve: resolveFirstIdentity,
    } = Promise.withResolvers<typeof userOne>();
    mocks.getMe
      .mockReturnValueOnce(firstIdentity)
      .mockResolvedValueOnce(userTwo);

    const firstInitialization = useAuthStore.getState().initialize();
    await vi.advanceTimersByTimeAsync(STARTUP_IDENTITY_TIMEOUT_MS);
    await firstInitialization;
    expect(useAuthStore.getState().startupFailure).toEqual({
      phase: "checking-session",
      code: "timeout",
    });

    await useAuthStore.getState().initialize();
    expect(useAuthStore.getState()).toMatchObject({
      user: userTwo,
      isLoading: false,
      startupPhase: "ready",
      startupFailure: null,
    });

    resolveFirstIdentity(userOne);
    await Promise.resolve();
    await Promise.resolve();

    expect(useAuthStore.getState().user).toBe(userTwo);
  });

  it("clears only a server-rejected session and finishes at sign-in", async () => {
    mocks.getMe.mockRejectedValue(new mocks.ApiError("unauthorized", 401));

    await useAuthStore.getState().initialize();

    expect(mocks.invalidateSessionEpoch).toHaveBeenCalledOnce();
    expect(mocks.clearToken).toHaveBeenCalledOnce();
    expect(mocks.setToken).toHaveBeenLastCalledWith(null);
    expect(useAuthStore.getState()).toMatchObject({
      user: null,
      isLoading: false,
      startupPhase: "ready",
      startupFailure: null,
    });
  });
});
