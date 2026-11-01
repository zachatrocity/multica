import type { Attachment } from "@multica/core/types";
import { matchAttachmentByURL } from "@multica/core/attachments/image-sequence";
import { resolveAttachmentUrlWithBase } from "@/lib/attachment-url";

const API_URL = process.env.EXPO_PUBLIC_API_URL ?? "";

export interface MarkdownImageRequest {
  uri: string;
  headers?: Record<string, string>;
}

/**
 * Resolves durable attachment references into loadable image requests.
 *
 * The API's attachment download route requires the mobile bearer token. Signed
 * storage/CDN URLs and arbitrary external Markdown images must remain anonymous:
 * forwarding the Multica token to either would disclose the user's session.
 */
export function buildMarkdownImageRequest(
  uri: string,
  attachments: Attachment[] | undefined,
  token: string | null,
  apiBaseUrl = API_URL,
): MarkdownImageRequest {
  const match = matchAttachmentByURL(uri, attachments);
  const candidate = match
    ? match.download_url || match.markdown_url || match.url
    : uri;
  const resolvedUri = resolveAttachmentUrlWithBase(candidate, apiBaseUrl) ?? uri;
  const normalizedBaseUrl = apiBaseUrl.replace(/\/+$/, "");
  const isApiRequest =
    normalizedBaseUrl.length > 0 &&
    (resolvedUri === normalizedBaseUrl ||
      resolvedUri.startsWith(`${normalizedBaseUrl}/`));

  if (!token || !isApiRequest) return { uri: resolvedUri };

  return {
    uri: resolvedUri,
    headers: { Authorization: `Bearer ${token}` },
  };
}
