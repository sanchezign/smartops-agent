import { readFileSync } from "node:fs";

/** Raw bytes of a WhatsApp fixture (exactly as Meta would send them — sign these). */
export function whatsappFixture(name: string): Buffer {
  return readFileSync(new URL(`../fixtures/whatsapp/${name}.json`, import.meta.url));
}

export function whatsappFixtureJson(name: string): unknown {
  return JSON.parse(whatsappFixture(name).toString("utf8"));
}
