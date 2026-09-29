/**
 * Captions of the demo video (phase 13 M6), one per step, in English and Spanish. The recording
 * with captions (README GIF) draws the English line in the page; the clean recording (MP4 for
 * YouTube and clients) gets them as subtitle files (.en.srt / .es.srt) with the measured times.
 * Spanish is neutral ("tú"), like the panel.
 */
export const CAPTIONS = {
  login: {
    en: "The public demo: sign in as the shared operator.",
    es: "La demo pública: entra como el operador compartido.",
  },
  dashboard: {
    en: "The dashboard: messages, automation, AI cost and what needs a person.",
    es: "El inicio: mensajes, automatización, costo de IA y lo que necesita a una persona.",
  },
  photo: {
    en: "A supplier sends a photo of a printed price list…",
    es: "Un proveedor envía una foto de una lista de precios impresa…",
  },
  pipeline: {
    en: "…and the real pipeline reads it: download, classify, extract, check the rules.",
    es: "…y el sistema real la lee: descarga, clasifica, extrae y revisa las reglas.",
  },
  catalog: {
    en: "Prices are updated on their own, with their history.",
    es: "Los precios se actualizan solos, con su historial.",
  },
  sheet: {
    en: "A spreadsheet in a new format stops for a person…",
    es: "Una planilla con un formato nuevo espera a una persona…",
  },
  column: {
    en: "…who picks the price column once. Next time it is read without AI.",
    es: "…que elige la columna de precio una sola vez. La próxima vez se lee sin IA.",
  },
  chat: {
    en: "People can take over any chat: the bot pauses for that contact.",
    es: "Una persona puede tomar cualquier chat: el bot se pausa para ese contacto.",
  },
  language: {
    en: "Every screen in English or Spanish.",
    es: "Cada pantalla en inglés o en español.",
  },
} as const;

export type CaptionId = keyof typeof CAPTIONS;
export type CaptionLanguage = "en" | "es";

/** "00:01:02,345" (SubRip). */
export function srtTime(ms: number): string {
  const pad = (n: number, width = 2) => String(Math.floor(n)).padStart(width, "0");
  return `${pad(ms / 3_600_000)}:${pad((ms / 60_000) % 60)}:${pad((ms / 1000) % 60)},${pad(ms % 1000, 3)}`;
}

/** SubRip text from measured steps (each caption lasts until the next one starts). */
export function toSrt(
  steps: { id: CaptionId; at: number }[],
  endAt: number,
  language: CaptionLanguage,
): string {
  return steps
    .map((step, i) => {
      const end = steps[i + 1]?.at ?? endAt;
      return `${i + 1}\n${srtTime(step.at)} --> ${srtTime(end)}\n${CAPTIONS[step.id][language]}\n`;
    })
    .join("\n");
}
