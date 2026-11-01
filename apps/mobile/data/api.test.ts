import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { api } from "./api";

// api.ts refuses to load without a base URL; set it before the import runs.
vi.hoisted(() => {
  process.env.EXPO_PUBLIC_API_URL = "https://api.example.test";
});

// The real store pulls in expo-secure-store; the client only needs the slug.
vi.mock("@/data/workspace-store", () => ({ getCurrentSlug: () => null }));
// Vitest does not transform React Native's Flow sources.
vi.mock("react-native", () => ({ Platform: { OS: "android" } }));


describe("api.deleteComment", () => {
  const fetchMock = vi.fn(async () => new Response(null, { status: 204 }));

  beforeEach(() => {
    fetchMock.mockClear();
    vi.stubGlobal("fetch", fetchMock);
    vi.spyOn(console, "log").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  // #8296: servers that keep a deleted comment's replies also route
  // /keep-replies; older servers do not, so a keep-replies delete that reaches
  // one fails instead of deleting the replies too.
  it.each([
    [{ keepReplies: true }, "https://api.example.test/api/comments/comment-1/keep-replies"],
    [{ keepReplies: false }, "https://api.example.test/api/comments/comment-1"],
    [undefined, "https://api.example.test/api/comments/comment-1"],
  ])("with %j sends DELETE %s", async (opts, url) => {
    await api.deleteComment("comment-1", opts);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith(url, expect.objectContaining({ method: "DELETE" }));
  });
});

describe("api request deadline", () => {
  it("continues through response parsing and bounds a hanging JSON body", async () => {
    vi.useFakeTimers();
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const response = new Response(null, { status: 200 });
    const { promise: hangingBody } = Promise.withResolvers<never>();
    vi.spyOn(response, "json").mockReturnValue(hangingBody);
    vi.stubGlobal("fetch", vi.fn(async () => response));

    const request = api.getMe();
    const rejection = expect(request).rejects.toMatchObject({
      name: "ApiError",
      status: 0,
    });
    await vi.advanceTimersByTimeAsync(30_000);

    await rejection;
    expect(console.warn).toHaveBeenCalledWith(
      "[api] ← TIMEOUT /api/me",
      expect.objectContaining({ duration: "30000ms" }),
    );
  });
});
