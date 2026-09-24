/**
 * wa:fake-graph — runs the local fake Meta Graph API (see fake-graph.ts).
 *
 *   pnpm --filter @smartops/api wa:fake-graph
 *   pnpm --filter @smartops/api wa:fake-graph --fail-send 131030
 *   pnpm --filter @smartops/api wa:fake-graph --fault media-info:404 --fault download:500
 *   pnpm --filter @smartops/api wa:fake-graph --fault download:corrupt   (checksum mismatch)
 *   pnpm --filter @smartops/api wa:fake-graph --outside-window --status-delay 3000
 *   pnpm --filter @smartops/api wa:fake-graph --templates hello_world,price_alert  (others → 132001)
 *
 * Point the API at it with WHATSAPP_GRAPH_BASE_URL=http://localhost:4010 in apps/api/.env.
 * Accepts the same WHATSAPP_ACCESS_TOKEN as the API; signs status webhooks with
 * WHATSAPP_APP_SECRET and posts them to the API webhook.
 */
import { parseArgs } from "node:util";
import { pino } from "pino";
import { loadEnv } from "../../src/config/env.js";
import {
  createFakeGraph,
  type FaultSpec,
  type FaultStatus,
  type FaultTarget,
} from "./fake-graph.js";
import { createMediaStore } from "./media-store.js";

const FAULT_TARGETS: FaultTarget[] = ["media-info", "download", "send", "subscribed-apps"];
const FAULT_STATUSES: FaultStatus[] = [401, 404, 429, 500, 503];

const { values } = parseArgs({
  options: {
    port: { type: "string", default: "4010" },
    host: { type: "string", default: "127.0.0.1" },
    "status-delay": { type: "string", default: "1000" },
    "status-flow": { type: "string", default: "sent,delivered,read" },
    "fail-send": { type: "string" },
    "outside-window": { type: "boolean", default: false },
    templates: { type: "string", default: "hello_world" },
    fault: { type: "string", multiple: true, default: [] },
    latency: { type: "string", default: "0" },
    "sha-format": { type: "string", default: "hex" },
    "webhook-url": { type: "string" },
  },
});

const logger = pino({
  level: "info",
  base: { service: "fake-graph" },
  transport: { target: "pino-pretty", options: { colorize: true, ignore: "pid,hostname" } },
});

const faults: Partial<Record<FaultTarget, FaultSpec>> = {};
for (const spec of values.fault) {
  const [target, status] = spec.split(":");
  const isCorrupt = target === "download" && status === "corrupt";
  if (
    !FAULT_TARGETS.includes(target as FaultTarget) ||
    (!isCorrupt && !FAULT_STATUSES.includes(Number(status) as FaultStatus))
  ) {
    logger.fatal(
      `invalid --fault "${spec}" (use ${FAULT_TARGETS.join("|")}:${FAULT_STATUSES.join("|")}, or download:corrupt)`,
    );
    process.exit(1);
  }
  faults[target as FaultTarget] = isCorrupt ? "corrupt" : (Number(status) as FaultStatus);
}

const statusFlow = values["status-flow"].split(",").map((s) => s.trim());
if (!statusFlow.every((s) => ["sent", "delivered", "read"].includes(s))) {
  logger.fatal("--status-flow accepts sent,delivered,read");
  process.exit(1);
}

const env = loadEnv();
const fake = createFakeGraph({
  business: {
    phoneNumberId: env.WHATSAPP_PHONE_NUMBER_ID,
    wabaId: env.WHATSAPP_WABA_ID,
    displayPhoneNumber: "15550000000",
  },
  accessToken: env.WHATSAPP_ACCESS_TOKEN,
  appSecret: env.WHATSAPP_APP_SECRET,
  webhookUrl: values["webhook-url"] ?? `http://localhost:${env.PORT}/api/v1/webhooks/whatsapp`,
  mediaStore: createMediaStore(),
  logger,
  statusDelayMs: Number(values["status-delay"]),
  statusFlow: statusFlow as ("sent" | "delivered" | "read")[],
  failSendCode: values["fail-send"] ? Number(values["fail-send"]) : null,
  outsideWindow: values["outside-window"],
  templates: values.templates
    .split(",")
    .map((t) => t.trim())
    .filter(Boolean),
  faults,
  latencyMs: Number(values.latency),
  shaFormat: values["sha-format"] === "base64" ? "base64" : "hex",
});

const url = await fake.listen(Number(values.port), values.host);
logger.info(
  { faults, statusFlow, failSend: values["fail-send"] ?? null },
  `fake Graph API on ${url}`,
);
if (
  env.WHATSAPP_GRAPH_BASE_URL !== url.replace("127.0.0.1", "localhost") &&
  env.WHATSAPP_GRAPH_BASE_URL !== url
) {
  logger.warn(
    `the API uses WHATSAPP_GRAPH_BASE_URL=${env.WHATSAPP_GRAPH_BASE_URL}; set it to http://localhost:${values.port} in apps/api/.env to use this fake`,
  );
}

function stop(): void {
  fake.close().finally(() => process.exit(0));
}
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
