import { describe, expect, it } from "vitest";
import {
  decodeNotificationDestination,
  notificationDestinationKey,
  notificationEventTypes,
} from "./notification-destination";

const payload = {
  version: 1,
  workspace_id: "11111111-1111-4111-8111-111111111111",
  workspace_slug: "example-workspace",
  issue_id: "22222222-2222-4222-8222-222222222222",
  comment_id: "33333333-3333-4333-8333-333333333333",
  inbox_item_id: "44444444-4444-4444-8444-444444444444",
  event_id: "55555555-5555-4555-8555-555555555555",
  event_type: "mentioned",
} as const;

describe("decodeNotificationDestination", () => {
  it("accepts the reviewed version and stable issue/comment identifiers", () => {
    const result = decodeNotificationDestination(payload);

    expect(result).toEqual({ kind: "issue", destination: payload });
    if (result.kind === "issue") {
      expect(notificationDestinationKey(result.destination)).toBe(
        payload.event_id,
      );
    }
  });

  it.each(notificationEventTypes)(
    "accepts the reviewed %s event destination",
    (eventType) => {
      expect(
        decodeNotificationDestination({ ...payload, event_type: eventType }).kind,
      ).toBe("issue");
    },
  );

  it.each([
    ["url", "https://attacker.example/steal"],
    ["host", "attacker.example"],
    ["route", "/admin"],
  ])("never accepts an arbitrary %s as routing data", (field, value) => {
    expect(
      decodeNotificationDestination({ ...payload, [field]: value }),
    ).toEqual({
      kind: "workspace_fallback",
      workspace: {
        workspaceId: payload.workspace_id,
        workspaceSlug: payload.workspace_slug,
      },
      reason: "malformed",
    });
  });

  it("falls back to the resolved workspace inbox for an old payload", () => {
    expect(decodeNotificationDestination({ ...payload, version: 0 })).toEqual({
      kind: "workspace_fallback",
      workspace: {
        workspaceId: payload.workspace_id,
        workspaceSlug: payload.workspace_slug,
      },
      reason: "unsupported_version",
    });
  });

  it.each([
    { ...payload, issue_id: "not-an-id" },
    { ...payload, event_type: "open_url" },
    { ...payload, event_id: undefined, inbox_item_id: undefined },
  ])("falls back instead of routing a malformed issue target", (candidate) => {
    expect(decodeNotificationDestination(candidate).kind).toBe(
      "workspace_fallback",
    );
  });

  it("rejects payloads whose workspace cannot be resolved safely", () => {
    expect(
      decodeNotificationDestination({
        version: 1,
        url: "https://attacker.example/steal",
      }),
    ).toEqual({ kind: "rejected", reason: "malformed" });
  });
});
