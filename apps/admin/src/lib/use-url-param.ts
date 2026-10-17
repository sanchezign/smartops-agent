"use client";

import { usePathname, useSearchParams } from "next/navigation";
import { useCallback } from "react";
import { withParam } from "./url-filters";

/**
 * One filter kept in the URL (url-filters.ts says what may go there). The setter REPLACES the history
 * entry and keeps the scroll; null removes the param. The page needs a <Suspense> (useSearchParams).
 * It uses the native History API, which Next.js syncs with useSearchParams WITHOUT a server round trip:
 * no page reads the filters on the server, and router.replace re-requested the route each time (and Next
 * took the <title> out for ~300 ms meanwhile; phase 16, measured on WebKit).
 */
export function useUrlParam(key: string): [string | null, (value: string | null) => void] {
  const params = useSearchParams();
  const pathname = usePathname();
  const set = useCallback(
    (value: string | null) =>
      window.history.replaceState(
        null,
        "",
        `${pathname}${withParam(params.toString(), key, value)}`,
      ),
    [pathname, params, key],
  );
  return [params.get(key), set];
}
