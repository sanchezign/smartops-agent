import { Prisma } from "../../src/generated/prisma/client.js";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { applyPercentage, PCT_TOLERANCE } from "../../src/modules/catalog/price-math.js";
import { normalizeSupplierName } from "../../src/modules/catalog/supplier-name.js";
import type { MessageStatus } from "../../src/generated/prisma/enums.js";
import { neutralize } from "../../src/modules/notifications/digest-rules.js";
import { isOpen, nextOpening } from "../../src/modules/settings/business-hours.js";
import type { BusinessHours } from "../../src/modules/settings/settings.schemas.js";
import { businessHoursSchema } from "../../src/modules/settings/settings.schemas.js";
import { parsePrice } from "../../src/modules/sheets/sheet-values.js";
import {
  customerServiceWindow,
  CUSTOMER_SERVICE_WINDOW_MS,
  WINDOW_SAFETY_MARGIN_MS,
} from "../../src/modules/whatsapp/customer-service-window.js";
import { canTransition } from "../../src/modules/whatsapp/message-status.js";
import {
  isValidWhatsAppSignature,
  signWhatsAppBody,
} from "../../src/modules/whatsapp/whatsapp-signature.js";
import { detectComplianceEvent } from "../../src/modules/optout/optout-detector.js";

/**
 * Properties (phase 10 M7, fast-check 4.10.2): rules that must hold for EVERY input, not only
 * for the examples in the other tests. fast-check shrinks a failure to its smallest input and
 * prints the seed; re-run it with `fc.assert(…, { seed, path })`. Run counts are kept moderate
 * so the fast suite stays fast (more runs locally: FC_RUNS=5000).
 */

const Decimal = Prisma.Decimal;
type Decimal = Prisma.Decimal;
const RUNS = Number(process.env.FC_RUNS ?? 300);
const opts = { numRuns: RUNS };

/** A positive price as a plain decimal string: up to 9 integer digits, 0–4 decimals. */
const priceArb = fc
  .tuple(fc.integer({ min: 0, max: 999_999_999 }), fc.integer({ min: 0, max: 4 }), fc.nat(9_999))
  .map(([int, dp, frac]) => {
    const f = String(frac).padStart(4, "0").slice(0, dp);
    return new Decimal(dp ? `${int}.${f}` : String(int));
  })
  .filter((d) => d.gt(0));

const groupThousands = (int: string, sep: string) => int.replace(/\B(?=(\d{3})+(?!\d))/g, sep);

describe("spreadsheet prices (sheet-values.parsePrice)", () => {
  it("es-UY text (1.234,56 — with or without grouping, with currency marks) reads back exactly", () => {
    fc.assert(
      fc.property(
        priceArb,
        fc.boolean(),
        fc.constantFrom("", "$ ", "$U ", "U$S ", " UYU"),
        (d, group, mark) => {
          const [int, frac] = d.toFixed().split(".") as [string, string | undefined];
          const text = `${group ? groupThousands(int, ".") : int}${frac ? `,${frac}` : ""}`;
          const cell = mark.startsWith(" ") ? `${text}${mark}` : `${mark}${text}`;
          expect(parsePrice(cell, "decimal_comma")).toBe(d.toFixed());
        },
      ),
      opts,
    );
  });

  it("en text (1,234.56) in a decimal_dot table reads back exactly", () => {
    fc.assert(
      fc.property(priceArb, fc.boolean(), (d, group) => {
        const [int, frac] = d.toFixed().split(".") as [string, string | undefined];
        const text = `${group ? groupThousands(int, ",") : int}${frac ? `.${frac}` : ""}`;
        expect(parsePrice(text, "decimal_dot")).toBe(d.toFixed());
      }),
      opts,
    );
  });

  it("numeric cells are exact", () => {
    fc.assert(
      fc.property(priceArb, (d) => {
        expect(parsePrice({ n: d.toFixed() }, "decimal_comma")).toBe(d.toFixed());
      }),
      opts,
    );
  });

  it("any text: never throws; a result is always a positive plain decimal (never guessed wrong-looking)", () => {
    fc.assert(
      fc.property(
        fc.string({ maxLength: 30 }),
        fc.constantFrom("decimal_comma", "decimal_dot"),
        (s, f) => {
          const out = parsePrice(s, f as "decimal_comma");
          if (out !== null) {
            expect(out).toMatch(/^\d+(\.\d{1,4})?$/);
            expect(new Decimal(out).gt(0)).toBe(true);
          }
        },
      ),
      opts,
    );
  });

  it("a decimal-looking dot in a decimal_comma table is never read as decimals (12.50 → null)", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 999 }),
        fc.integer({ min: 1, max: 99 }),
        (int, cents) => {
          const two = String(cents).padStart(2, "0");
          expect(parsePrice(`${int}.${two}`, "decimal_comma")).toBeNull();
        },
      ),
      opts,
    );
  });
});

describe("percentage changes (price-math.applyPercentage)", () => {
  const pctArb = fc
    .integer({ min: -9_999, max: 100_000 })
    .filter((n) => n !== 0)
    .map((n) => new Decimal(n).dividedBy(100)); // -99.99 … +1000.00, 2 decimals

  it("direction, 2–4 decimals, and the stated % within 0.1 pp unless 4 decimals were needed", () => {
    fc.assert(
      fc.property(priceArb, pctArb, (current, pct) => {
        const next = applyPercentage(current, pct);
        const dp = next.decimalPlaces();
        expect(dp).toBeLessThanOrEqual(4);
        if (pct.gt(0)) expect(next.gte(current)).toBe(true);
        else expect(next.lte(current)).toBe(true);
        const effective = next.minus(current).dividedBy(current).times(100);
        const within = effective.minus(pct).abs().lte(PCT_TOLERANCE);
        // Below 1 (e.g. 0.0001) 4 decimals may not express the % exactly: that is the documented cap.
        if (current.gte(1)) expect(within).toBe(true); // real prices: always within tolerance
      }),
      opts,
    );
  });
});

describe("supplier names (normalizeSupplierName)", () => {
  it("idempotent, lowercase ASCII words, single spaces", () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 60 }), (name) => {
        const once = normalizeSupplierName(name);
        expect(normalizeSupplierName(once)).toBe(once);
        expect(once).toMatch(/^([a-z0-9]+( [a-z0-9]+)*)?$/);
      }),
      opts,
    );
  });

  it("case, accents and punctuation never change the match", () => {
    const word = fc.constantFrom(
      "distribuidora",
      "ferretería",
      "Núñez",
      "del",
      "Este",
      "SUR",
      "Hnos",
    );
    fc.assert(
      fc.property(
        fc.array(word, { minLength: 1, maxLength: 4 }),
        fc.constantFrom(".", ",", " - ", "  "),
        (words, sep) => {
          const plain = words.join(" ");
          expect(normalizeSupplierName(words.join(sep).toUpperCase())).toBe(
            normalizeSupplierName(plain),
          );
          expect(
            normalizeSupplierName(plain.normalize("NFD").replace(/[\u0300-\u036f]/g, "")),
          ).toBe(normalizeSupplierName(plain));
        },
      ),
      opts,
    );
  });
});

describe("outbound statuses (message-status): Meta's at-least-once, out-of-order deliveries", () => {
  const RANK: Record<string, number> = { pending: 0, sent: 1, delivered: 2, read: 3 };
  const statusArb = fc.constantFrom<MessageStatus>("sent", "delivered", "read", "failed");

  const fold = (events: MessageStatus[]) => {
    let s: MessageStatus = "pending";
    const trail: MessageStatus[] = [s];
    for (const e of events) {
      if (canTransition(s, e)) s = e;
      trail.push(s);
    }
    return { final: s, trail };
  };

  it("never goes backwards; read is never undone; failed is final", () => {
    fc.assert(
      fc.property(fc.array(statusArb, { maxLength: 12 }), (events) => {
        const { trail } = fold(events);
        for (let i = 1; i < trail.length; i += 1) {
          const [a, b] = [trail[i - 1]!, trail[i]!];
          if (a === "failed") expect(b).toBe("failed");
          if (a === "read") expect(b).toBe("read");
          if (a !== "failed" && b !== "failed") expect(RANK[b]!).toBeGreaterThanOrEqual(RANK[a]!);
        }
      }),
      opts,
    );
  });

  it("without failures, the result does not depend on the order (the furthest status wins)", () => {
    const ok = fc.constantFrom<MessageStatus>("sent", "delivered", "read");
    fc.assert(
      fc.property(
        fc
          .array(ok, { minLength: 1, maxLength: 8 })
          .chain((a) => fc.tuple(fc.constant(a), fc.shuffledSubarray(a, { minLength: a.length }))),
        ([a, b]) => {
          expect(fold(a).final).toBe(fold(b).final);
          const best = a.reduce(
            (m, s) => (RANK[s]! > RANK[m]! ? s : m),
            "pending" as MessageStatus,
          );
          expect(fold(a).final).toBe(best);
        },
      ),
      opts,
    );
  });
});

describe("24 h customer service window", () => {
  const t = fc.integer({ min: 1_600_000_000_000, max: 2_000_000_000_000 });
  it("open exactly while now < last inbound + 24 h − 2 min, and once closed it stays closed", () => {
    fc.assert(
      fc.property(
        t,
        fc.integer({ min: -3_600_000, max: 3 * 86_400_000 }),
        fc.nat(86_400_000),
        (last, delta, later) => {
          const now = new Date(last + delta);
          const w = customerServiceWindow(new Date(last), now);
          const limit = last + CUSTOMER_SERVICE_WINDOW_MS - WINDOW_SAFETY_MARGIN_MS;
          expect(w.open).toBe(now.getTime() < limit);
          expect(w.closesAt?.getTime()).toBe(limit);
          if (!w.open)
            expect(
              customerServiceWindow(new Date(last), new Date(now.getTime() + later)).open,
            ).toBe(false);
        },
      ),
      opts,
    );
  });
});

describe("business hours (quiet hours of the digests)", () => {
  const hhmm = fc
    .tuple(fc.integer({ min: 0, max: 23 }), fc.constantFrom(0, 15, 30, 45))
    .map(([h, m]) => `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`);
  const rule = fc
    .record({ day: fc.integer({ min: 0, max: 6 }), open: hhmm, close: hhmm })
    .filter((r) => r.open !== r.close);
  const hoursArb: fc.Arbitrary<BusinessHours> = fc
    .record({
      timeZone: fc.constantFrom(
        "America/Montevideo",
        "Europe/Madrid",
        "America/New_York",
        "America/Santiago",
        "UTC",
      ),
      days: fc.array(rule, { minLength: 1, maxLength: 5 }),
    })
    .filter((h) => businessHoursSchema.safeParse(h).success);
  const instant = fc
    .integer({ min: Date.UTC(2026, 0, 1), max: Date.UTC(2027, 11, 31) })
    .map((ms) => new Date(ms));

  // Intl time-zone math is slow: the timeout grows with FC_RUNS.
  it(
    "the next opening is now when open; otherwise later, open, and nothing opens in between",
    { timeout: Math.max(5_000, RUNS * 5) },
    () => {
      fc.assert(
        fc.property(hoursArb, instant, (hours, at) => {
          const next = nextOpening(hours, at);
          expect(next).not.toBeNull();
          if (isOpen(hours, at)) {
            expect(next!.getTime()).toBe(at.getTime());
            return;
          }
          expect(next!.getTime()).toBeGreaterThan(at.getTime());
          expect(next!.getTime() - at.getTime()).toBeLessThanOrEqual(8 * 86_400_000);
          expect(isOpen(hours, next!)).toBe(true);
          // Sampled minutes before the opening are all closed.
          for (let k = 1; k <= 6; k += 1) {
            const probe = new Date(at.getTime() + ((next!.getTime() - at.getTime()) * k) / 7);
            expect(isOpen(hours, new Date(Math.floor(probe.getTime() / 60_000) * 60_000))).toBe(
              false,
            );
          }
        }),
        opts,
      );
    },
  );
});

describe("digest snippets (neutralize)", () => {
  it("bounded, single line, no links, no formatting marks, no bidi / zero-width tricks", () => {
    fc.assert(
      fc.property(
        fc.string({ maxLength: 200, unit: "grapheme-composite" }),
        fc.integer({ min: 5, max: 80 }),
        (text, max) => {
          const out = neutralize(text, max);
          expect(out.length).toBeLessThanOrEqual(max);
          expect(out).not.toMatch(/[\n\r\t*_~`«»\u200b-\u200f\u202a-\u202e\u2066-\u2069]/);
          expect(out).not.toMatch(/https?:\/\/|www\./i);
          expect(neutralize(out, max)).toBe(out); // idempotent
        },
      ),
      opts,
    );
  });

  it("links anywhere in the text never survive", () => {
    fc.assert(
      fc.property(
        fc.string({ maxLength: 40 }),
        fc.webUrl(),
        fc.string({ maxLength: 40 }),
        (a, url, b) => {
          expect(neutralize(`${a} ${url} ${b}`, 500)).not.toContain(url);
        },
      ),
      opts,
    );
  });
});

describe("webhook signature (X-Hub-Signature-256)", () => {
  const SECRET = "app-secret-for-properties-0123456789";
  const body = fc.uint8Array({ minLength: 0, maxLength: 2_000 }).map((a) => Buffer.from(a));

  it("any body signed with the app secret verifies (hex in any case)", () => {
    fc.assert(
      fc.property(body, fc.boolean(), (raw, upper) => {
        const header = signWhatsAppBody(raw, SECRET);
        const sent = upper ? `sha256=${header.slice(7).toUpperCase()}` : header;
        expect(isValidWhatsAppSignature(raw, sent, SECRET)).toBe(true);
      }),
      opts,
    );
  });

  it("one flipped bit in the body or in the signature, or another secret → rejected", () => {
    fc.assert(
      fc.property(
        body.filter((b) => b.length > 0),
        fc.nat(),
        fc.nat(),
        (raw, i, j) => {
          const header = signWhatsAppBody(raw, SECRET);
          const tampered = Buffer.from(raw);
          tampered[i % tampered.length]! ^= 1 << (j % 8);
          expect(isValidWhatsAppSignature(tampered, header, SECRET)).toBe(false);
          const hex = header.slice(7).split("");
          const k = j % hex.length;
          hex[k] = hex[k] === "0" ? "1" : "0";
          expect(isValidWhatsAppSignature(raw, `sha256=${hex.join("")}`, SECRET)).toBe(false);
          expect(isValidWhatsAppSignature(raw, header, `${SECRET}x`)).toBe(false);
        },
      ),
      opts,
    );
  });

  it("any other header value is rejected without throwing", () => {
    fc.assert(
      fc.property(body, fc.string({ maxLength: 80 }), (raw, header) => {
        fc.pre(!/^sha256=[0-9a-f]{64}$/i.test(header));
        expect(isValidWhatsAppSignature(raw, header, SECRET)).toBe(false);
      }),
      opts,
    );
  });
});

describe("opt-out keywords (case, accents, spacing, polite filler)", () => {
  const keywords = {
    optOut: ["BAJA", "STOP", "CANCELAR", "UNSUBSCRIBE"],
    optIn: ["ALTA", "START"],
  };
  const randomCase = (w: string, mask: boolean[]) =>
    [...w].map((c, i) => (mask[i % mask.length] ? c.toUpperCase() : c.toLowerCase())).join("");
  const accent: Record<string, string> = { a: "á", e: "é", i: "í", o: "ó", u: "ú" };

  it("a keyword alone, however it is typed, is an opt-out (or opt-in)", () => {
    fc.assert(
      fc.property(
        fc.constantFrom("baja", "stop", "cancelar", "alta", "start"),
        fc.array(fc.boolean(), { minLength: 1, maxLength: 8 }),
        fc.boolean(),
        fc.constantFrom("", "!", ".", " ", "  ", "!!"),
        fc.constantFrom("", "por favor ", "gracias "),
        (word, mask, accents, punct, filler) => {
          const typed = accents ? word.replace(/[aeiou]/, (v) => accent[v]!) : word;
          const text = `${filler}  ${randomCase(typed, mask)}${punct} `;
          const expected = ["alta", "start"].includes(word) ? "opt_in" : "opt_out";
          expect(detectComplianceEvent(text, keywords)?.kind).toBe(expected);
        },
      ),
      opts,
    );
  });

  it("a keyword inside an ordinary sentence is never an automatic opt-out", () => {
    fc.assert(
      fc.property(
        fc.constantFrom("la baja de precios", "stop de mercadería", "quiero cancelar el pedido 4"),
        fc.constantFrom("", " de hoy", " del mes que viene"),
        (sentence, tail) => {
          expect(detectComplianceEvent(`${sentence}${tail}`, keywords)?.kind).not.toBe("opt_out");
        },
      ),
      opts,
    );
  });
});

/**
 * FIXED (phase 10, found by the business-hours property during mutation testing, user request
 * 2026-09-27): an opening time inside a DST gap does not exist on the spring-forward day.
 * `zonedTimeToUtc` now scans forward to the first valid instant when the requested local time
 * was skipped, so `nextOpening` never returns a closed instant. Regression cases below (kept
 * even though the property above now covers every zone/time, since these are the exact
 * shrunk counterexamples that found the bug).
 */
describe("business hours: DST gaps never produce a closed 'next opening'", () => {
  it("New York: 02:00 does not exist on 2026-03-08 (clocks jump to 03:00)", () => {
    const hours: BusinessHours = {
      timeZone: "America/New_York",
      days: [{ day: 0, open: "02:00", close: "00:00" }],
    };
    const at = new Date("2026-03-02T05:00:00.000Z"); // Monday 00:00 EST, closed
    const next = nextOpening(hours, at)!;
    expect(isOpen(hours, next)).toBe(true);
    expect(next.toISOString()).toBe("2026-03-08T07:00:00.000Z"); // = 03:00 EDT, the resume instant
  });

  it("Santiago (Southern Hemisphere): the gap is in September, not March", () => {
    const hours: BusinessHours = {
      timeZone: "America/Santiago",
      days: [{ day: 0, open: "00:30", close: "23:00" }], // Sunday 2026-09-06: 00:00-01:00 skipped
    };
    const at = new Date("2026-08-31T03:00:00.000Z"); // the previous Sunday, closed at that hour
    const next = nextOpening(hours, at)!;
    expect(isOpen(hours, next)).toBe(true);
    expect(next.toISOString()).toBe("2026-09-06T04:00:00.000Z"); // = 01:00 local, the resume instant
  });

  it("Madrid: 02:00-03:00 does not exist on the last Sunday of March", () => {
    const hours: BusinessHours = {
      timeZone: "Europe/Madrid",
      days: [{ day: 0, open: "02:30", close: "23:00" }],
    };
    // 2026-03-29 is the spring-forward Sunday in the EU.
    const at = new Date("2026-03-22T12:00:00.000Z");
    const next = nextOpening(hours, at)!;
    expect(isOpen(hours, next)).toBe(true);
  });
});
