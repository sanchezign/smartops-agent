import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Logger } from "../../common/logger.js";
import { signWhatsAppBody } from "../whatsapp/whatsapp-signature.js";
import { demoVoiceNoteOgg } from "./demo-audio.js";
import { DEMO_SAMPLE_SENDERS } from "./demo-data.js";
import type { DemoMediaStore } from "./demo-graph.js";
import { buildInboundMessage, type SimBusiness, type SimMessage } from "./wa-payloads.js";

/**
 * "Probar el sistema" (phase 9 M8, ADR-021): each button builds a message exactly like Meta
 * would send it and POSTs it SIGNED to our own webhook — the real pipeline from there on
 * (signature check, outbox, worker, media download from the demo Graph API, transcription,
 * n8n, extraction with recorded outputs, catalog, reviews), live in the panel.
 */

export const DEMO_SAMPLE_KINDS = [
  "foto",
  "pdf",
  "audio",
  "planilla",
  "planilla_nueva",
  "injection",
] as const;
export type DemoSampleKind = (typeof DEMO_SAMPLE_KINDS)[number];

const XLSX = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

interface Sample {
  sender: keyof typeof DEMO_SAMPLE_SENDERS;
  media?: {
    file?: string;
    bytes?: () => Uint8Array;
    mimeType: string;
    filename: string | null;
    voice?: boolean;
  };
  type: "text" | "image" | "document" | "audio";
  text?: string;
}

const SAMPLES: Record<DemoSampleKind, Sample> = {
  foto: {
    sender: "demo",
    type: "image",
    media: { file: "lista-precios-foto.jpg", mimeType: "image/jpeg", filename: null },
  },
  pdf: {
    sender: "demo",
    type: "document",
    media: {
      file: "lista-prueba.pdf",
      mimeType: "application/pdf",
      filename: "Lista de precios septiembre.pdf",
    },
  },
  audio: {
    sender: "demo",
    type: "audio",
    media: {
      bytes: () => demoVoiceNoteOgg(),
      mimeType: "audio/ogg; codecs=opus",
      filename: null,
      voice: true,
    },
  },
  planilla: {
    sender: "ejemplo",
    type: "document",
    media: {
      file: "precios-multiples-diciembre.xlsx",
      mimeType: XLSX,
      filename: "Lista diciembre.xlsx",
    },
  },
  planilla_nueva: {
    sender: "mayorista",
    type: "document",
    media: {
      file: "precios-multiples.xlsx",
      mimeType: XLSX,
      filename: "Precios Mayorista del Este.xlsx",
    },
  },
  injection: { sender: "demo", type: "text", text: "injection-message.txt" },
};

export function createDemoInjector(options: {
  assetsDir: string;
  store: DemoMediaStore;
  business: SimBusiness;
  webhook: { url: string; appSecret: string };
  logger: Logger;
}) {
  const cache = new Map<string, Uint8Array>();
  const asset = (file: string) => {
    let bytes = cache.get(file);
    if (!bytes) {
      bytes = new Uint8Array(readFileSync(join(options.assetsDir, "assets", file)));
      cache.set(file, bytes);
    }
    return bytes;
  };

  return {
    async inject(kind: DemoSampleKind): Promise<{ wamid: string }> {
      const sample = SAMPLES[kind];
      const sender = DEMO_SAMPLE_SENDERS[sample.sender];
      let message: SimMessage;
      if (sample.type === "text") {
        message = { type: "text", body: new TextDecoder().decode(asset(sample.text!)).trim() };
      } else {
        const m = sample.media!;
        const bytes = m.bytes ? m.bytes() : asset(m.file!);
        const id = options.store.put({ bytes, mimeType: m.mimeType, filename: m.filename });
        message = {
          type: sample.type,
          media: {
            id,
            mimeType: m.mimeType,
            // The WEBHOOK carries base64 (the media API returns hex), like real Meta.
            sha256: createHash("sha256").update(bytes).digest("base64"),
            filename: m.filename,
            ...(m.voice ? { voice: true } : {}),
          },
        };
      }
      const { wamid, payload } = buildInboundMessage(
        options.business,
        { waId: sender.waId, bsuid: null, name: sender.contactName },
        message,
      );
      const raw = JSON.stringify(payload);
      const res = await fetch(options.webhook.url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-hub-signature-256": signWhatsAppBody(raw, options.webhook.appSecret),
        },
        body: raw,
        signal: AbortSignal.timeout(10_000),
      });
      if (!res.ok) throw new Error(`demo webhook answered ${res.status}`);
      options.logger.info({ kind }, "demo sample injected");
      return { wamid };
    },
  };
}
export type DemoInjector = ReturnType<typeof createDemoInjector>;
