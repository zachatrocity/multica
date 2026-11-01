import { describe, expect, it } from "vitest";
import type { Attachment } from "@multica/core/types";
import { buildMarkdownImageRequest } from "./markdown-image-request";

function attachment(overrides: Partial<Attachment> = {}): Attachment {
  return {
    id: "att-1",
    workspace_id: "ws-1",
    issue_id: "issue-1",
    comment_id: "comment-1",
    chat_session_id: null,
    chat_message_id: null,
    uploader_type: "member",
    uploader_id: "member-1",
    filename: "photo.png",
    url: "/uploads/photo.png",
    download_url: "/api/attachments/att-1/download",
    markdown_url: "https://api.example/api/attachments/att-1/download",
    content_type: "image/png",
    size_bytes: 123,
    created_at: "2026-11-01T00:00:00Z",
    ...overrides,
  };
}

describe("buildMarkdownImageRequest", () => {
  it("authenticates a server-hosted attachment resolved from its markdown URL", () => {
    expect(
      buildMarkdownImageRequest(
        "https://api.example/api/attachments/att-1/download",
        [attachment()],
        "session-token",
        "https://api.example",
      ),
    ).toEqual({
      uri: "https://api.example/api/attachments/att-1/download",
      headers: { Authorization: "Bearer session-token" },
    });
  });

  it("does not disclose the session token to a signed CDN URL", () => {
    expect(
      buildMarkdownImageRequest(
        "https://api.example/api/attachments/att-1/download",
        [
          attachment({
            download_url: "https://cdn.example/photo.png?signature=secret",
          }),
        ],
        "session-token",
        "https://api.example",
      ),
    ).toEqual({
      uri: "https://cdn.example/photo.png?signature=secret",
    });
  });

  it("does not attach credentials to external markdown images", () => {
    expect(
      buildMarkdownImageRequest(
        "https://images.example/photo.png",
        undefined,
        "session-token",
        "https://api.example",
      ),
    ).toEqual({ uri: "https://images.example/photo.png" });
  });

  it("leaves API requests unauthenticated while signed out", () => {
    expect(
      buildMarkdownImageRequest(
        "/api/attachments/att-1/download",
        undefined,
        null,
        "https://api.example",
      ),
    ).toEqual({
      uri: "https://api.example/api/attachments/att-1/download",
    });
  });
});
