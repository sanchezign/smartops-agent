/**
 * Ensures this Meta app is subscribed to webhooks on the WABA
 * (POST /{WABA_ID}/subscribed_apps). Without it, Meta verifies the callback URL
 * but never delivers webhooks. Idempotent. Reads credentials from apps/api/.env.
 *
 *   pnpm --filter @smartops/api wa:subscribe
 */
import { createLogger } from "../src/common/logger.js";
import { loadEnv } from "../src/config/env.js";
import {
  graphRequest,
  GraphApiError,
  type GraphApiConfig,
} from "../src/modules/whatsapp/graph-api.js";

interface SubscribedAppsResponse {
  data?: {
    whatsapp_business_api_data?: { id?: string; name?: string; link?: string };
    override_callback_uri?: string;
  }[];
}

const env = loadEnv();
const logger = createLogger(env);
const config: GraphApiConfig = {
  baseUrl: env.WHATSAPP_GRAPH_BASE_URL,
  version: env.WHATSAPP_GRAPH_API_VERSION,
  accessToken: env.WHATSAPP_ACCESS_TOKEN,
  timeoutMs: env.WHATSAPP_API_TIMEOUT_MS,
  blockMeta: env.DEMO_MODE,
};
const path = `${env.WHATSAPP_WABA_ID}/subscribed_apps`;

async function listSubscribedApps(label: string): Promise<void> {
  const res = await graphRequest<SubscribedAppsResponse>(config, "GET", path);
  const apps = (res.data ?? []).map((item) => ({
    id: item.whatsapp_business_api_data?.id,
    name: item.whatsapp_business_api_data?.name,
    overrideCallbackUri: item.override_callback_uri,
  }));
  logger.info({ apps }, `${label}: ${apps.length} app(s) subscribed to the WABA`);
}

try {
  await listSubscribedApps("before");
  const res = await graphRequest<{ success?: boolean }>(config, "POST", path);
  logger.info({ success: res.success === true }, "POST subscribed_apps");
  await listSubscribedApps("after");
  process.exitCode = 0;
} catch (err) {
  if (err instanceof GraphApiError) {
    logger.error(
      {
        httpStatus: err.httpStatus,
        code: err.code,
        subcode: err.subcode,
        type: err.type,
        details: err.details,
        fbtraceId: err.fbtraceId,
      },
      `Graph API error: ${err.message}`,
    );
  } else {
    logger.error({ err }, "subscribe failed");
  }
  process.exitCode = 1;
}
