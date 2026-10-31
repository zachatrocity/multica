import { describe, expect, it, vi } from "vitest";
import type { Workspace } from "@multica/core/types";
import type { PendingNotificationDestination } from "./notification-destination";
import {
  resolveNotificationDestination,
  type NotificationResolverDependencies,
} from "./notification-destination-resolver";

const workspace: Workspace = {
  id: "11111111-1111-4111-8111-111111111111",
  name: "Example Workspace",
  slug: "example-workspace",
  description: null,
  context: null,
  settings: {},
  repos: [],
  issue_prefix: "SWE",
  avatar_url: null,
  created_at: "2026-01-01T00:00:00Z",
  updated_at: "2026-01-01T00:00:00Z",
};

const issueId = "22222222-2222-4222-8222-222222222222";
const commentId = "33333333-3333-4333-8333-333333333333";
const eventId = "55555555-5555-4555-8555-555555555555";

function issuePending(nonce = "tap-1"): PendingNotificationDestination {
  return {
    key: eventId,
    nonce,
    target: {
      kind: "issue",
      destination: {
        version: 1,
        workspace_id: workspace.id,
        workspace_slug: workspace.slug,
        issue_id: issueId,
        comment_id: commentId,
        event_id: eventId,
        event_type: "mentioned",
      },
    },
  };
}

function dependencies(
  overrides: Partial<NotificationResolverDependencies> = {},
): NotificationResolverDependencies {
  return {
    authenticated: true,
    online: true,
    listWorkspaces: vi.fn(async () => [workspace]),
    getCachedWorkspaces: vi.fn(() => [workspace]),
    activateWorkspace: vi.fn(async () => undefined),
    loadIssue: vi.fn(async () => undefined),
    hasCachedIssue: vi.fn(() => false),
    loadTimeline: vi.fn(async () => [
      { id: commentId, type: "comment", deleted_at: null },
    ]),
    getCachedTimeline: vi.fn(() => undefined),
    isUnavailableError: vi.fn(() => false),
    isOfflineError: vi.fn(() => false),
    ...overrides,
  };
}

describe("resolveNotificationDestination", () => {
  it("preserves the destination while passwordless authentication is required", async () => {
    const deps = dependencies({ authenticated: false });

    await expect(resolveNotificationDestination(issuePending(), deps)).resolves.toEqual({
      kind: "login",
    });
    expect(deps.listWorkspaces).not.toHaveBeenCalled();
  });

  it("resumes the same pending destination once after sign-in", async () => {
    const pending = issuePending();
    const signedOut = dependencies({ authenticated: false });
    const signedIn = dependencies({ authenticated: true });

    await resolveNotificationDestination(pending, signedOut);
    const resumed = await resolveNotificationDestination(pending, signedIn);

    expect(resumed).toMatchObject({
      kind: "issue",
      issueId,
      commentId,
      pendingKey: eventId,
    });
    expect(signedOut.loadIssue).not.toHaveBeenCalled();
    expect(signedIn.loadIssue).toHaveBeenCalledTimes(1);
  });

  it("switches by stable workspace id and resolves the exact issue comment", async () => {
    const deps = dependencies();

    await expect(resolveNotificationDestination(issuePending(), deps)).resolves.toEqual({
      kind: "issue",
      workspace,
      issueId,
      commentId,
      nonce: "tap-1",
      pendingKey: eventId,
      notice: undefined,
    });
    expect(deps.activateWorkspace).toHaveBeenCalledWith(workspace);
    expect(deps.loadIssue).toHaveBeenCalledWith(workspace.id, issueId);
    expect(deps.loadTimeline).toHaveBeenCalledWith(workspace.id, issueId);
  });

  it("does not fall through to a workspace with only a matching payload slug", async () => {
    const otherWorkspace = { ...workspace, id: "66666666-6666-4666-8666-666666666666" };
    const deps = dependencies({
      listWorkspaces: vi.fn(async () => [otherWorkspace]),
    });

    await expect(resolveNotificationDestination(issuePending(), deps)).resolves.toEqual({
      kind: "recovery",
      reason: "workspace_unavailable",
      pendingKey: eventId,
    });
    expect(deps.activateWorkspace).not.toHaveBeenCalled();
  });

  it("shows unavailable recovery for a forbidden or deleted issue", async () => {
    const forbidden = new Error("forbidden");
    const deps = dependencies({
      loadIssue: vi.fn(async () => {
        throw forbidden;
      }),
      isUnavailableError: vi.fn((error) => error === forbidden),
    });

    await expect(resolveNotificationDestination(issuePending(), deps)).resolves.toEqual({
      kind: "recovery",
      reason: "issue_unavailable",
      workspace,
      pendingKey: eventId,
    });
  });

  it("opens the issue with a nonfatal message when the comment was deleted", async () => {
    const deps = dependencies({
      loadTimeline: vi.fn(async () => [
        { id: commentId, type: "comment", deleted_at: "2026-01-02T00:00:00Z" },
      ]),
    });

    await expect(resolveNotificationDestination(issuePending(), deps)).resolves.toMatchObject({
      kind: "issue",
      issueId,
      commentId: undefined,
      notice: "comment_unavailable",
    });
  });

  it("opens cached authorized content with an offline indicator", async () => {
    const deps = dependencies({
      online: false,
      hasCachedIssue: vi.fn(() => true),
      getCachedTimeline: vi.fn(() => [
        { id: commentId, type: "comment", deleted_at: null },
      ]),
    });

    await expect(resolveNotificationDestination(issuePending(), deps)).resolves.toMatchObject({
      kind: "issue",
      issueId,
      commentId,
      notice: "offline",
    });
    expect(deps.listWorkspaces).not.toHaveBeenCalled();
    expect(deps.loadIssue).not.toHaveBeenCalled();
  });

  it("keeps an uncached offline target pending for retry", async () => {
    const deps = dependencies({ online: false });

    await expect(resolveNotificationDestination(issuePending(), deps)).resolves.toEqual({
      kind: "recovery",
      reason: "offline",
      workspace,
      pendingKey: eventId,
    });
  });

  it("routes a malformed issue payload only to its revalidated workspace inbox", async () => {
    const pending: PendingNotificationDestination = {
      key: `workspace-fallback:${workspace.id}`,
      nonce: "tap-2",
      target: {
        kind: "workspace_inbox",
        workspace: {
          workspaceId: workspace.id,
          workspaceSlug: workspace.slug,
        },
        reason: "malformed",
      },
    };
    const deps = dependencies();

    await expect(resolveNotificationDestination(pending, deps)).resolves.toEqual({
      kind: "inbox",
      workspace,
      pendingKey: pending.key,
    });
    expect(deps.loadIssue).not.toHaveBeenCalled();
  });
});
