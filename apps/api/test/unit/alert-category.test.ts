import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { AlertType } from "../../src/generated/prisma/enums.js";
import {
  ALERT_CATEGORIES,
  ALERT_CATEGORY,
  alertCategory,
  alertTypesIn,
} from "../../src/modules/admin/alert-category.js";

/** Panel triage of alerts (phase 15, ADR-032): where each alert type is shown. */

describe("alert category", () => {
  it("classifies every alert type of the schema, and nothing else", () => {
    expect(Object.keys(ALERT_CATEGORY).sort()).toEqual(Object.values(AlertType).sort());
    for (const type of Object.values(AlertType)) {
      expect(ALERT_CATEGORIES).toContain(alertCategory(type));
    }
  });

  it("is the table of ADR-032", () => {
    expect(ALERT_CATEGORY).toEqual({
      manual_attention: "action",
      possible_opt_out: "action",
      price_change: "info",
      low_stock: "info",
      missing_data: "info",
      integration_error: "technical",
      ingestion_error: "technical",
    });
  });

  it("splits the types into the three categories without overlap", () => {
    const all = ALERT_CATEGORIES.flatMap((c) => alertTypesIn(c));
    expect(all.sort()).toEqual(Object.values(AlertType).sort());
    expect(alertTypesIn("action").sort()).toEqual(["manual_attention", "possible_opt_out"]);
    expect(alertTypesIn("technical").sort()).toEqual(["ingestion_error", "integration_error"]);
  });

  /**
   * missing_data and ingestion_error are classified without any producer (ADR-032). If code
   * starts creating them, this fails so the classification is revisited on purpose.
   */
  it("missing_data and ingestion_error are still not produced by the API", () => {
    const src = fileURLToPath(new URL("../../src/", import.meta.url));
    const offenders: string[] = [];
    const walk = (dir: string) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const path = join(dir, entry.name);
        if (entry.isDirectory()) {
          if (entry.name !== "generated") walk(path);
        } else if (/\.ts$/.test(entry.name) && !path.endsWith("alert-category.ts")) {
          if (/["'](missing_data|ingestion_error)["']/.test(readFileSync(path, "utf8"))) {
            offenders.push(path);
          }
        }
      }
    };
    walk(src);
    expect(offenders).toEqual([]);
  });
});
