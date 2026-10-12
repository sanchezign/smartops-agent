import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { LEGACY_ROUTES, legacyRedirects } from "../src/legacy-routes";

/** Old panel routes → current ones (phase 13: Spanish → English; phase 15: /reviews, /alerts). */

const app = resolve(import.meta.dirname, "../src/app/(main)");
const exists = (route: string) => existsSync(resolve(app, `.${route}`, "page.tsx"));

describe("legacy routes", () => {
  it("every target is a real panel route and no old route still exists", () => {
    for (const { from, to, sub } of LEGACY_ROUTES) {
      expect(exists(to), to).toBe(true);
      expect(exists(from), from).toBe(false);
      // A sub-path target is a dynamic route: /reviews/<id> is still the review's page.
      if (sub) expect(exists(`${sub}/[id]`), sub).toBe(true);
    }
    expect(exists("/reviews/[id]")).toBe(true); // a review's own page never moved
    expect(exists("/d/[token]")).toBe(true); // the digest link never changed
  });

  it("permanent redirects for the route and its sub-paths; the specific one first", () => {
    const redirects = legacyRedirects();
    expect(redirects.every((r) => r.permanent)).toBe(true);
    const sources = redirects.map((r) => r.source);
    expect(sources.indexOf("/conversaciones/bajas")).toBeLessThan(
      sources.indexOf("/conversaciones/:path*"),
    );
  });

  it("phase 15: the review list goes to To do, a review's page stays; alerts → Activity", () => {
    const redirects = legacyRedirects();
    const to = (source: string) => redirects.find((r) => r.source === source)?.destination;
    expect(to("/reviews")).toBe("/todo");
    expect(to("/reviews/:path*")).toBeUndefined(); // /reviews/<id> is a live page
    expect(to("/revisiones")).toBe("/todo"); // straight there, no chain
    expect(to("/revisiones/:path*")).toBe("/reviews/:path*");
    expect(to("/alerts")).toBe("/activity");
    expect(to("/alertas")).toBe("/activity");
  });
});
