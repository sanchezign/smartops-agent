"use client";

import { useTheme } from "next-themes";
import { useEffect } from "react";
import { themeColorFor } from "@/lib/theme-color";

/** Keeps the browser UI colour on the theme chosen in the user menu, not only the OS one (phase 16 M6a). */
export function ThemeColorSync() {
  const { theme, resolvedTheme } = useTheme();
  useEffect(() => {
    for (const meta of document.querySelectorAll<HTMLMetaElement>('meta[name="theme-color"]')) {
      meta.content = themeColorFor(resolvedTheme, theme, meta.getAttribute("media"));
    }
  }, [theme, resolvedTheme]);
  return null;
}
