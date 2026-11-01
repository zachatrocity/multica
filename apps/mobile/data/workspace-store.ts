/**
 * Mobile workspace store — Zustand. Holds the active workspace (id + slug)
 * and persists the slug to SecureStore so cold starts restore the last
 * selection without re-prompting.
 *
 * The route is the source of truth for which workspace is active
 * (`/[workspace]/...` URL segment, set by the layout that reads
 * useLocalSearchParams). This store is a fast cache that ApiClient.fetch
 * reads synchronously to inject the X-Workspace-Slug header — touching
 * the router or React context on every fetch would be ugly. Routes
 * sync into the store on mount via setCurrentWorkspace.
 *
 * Logic mirrors packages/core/platform/workspace-storage.ts:
 *   - One slug + one id at a time (no multi-ws state)
 *   - Cleared on logout
 */
import { create } from "zustand";
import * as SecureStore from "expo-secure-store";

const SLUG_KEY = "multica_current_workspace_slug";

interface WorkspaceState {
  currentWorkspaceId: string | null;
  currentWorkspaceSlug: string | null;
  /** Set the active workspace and persist the slug (id is in-memory only —
   *  it's resolved from the workspaces list query, not stored). */
  setCurrentWorkspace: (id: string, slug: string) => Promise<void>;
  /** Apply a slug read during startup. The read itself lives outside the
   *  store so a timed-out initialization cannot mutate state later. */
  hydratePersistedSlug: (slug: string | null) => void;
  clear: () => Promise<void>;
}

export const useWorkspaceStore = create<WorkspaceState>((set) => ({
  currentWorkspaceId: null,
  currentWorkspaceSlug: null,

  setCurrentWorkspace: async (id, slug) => {
    set({ currentWorkspaceId: id, currentWorkspaceSlug: slug });
    await SecureStore.setItemAsync(SLUG_KEY, slug);
  },

  hydratePersistedSlug: (slug) => {
    set({ currentWorkspaceSlug: slug });
  },

  clear: async () => {
    set({ currentWorkspaceId: null, currentWorkspaceSlug: null });
    await SecureStore.deleteItemAsync(SLUG_KEY);
  },
}));

/** Read without mutating. Startup owns the deadline and only hydrates the
 * winning initialization attempt, so a late SecureStore result stays inert. */
export function getPersistedWorkspaceSlug(): Promise<string | null> {
  return SecureStore.getItemAsync(SLUG_KEY);
}

/** Sync helper for ApiClient.fetch — reads the current slug without React. */
export function getCurrentSlug(): string | null {
  return useWorkspaceStore.getState().currentWorkspaceSlug;
}
