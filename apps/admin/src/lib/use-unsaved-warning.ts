"use client";

import { useEffect } from "react";

/**
 * While `dirty`, reloading or closing the tab asks first (the browser's own dialog; its text cannot be
 * changed). Links inside the panel are not intercepted (phase 16 M6a, owner: beforeunload only).
 */
export function useUnsavedWarning(dirty: boolean) {
  useEffect(() => {
    if (!dirty) return;
    const onBeforeUnload = (event: BeforeUnloadEvent) => event.preventDefault();
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => window.removeEventListener("beforeunload", onBeforeUnload);
  }, [dirty]);
}
