import { resolve } from "node:path";
import type { NextConfig } from "next";
import createNextIntlPlugin from "next-intl/plugin";
import { serverEnv } from "./src/env";
import { legacyRedirects } from "./src/legacy-routes";

const { API_PROXY_TARGET } = serverEnv();

const nextConfig: NextConfig = {
  poweredByHeader: false,
  // Docker image (phase 11 M4): a self-contained server in .next/standalone, traced from the
  // monorepo root (pnpm links dependencies outside apps/admin). Only when NEXT_OUTPUT=standalone
  // (set by apps/admin/Dockerfile): on Windows without symlink rights the standalone copy step
  // fails, so local builds, `next dev` and the E2E (`next start`) keep the default output.
  ...(process.env.NEXT_OUTPUT === "standalone"
    ? { output: "standalone" as const, outputFileTracingRoot: resolve(process.cwd(), "../..") }
    : {}),
  // E2E builds into their own folder so they never clobber a running `next dev` (.next).
  ...(process.env.NEXT_DIST_DIR ? { distDir: process.env.NEXT_DIST_DIR } : {}),
  // Same origin without Caddy (local dev, or deploy option A): the browser calls /api/* on the
  // panel's own origin and Next forwards it, so the refresh cookie stays first-party
  // (SameSite=Strict). In option D Caddy routes /api before it ever reaches Next.
  // Phase 13: the Spanish routes of phases 9–12 redirect permanently to the English ones.
  async redirects() {
    return legacyRedirects();
  },
  async rewrites() {
    return API_PROXY_TARGET
      ? [{ source: "/api/:path*", destination: `${API_PROXY_TARGET}/api/:path*` }]
      : [];
  },
};

// next-intl (phase 13): request config in src/i18n/request.ts (the plugin's default path).
const withNextIntl = createNextIntlPlugin();

export default withNextIntl(nextConfig);
