"use client";

import { useTranslations } from "next-intl";
import { markParams, splitMarked } from "../emphasis";
import type { Question } from "../question";

/** A review question with its values (names, amounts) in a heavier weight (ADR-033 §7). */
export function QuestionText({ question }: { question: Question }) {
  const t = useTranslations("reviews");
  const { marked, values } = markParams(question.params);
  const parts = splitMarked(t(`questions.${question.key}`, marked), values);
  return (
    <>
      {parts.map((part, i) =>
        part.strong ? (
          <strong key={i} className="font-semibold" translate="no">
            {part.text}
          </strong>
        ) : (
          part.text
        ),
      )}
    </>
  );
}
