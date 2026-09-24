import { createHash } from "node:crypto";
import { graphRequest, GraphApiError, type GraphApiConfig } from "./graph-api.js";

/**
 * WhatsApp media download (Meta docs: business-phone-numbers/media):
 *   1. GET {graph}/{version}/{media-id}?phone_number_id=… → url (valid 5 min), mime, sha256, size
 *   2. GET url with the same Bearer token → bytes
 * The download URL is NEVER logged (it carries signed parameters), and the token is
 * only sent to allowed hosts. Bytes are streamed with a hard size cap.
 */

export interface MediaInfo {
  url: string;
  mimeType: string;
  sha256: string | null;
  fileSize: number | null;
}

export type MediaErrorKind =
  /** Media id unknown/expired (media ids from webhooks live 7 days). Permanent. */
  | "not_found"
  /** Download URL expired or invalid (404): fetch a new URL. */
  | "url_expired"
  /** Token invalid/expired (401/403, Graph code 190). Retryable after renewal. */
  | "unauthorized"
  | "too_large"
  | "host_not_allowed"
  | "timeout"
  | "http"
  | "network";

export class MediaDownloadError extends Error {
  constructor(
    public readonly kind: MediaErrorKind,
    message: string,
    public readonly httpStatus?: number,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = "MediaDownloadError";
  }
}

const META_DOWNLOAD_HOSTS = ["graph.facebook.com", "lookaside.fbsbx.com"];

/**
 * The access token only travels to Meta hosts over HTTPS (graph.facebook.com,
 * *.fbsbx.com); outside production also to the configured Graph host (fake Graph API).
 */
export function isAllowedDownloadUrl(
  url: string,
  options: { graphBaseUrl: string; production: boolean },
): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  const metaHost =
    META_DOWNLOAD_HOSTS.includes(parsed.hostname) || parsed.hostname.endsWith(".fbsbx.com");
  if (metaHost && parsed.protocol === "https:") return true;
  if (options.production) return false;
  const graph = new URL(options.graphBaseUrl);
  return (
    (parsed.protocol === "http:" || parsed.protocol === "https:") &&
    parsed.hostname === graph.hostname &&
    parsed.port === graph.port
  );
}

export interface DownloadedMedia {
  bytes: Uint8Array;
  sha256Hex: string;
  contentType: string | null;
}

export interface WhatsAppMediaClient {
  getMediaInfo(waMediaId: string): Promise<MediaInfo>;
  download(url: string, options: { maxBytes: number }): Promise<DownloadedMedia>;
}

export function createWhatsAppMediaClient(deps: {
  graph: GraphApiConfig;
  phoneNumberId: string;
  downloadTimeoutMs: number;
  production: boolean;
}): WhatsAppMediaClient {
  return {
    async getMediaInfo(waMediaId) {
      try {
        const info = await graphRequest<{
          url?: string;
          mime_type?: string;
          sha256?: string;
          file_size?: number | string;
        }>(
          deps.graph,
          "GET",
          `${encodeURIComponent(waMediaId)}?phone_number_id=${encodeURIComponent(deps.phoneNumberId)}`,
        );
        if (!info.url || !info.mime_type) {
          throw new MediaDownloadError("http", "Graph media response without url or mime_type");
        }
        const size = info.file_size === undefined ? null : Number(info.file_size);
        return {
          url: info.url,
          mimeType: info.mime_type,
          sha256: info.sha256 ?? null,
          fileSize: size !== null && Number.isFinite(size) ? size : null,
        };
      } catch (err) {
        throw toMediaError(err);
      }
    },

    async download(url, { maxBytes }) {
      if (
        !isAllowedDownloadUrl(url, {
          graphBaseUrl: deps.graph.baseUrl,
          production: deps.production,
        })
      ) {
        // Do not include the URL: it carries signed parameters.
        throw new MediaDownloadError("host_not_allowed", "Download URL host is not allowed");
      }

      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), deps.downloadTimeoutMs);
      try {
        // Cross-origin redirects drop the Authorization header (fetch spec).
        const response = await fetch(url, {
          headers: { Authorization: `Bearer ${deps.graph.accessToken}` },
          signal: controller.signal,
        });
        if (response.status === 404) {
          throw new MediaDownloadError("url_expired", "Download URL expired or invalid", 404);
        }
        if (response.status === 401 || response.status === 403) {
          throw new MediaDownloadError(
            "unauthorized",
            "Media download unauthorized (access token invalid or expired)",
            response.status,
          );
        }
        if (!response.ok || !response.body) {
          throw new MediaDownloadError(
            "http",
            `Media download failed with HTTP ${response.status}`,
            response.status,
          );
        }

        const declaredLength = Number(response.headers.get("content-length"));
        if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
          throw new MediaDownloadError(
            "too_large",
            `Media is ${declaredLength} bytes (max ${maxBytes})`,
          );
        }

        const hash = createHash("sha256");
        const chunks: Uint8Array[] = [];
        let total = 0;
        const reader = response.body.getReader();
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          total += value.byteLength;
          if (total > maxBytes) {
            controller.abort();
            throw new MediaDownloadError("too_large", `Media exceeds ${maxBytes} bytes`);
          }
          hash.update(value);
          chunks.push(value);
        }

        const bytes = new Uint8Array(total);
        let offset = 0;
        for (const chunk of chunks) {
          bytes.set(chunk, offset);
          offset += chunk.byteLength;
        }
        return {
          bytes,
          sha256Hex: hash.digest("hex"),
          contentType: response.headers.get("content-type"),
        };
      } catch (err) {
        throw toMediaError(err, controller.signal.aborted);
      } finally {
        clearTimeout(timer);
      }
    },
  };
}

function toMediaError(err: unknown, aborted = false): MediaDownloadError {
  if (err instanceof MediaDownloadError) return err;
  if (err instanceof GraphApiError) {
    if (err.httpStatus === 401 || err.httpStatus === 403 || err.code === 190) {
      return new MediaDownloadError(
        "unauthorized",
        `Graph API unauthorized: ${err.message}`,
        err.httpStatus,
        { cause: err },
      );
    }
    if (err.httpStatus === 404 || (err.httpStatus === 400 && err.code === 100)) {
      return new MediaDownloadError(
        "not_found",
        `Media not found or expired: ${err.message}`,
        err.httpStatus,
        { cause: err },
      );
    }
    return new MediaDownloadError("http", `Graph API error: ${err.message}`, err.httpStatus, {
      cause: err,
    });
  }
  const name = err instanceof Error ? err.name : "";
  if (aborted || name === "TimeoutError" || name === "AbortError") {
    return new MediaDownloadError("timeout", "Media request timed out", undefined, { cause: err });
  }
  return new MediaDownloadError(
    "network",
    `Media request failed: ${err instanceof Error ? err.message : String(err)}`,
    undefined,
    { cause: err },
  );
}
