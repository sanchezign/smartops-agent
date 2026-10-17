"use client";

import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useCallback } from "react";
import { withParam } from "./url-filters";

/**
 * One filter kept in the URL (url-filters.ts says what may go there). The setter REPLACES the history
 * entry and keeps the scroll; null removes the param. The page needs a <Suspense> (useSearchParams).
 */
export function useUrlParam(key: string): [string | null, (value: string | null) => void] {
  const params = useSearchParams();
  const pathname = usePathname();
  const router = useRouter();
  const set = useCallback(
    (value: string | null) =>
      router.replace(`${pathname}${withParam(params.toString(), key, value)}`, { scroll: false }),
    [router, pathname, params, key],
  );
  return [params.get(key), set];
}
