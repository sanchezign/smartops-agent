/**
 * wa:simulate — sends signed WhatsApp webhooks to the local API, like Meta would.
 *
 *   pnpm --filter @smartops/api wa:simulate text --text "Lista: tornillo 6mm $12"
 *   pnpm --filter @smartops/api wa:simulate document --file ./lista.pdf --caption "Lista"
 *   pnpm --filter @smartops/api wa:simulate audio --file ./nota.ogg
 *   pnpm --filter @smartops/api wa:simulate status --wamid <wamid> --status failed --code 131030
 *   pnpm --filter @smartops/api wa:simulate fixture message-image
 *   pnpm --filter @smartops/api wa:simulate help
 *
 * Common options: --from <phone> --name <name> --bsuid-only --username <u> --duplicate
 *                 --target <webhook url> --sha-format hex|base64
 * Reads apps/api/.env (App Secret, phone number id, WABA id). Media files are stored in
 * apps/api/.sim/media so `wa:fake-graph` can serve them to the API.
 */
import { readFileSync } from "node:fs";
import { basename } from "node:path";
import { parseArgs } from "node:util";
import { pino } from "pino";
import { maskPhone } from "../../src/common/phone.js";
import { loadEnv } from "../../src/config/env.js";
import { fakeBsuidFor } from "./ids.js";
import {
  createMediaStore,
  formatSha256,
  messageTypeForMime,
  mimeFromFilename,
} from "./media-store.js";
import {
  buildInboundMessage,
  buildStatus,
  type SimBusiness,
  type SimContact,
  type SimMessage,
  type SimStatusValue,
} from "./payloads.js";
import { postSignedWebhook } from "./webhook-client.js";

const USAGE = `wa:simulate <command> [options]

Commands:
  text         --text <body>
  interactive  --text <button title>
  image | document | audio | video | media   --file <path> [--caption <c>] [--mime <m>]
  status       --wamid <id> --status sent|delivered|read|played|failed [--code <meta code>]
  fixture      <name> (file in test/fixtures/whatsapp, without .json) [--raw]

Options:
  --from <digits>      sender phone (default 59899000111, a fake number)
  --name <name>        profile name (default "Proveedor Simulado")
  --username <u>       WhatsApp username
  --bsuid-only         omit the phone number (user with a username)
  --duplicate          send the same body twice (dedupe check)
  --target <url>       webhook URL (default http://localhost:$PORT/api/v1/webhooks/whatsapp)
  --sha-format hex|base64   media sha256 format in the webhook (default hex)
  --raw                fixture: do not rewrite phone_number_id to yours
`;

const logger = pino({
  level: "info",
  base: { service: "wa-simulate" },
  transport: { target: "pino-pretty", options: { colorize: true, ignore: "pid,hostname,service" } },
});

const { positionals, values } = parseArgs({
  allowPositionals: true,
  options: {
    text: { type: "string" },
    file: { type: "string" },
    caption: { type: "string" },
    mime: { type: "string" },
    wamid: { type: "string" },
    status: { type: "string" },
    code: { type: "string" },
    from: { type: "string", default: "59899000111" },
    name: { type: "string", default: "Proveedor Simulado" },
    username: { type: "string" },
    "bsuid-only": { type: "boolean", default: false },
    duplicate: { type: "boolean", default: false },
    target: { type: "string" },
    "sha-format": { type: "string", default: "hex" },
    raw: { type: "boolean", default: false },
  },
});

const [command, arg] = positionals;
if (!command || command === "help") {
  process.stdout.write(USAGE);
  process.exit(command ? 0 : 1);
}

const env = loadEnv();
const target = values.target ?? `http://localhost:${env.PORT}/api/v1/webhooks/whatsapp`;
const business: SimBusiness = {
  phoneNumberId: env.WHATSAPP_PHONE_NUMBER_ID,
  wabaId: env.WHATSAPP_WABA_ID,
  displayPhoneNumber: "15550000000",
};
const phone = values.from.replace(/\D/g, "");
const contact: SimContact = {
  waId: values["bsuid-only"] ? null : phone,
  bsuid: fakeBsuidFor(phone),
  name: values.name,
  username: values.username ?? null,
};

function fail(message: string): never {
  logger.error(message);
  process.stdout.write(`\n${USAGE}`);
  process.exit(1);
}

function buildMedia(type: string): SimMessage {
  if (!values.file) fail(`${type} needs --file <path>`);
  const bytes = readFileSync(values.file);
  const filename = basename(values.file);
  const mimeType = values.mime ?? mimeFromFilename(filename);
  if (!mimeType) fail(`unknown extension for ${filename}: pass --mime`);
  const mediaType = type === "media" ? messageTypeForMime(mimeType) : type;
  const shaFormat = values["sha-format"] === "base64" ? "base64" : "hex";
  const stored = createMediaStore().register(bytes, { mimeType, filename });
  logger.info(
    { mediaFileSize: stored.size, mimeType, type: mediaType },
    "media registered for wa:fake-graph",
  );
  return {
    type: mediaType as "image" | "document" | "audio" | "video" | "sticker",
    media: {
      id: stored.id,
      mimeType,
      sha256: formatSha256(stored.sha256Hex, shaFormat),
      filename,
      caption: values.caption ?? null,
      ...(mediaType === "audio" ? { voice: /ogg|opus/.test(mimeType) } : {}),
    },
  };
}

function rewritePhoneNumberId(payload: unknown): unknown {
  const p = payload as {
    entry?: { changes?: { value?: { metadata?: Record<string, string> } }[] }[];
  };
  for (const entry of p.entry ?? []) {
    for (const change of entry.changes ?? []) {
      if (change.value?.metadata) change.value.metadata.phone_number_id = business.phoneNumberId;
    }
  }
  return payload;
}

function buildPayload(): { payload: unknown; wamid?: string } {
  switch (command) {
    case "text":
      if (!values.text) fail("text needs --text <body>");
      return buildInboundMessage(business, contact, { type: "text", body: values.text });
    case "interactive":
      return buildInboundMessage(business, contact, {
        type: "interactive",
        title: values.text ?? "Confirmar pedido",
      });
    case "image":
    case "document":
    case "audio":
    case "video":
    case "media":
      return buildInboundMessage(business, contact, buildMedia(command));
    case "status": {
      if (!values.wamid) fail("status needs --wamid <id>");
      const status = (values.status ?? "delivered") as SimStatusValue;
      if (!["sent", "delivered", "read", "played", "failed"].includes(status)) {
        fail(`invalid --status ${status}`);
      }
      const code = values.code ? Number(values.code) : undefined;
      return {
        wamid: values.wamid,
        payload: buildStatus(business, {
          wamid: values.wamid,
          status: code !== undefined ? "failed" : status,
          recipient: contact,
          ...(code !== undefined ? { errors: [{ code }] } : {}),
        }),
      };
    }
    case "fixture": {
      if (!arg) fail("fixture needs a name, e.g. `fixture message-image`");
      const url = new URL(`../../test/fixtures/whatsapp/${arg}.json`, import.meta.url);
      const payload: unknown = JSON.parse(readFileSync(url, "utf8"));
      return { payload: values.raw ? payload : rewritePhoneNumberId(payload) };
    }
    default:
      fail(`unknown command "${command}"`);
  }
}

const { payload, wamid } = buildPayload();
const deliveries = values.duplicate ? 2 : 1;
let ok = true;
for (let i = 1; i <= deliveries; i += 1) {
  try {
    const result = await postSignedWebhook(target, payload, env.WHATSAPP_APP_SECRET);
    ok &&= result.status === 200;
    logger.info(
      {
        command,
        delivery: `${i}/${deliveries}`,
        httpStatus: result.status,
        ...(wamid ? { wamid } : {}),
        from: contact.waId ? maskPhone(contact.waId) : "(BSUID only)",
      },
      result.status === 200 ? "webhook accepted" : `webhook rejected: ${result.body}`,
    );
  } catch (err) {
    ok = false;
    logger.error({ err, target }, "could not reach the API (is `pnpm dev` running?)");
    break;
  }
}
process.exitCode = ok ? 0 : 1;
