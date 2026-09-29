import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { LEGACY_ROUTES, legacyRedirects } from "../src/legacy-routes";

/** Old Spanish panel routes → English ones (phase 13). */

const app = resolve(import.meta.dirname, "../src/app/(main)");
const exists = (route: string) => existsSync(resolve(app, `.${route}`, "page.tsx"));

describe("legacy routes", () => {
  it("every target is a real panel route and no old route still exists", () => {
    for (const [from, to] of LEGACY_ROUTES) {
      expect(exists(to), to).toBe(true);
      expect(exists(from), from).toBe(false);
    }
    expect(exists("/d/[token]")).toBe(true); // the digest link never changed
  });

  it("permanent redirects for the route and its sub-paths; the specific one first", () => {
    const redirects = legacyRedirects();
    expect(redirects.every((r) => r.permanent)).toBe(true);
    expect(redirects).toContainEqual({
      source: "/revisiones/:path*",
      destination: "/reviews/:path*",
      permanent: true,
    });
    const sources = redirects.map((r) => r.source);
    expect(sources.indexOf("/conversaciones/bajas")).toBeLessThan(
      sources.indexOf("/conversaciones/:path*"),
    );
  });
});
