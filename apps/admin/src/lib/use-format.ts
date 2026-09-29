"use client";

import { useLocale } from "next-intl";
import { useMemo } from "react";
import { createFormat, type Formatter } from "./format";

/** The panel's formatter in the language being shown (phase 13). */
export function useFormat(): Formatter {
  const locale = useLocale();
  return useMemo(() => createFormat(locale), [locale]);
}
