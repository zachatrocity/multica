// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";
import { parseWithFallback } from "@/lib/parse-response";
import {
  AndroidPushEndpointSchema,
  AndroidPushPreferenceSchema,
  EMPTY_TASK_MESSAGE_LIST,
  TaskMessageListSchema,
} from "./schemas";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("TaskMessageListSchema", () => {
  it("keeps an incomplete row renderable with safe defaults", () => {
    const parsed = TaskMessageListSchema.parse([
      {
        type: "future_event",
        task_id: 42,
        seq: "first",
        content: { malformed: true },
        input: "not-an-object",
      },
    ]);

    expect(parsed).toEqual([
      expect.objectContaining({
        type: "text",
        task_id: "",
        seq: 0,
        content: undefined,
        input: undefined,
      }),
    ]);
  });

  it("falls back to an empty transcript for a malformed response root", () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});

    expect(
      parseWithFallback(
        { messages: "not-an-array" },
        TaskMessageListSchema,
        EMPTY_TASK_MESSAGE_LIST,
        { endpoint: "GET /api/tasks/:id/messages" },
      ),
    ).toEqual([]);
  });
});

describe("Android push schemas", () => {
  it("keeps endpoint secrets out of parsed connection metadata", () => {
    const parsed = AndroidPushEndpointSchema.parse({
      id: "endpoint-id",
      device_id: "device-id",
      app_variant: "development",
      status: "active",
      endpoint: "https://ntfy.example/up/private-secret",
    });

    expect(parsed).not.toHaveProperty("endpoint");
  });

  it("fails closed while preserving high-signal category defaults", () => {
    expect(
      AndroidPushPreferenceSchema.parse({
        workspace_id: "workspace-id",
        enabled: "yes",
        mentions: "yes",
        comments: "yes",
      }),
    ).toEqual(
      expect.objectContaining({
        enabled: false,
        mentions: true,
        assignments: true,
        review_blockers: true,
        comments: false,
        routine_updates: false,
      }),
    );
  });
});
