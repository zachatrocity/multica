/**
 * Mobile auth store — Zustand. Logic mirrors packages/core/auth/store.ts:
 *   - Token written ONLY on successful verifyCode
 *   - 401 → clear token; non-401 (5xx / network blip) → preserve token so
 *     the next launch can retry
 *   - logout = clear token + clear in-memory user + setToken(null)
 *
 * NOT shared with web/desktop (per Sharing Principles in root CLAUDE.md).
 * Storage backend is expo-secure-store (mobile only); web uses HttpOnly
 * cookies, desktop uses localStorage via StorageAdapter.
 */
import { create } from "zustand";
import type { User } from "@multica/core/types";
import { api, ApiError } from "./api";
import { clearToken, getToken, setToken } from "./secure-storage";
import { invalidateSessionEpoch } from "./session-epoch";
import {
  getPersistedWorkspaceSlug,
  useWorkspaceStore,
} from "./workspace-store";
import { disconnectAndroidAlertTransport } from "./android-alerts";

export const STARTUP_STORAGE_TIMEOUT_MS = 8_000;
export const STARTUP_IDENTITY_TIMEOUT_MS = 35_000;

export type StartupPhase =
  | "restoring-workspace"
  | "restoring-session"
  | "checking-session"
  | "clearing-session"
  | "ready";

export type StartupFailureCode =
  | "timeout"
  | "storage"
  | "network"
  | "server"
  | "unexpected";

export interface StartupFailure {
  phase: Exclude<StartupPhase, "ready">;
  code: StartupFailureCode;
}

class StartupTimeoutError extends Error {}

async function withStartupTimeout<T>(
  operation: Promise<T>,
  timeoutMs: number,
  onTimeout?: () => void,
): Promise<T> {
  const deadlineController = new AbortController();
  const timeoutId = setTimeout(() => {
    onTimeout?.();
    deadlineController.abort(new StartupTimeoutError());
  }, timeoutMs);
  const deadline = new Promise<never>((_, reject) => {
    deadlineController.signal.addEventListener(
      "abort",
      () => reject(deadlineController.signal.reason),
      { once: true },
    );
  });

  try {
    return await Promise.race([operation, deadline]);
  } finally {
    clearTimeout(timeoutId);
  }
}

function startupFailureCode(
  error: unknown,
  phase: Exclude<StartupPhase, "ready">,
): StartupFailureCode {
  if (error instanceof StartupTimeoutError) return "timeout";
  if (phase !== "checking-session") return "storage";
  if (error instanceof ApiError && error.status === 0) return "timeout";
  if (error instanceof ApiError && error.status >= 500) return "server";
  return "network";
}

let initializationAttempt = 0;

interface AuthState {
  user: User | null;
  isLoading: boolean;
  startupPhase: StartupPhase;
  startupFailure: StartupFailure | null;
  initialize: () => Promise<void>;
  setUnexpectedStartupFailure: () => void;
  sendCode: (email: string) => Promise<void>;
  verifyCode: (email: string, code: string) => Promise<User>;
  logout: () => Promise<void>;
  /** Overwrite the in-memory user — call after PATCH /api/me so name/avatar
   *  edits land without a refetch. Server response is the source of truth. */
  setUser: (user: User) => void;
}

export const useAuthStore = create<AuthState>((set) => ({
  user: null,
  isLoading: true,
  startupPhase: "restoring-workspace",
  startupFailure: null,

  initialize: async () => {
    const attempt = ++initializationAttempt;
    let phase: Exclude<StartupPhase, "ready"> = "restoring-workspace";
    const isCurrentAttempt = () => attempt === initializationAttempt;

    set({
      isLoading: true,
      startupPhase: phase,
      startupFailure: null,
    });

    try {
      const slug = await withStartupTimeout(
        getPersistedWorkspaceSlug(),
        STARTUP_STORAGE_TIMEOUT_MS,
      );
      if (!isCurrentAttempt()) return;
      useWorkspaceStore.getState().hydratePersistedSlug(slug);

      phase = "restoring-session";
      set({ startupPhase: phase });
      const token = await withStartupTimeout(
        getToken(),
        STARTUP_STORAGE_TIMEOUT_MS,
      );
      if (!isCurrentAttempt()) return;
      if (!token) {
        api.setToken(null);
        set({
          user: null,
          isLoading: false,
          startupPhase: "ready",
          startupFailure: null,
        });
        return;
      }

      api.setToken(token);
      phase = "checking-session";
      set({ startupPhase: phase });
      const controller = new AbortController();
      const user = await withStartupTimeout(
        api.getMe({ signal: controller.signal, skipUnauthorized: true }),
        STARTUP_IDENTITY_TIMEOUT_MS,
        () => controller.abort(),
      );
      if (!isCurrentAttempt()) return;
      set({
        user,
        isLoading: false,
        startupPhase: "ready",
        startupFailure: null,
      });
    } catch (error) {
      if (!isCurrentAttempt()) return;

      if (error instanceof ApiError && error.status === 401) {
        phase = "clearing-session";
        set({ startupPhase: phase });
        invalidateSessionEpoch();
        api.setToken(null);
        try {
          await withStartupTimeout(
            clearToken(),
            STARTUP_STORAGE_TIMEOUT_MS,
          );
        } catch (clearError) {
          if (!isCurrentAttempt()) return;
          const code = startupFailureCode(clearError, phase);
          console.warn("[startup] initialization failed", { phase, code });
          set({
            user: null,
            isLoading: false,
            startupFailure: { phase, code },
          });
          return;
        }
        if (!isCurrentAttempt()) return;
        set({
          user: null,
          isLoading: false,
          startupPhase: "ready",
          startupFailure: null,
        });
        return;
      }

      const code = startupFailureCode(error, phase);
      console.warn("[startup] initialization failed", { phase, code });
      set({
        isLoading: false,
        startupFailure: { phase, code },
      });
    }
  },

  setUnexpectedStartupFailure: () => {
    const phase = useAuthStore.getState().startupPhase;
    const failedPhase =
      phase === "ready" ? "checking-session" : phase;
    console.warn("[startup] initialization failed", {
      phase: failedPhase,
      code: "unexpected",
    });
    set({
      isLoading: false,
      startupFailure: { phase: failedPhase, code: "unexpected" },
    });
  },

  sendCode: async (email) => {
    await api.sendCode(email);
  },

  verifyCode: async (email, code) => {
    const { token, user } = await api.verifyCode(email, code);
    // Signing in replaces the credential just as decisively as signing out:
    // a renewal still in flight for the previous account must not write its
    // result over this one.
    invalidateSessionEpoch();
    await setToken(token);
    api.setToken(token);
    set({ user });
    return user;
  },

  logout: async () => {
    // First statement in the function, before any await. The Keychain delete
    // below is async, so until it lands a concurrent read still returns the
    // token being removed — the epoch is what makes this instant.
    invalidateSessionEpoch();
    await disconnectAndroidAlertTransport();
    await clearToken();
    api.setToken(null);
    set({ user: null });
  },

  setUser: (user) => set({ user }),
}));
