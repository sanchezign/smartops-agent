import type { NextConfig } from "next";
import { serverEnv } from "./src/env";

const { API_PROXY_TARGET } = serverEnv();

const nextConfig: NextConfig = {
  poweredByHeader: false,
  // Same origin without Caddy (local dev, or deploy option A): the browser calls /api/* on the
  // panel's own origin and Next forwards it, so the refresh cookie stays first-party
  // (SameSite=Strict). In option D Caddy routes /api before it ever reaches Next.
  async rewrites() {
    return API_PROXY_TARGET
      ? [{ source: "/api/:path*", destination: `${API_PROXY_TARGET}/api/:path*` }]
      : [];
  },
};

export default nextConfig;
