"use client";

import { useEffect } from "react";

/**
 * The tab title names what the page shows ("Coarse sand · SmartOps") once the data has loaded; the
 * route's own metadata title ("Product · SmartOps") stays until then and comes back on the next route.
 * The data is fetched with the Bearer in the browser (ADR-018), so the server cannot set it.
 */
export function useDocumentTitle(name: string | null | undefined) {
  useEffect(() => {
    if (!name) return;
    const previous = document.title;
    document.title = `${name} · SmartOps`;
    return () => {
      document.title = previous;
    };
  }, [name]);
}
