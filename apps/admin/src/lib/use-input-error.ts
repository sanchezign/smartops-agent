"use client";

import { useTranslations } from "next-intl";
import { useCallback } from "react";
import type { InputError } from "./number-input";
import { useFormat } from "./use-format";

/** An input error code (+ params) → the sentence in the panel language (phase 13). */
export function useInputErrorText() {
  const t = useTranslations("inputErrors");
  const { formatNumber, weekdayName } = useFormat();
  return useCallback(
    (error: InputError) => {
      const params = Object.fromEntries(
        Object.entries(error.params ?? {}).map(([k, v]) => [
          k,
          typeof v !== "number"
            ? v
            : k === "day"
              ? weekdayName(v)
              : formatNumber(v, { maximumFractionDigits: 4 }),
        ]),
      );
      return t(error.code, params);
    },
    [t, formatNumber, weekdayName],
  );
}
