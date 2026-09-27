/**
 * Minimal Meta Graph API client (native fetch + timeout). Shared by the WhatsApp
 * outbound client, media download and CLI scripts. Never logs the access token.
 */

export interface GraphApiConfig {
  /** https://graph.facebook.com, or the local fake Graph API in development. */
  baseUrl: string;
  version: string;
  accessToken: string;
  timeoutMs: number;
  /**
   * DEMO_MODE (phase 9 M8, ADR-021): refuse any request to Meta, whatever baseUrl says — the
   * last line of defence that guarantees no real WhatsApp message leaves the public demo.
   */
  blockMeta?: boolean;
}

const META_DOMAINS = [
  "facebook.com",
  "fbsbx.com",
  "fbcdn.net",
  "whatsapp.com",
  "whatsapp.net",
  "meta.com",
];

/** Hosts that belong to Meta (Graph API, media CDN, WhatsApp). */
export function isMetaHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/\.$/, "");
  return META_DOMAINS.some((domain) => host === domain || host.endsWith(`.${domain}`));
}

export class DemoModeBlockedError extends Error {
  constructor() {
    super("DEMO_MODE: refusing to call Meta (no real WhatsApp traffic in the demo)");
    this.name = "DemoModeBlockedError";
  }
}

/** Error returned by the Graph API (`{ error: { message, type, code, error_subcode, fbtrace_id } }`). */
export class GraphApiError extends Error {
  constructor(
    message: string,
    public readonly httpStatus: number,
    public readonly code?: number,
    public readonly subcode?: number,
    public readonly type?: string,
    public readonly details?: string,
    public readonly fbtraceId?: string,
  ) {
    super(message);
    this.name = "GraphApiError";
  }
}

interface GraphErrorBody {
  error?: {
    message?: string;
    type?: string;
    code?: number;
    error_subcode?: number;
    error_data?: { details?: string };
    fbtrace_id?: string;
  };
}

export async function graphRequest<T>(
  config: GraphApiConfig,
  method: "GET" | "POST" | "DELETE",
  path: string,
  body?: unknown,
): Promise<T> {
  const url = `${config.baseUrl}/${config.version}/${path.replace(/^\//, "")}`;
  if (config.blockMeta && isMetaHost(new URL(url).hostname)) throw new DemoModeBlockedError();
  const response = await fetch(url, {
    method,
    headers: {
      Authorization: `Bearer ${config.accessToken}`,
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(config.timeoutMs),
  });

  const text = await response.text();
  let json: unknown;
  try {
    json = text ? JSON.parse(text) : {};
  } catch {
    json = {};
  }

  if (!response.ok) {
    const error = (json as GraphErrorBody).error ?? {};
    throw new GraphApiError(
      error.message ?? `Graph API ${method} ${path} failed with HTTP ${response.status}`,
      response.status,
      error.code,
      error.error_subcode,
      error.type,
      error.error_data?.details,
      error.fbtrace_id,
    );
  }
  return json as T;
}
