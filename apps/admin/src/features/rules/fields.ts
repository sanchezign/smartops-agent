/**
 * The no-code rules of the panel (phase 9 M6): which settings are shown, grouped, with the
 * same limits the API validates (apps/api/src/modules/settings/settings.schemas.ts). The API
 * re-validates every value; these only give early, plain-language feedback.
 */

export type Field =
  | { key: string; kind: "switch"; label: string; help: string }
  | {
      key: string;
      kind: "number";
      label: string;
      help: string;
      suffix?: string;
      min?: number;
      max?: number;
      integer?: boolean;
      /** Empty input = null (e.g. low stock alert off). */
      nullable?: boolean;
    }
  | { key: string; kind: "keywords"; label: string; help: string }
  | { key: string; kind: "phones"; label: string; help: string }
  | { key: "businessHours"; kind: "hours"; label: string; help: string };

export interface Section {
  id: string;
  title: string;
  description: string;
  fields: Field[];
}

export const SECTIONS: Section[] = [
  {
    id: "bot",
    title: "Respuestas automáticas",
    description: "Qué contesta el sistema solo, sin que intervenga una persona.",
    fields: [
      {
        key: "bot.autoRepliesEnabled",
        kind: "switch",
        label: "El bot responde a los contactos",
        help: "Apagado, no le contesta a nadie (como si todos los chats estuvieran atendidos por una persona). Las listas se siguen procesando y el equipo sigue recibiendo avisos.",
      },
      {
        key: "bot.supplierAck",
        kind: "switch",
        label: "Confirmar a los proveedores que recibimos su lista",
        help: 'Manda un "Recibimos tu lista" con el resumen de lo que se aplicó.',
      },
      {
        key: "coexistence.humanTakeoverMinutes",
        kind: "number",
        label: "Cuando responde una persona, el bot se pausa",
        help: "En ese chat, durante este tiempo desde el último mensaje de la persona.",
        suffix: "minutos",
        min: 1,
        max: 10080,
        integer: true,
      },
    ],
  },
  {
    id: "hours",
    title: "Horario de atención",
    description:
      'Fuera de horario, los resúmenes por WhatsApp que no son urgentes esperan a la apertura y el panel muestra "fuera de horario". Los avisos críticos salen igual.',
    fields: [
      {
        key: "businessHours",
        kind: "hours",
        label: "Días y horas",
        help: "Hora de Uruguay. Si el cierre es antes que la apertura, el horario sigue al día siguiente.",
      },
    ],
  },
  {
    id: "prices",
    title: "Precios",
    description: "Cuándo un cambio de precio se aplica solo, cuándo avisa y cuándo pide revisión.",
    fields: [
      {
        key: "catalog.priceAlertPct",
        kind: "number",
        label: "Avisar cuando un precio cambia",
        help: "Se aplica igual, pero se crea una alerta y entra en el resumen del equipo.",
        suffix: "% o más",
        min: 0,
        max: 100000,
      },
      {
        key: "catalog.maxIncreasePct",
        kind: "number",
        label: "Aumentos mayores a esto van a revisión",
        help: "No se aplican hasta que una persona los apruebe.",
        suffix: "%",
        min: 0.01,
        max: 100000,
      },
      {
        key: "catalog.maxDecreasePct",
        kind: "number",
        label: "Bajas mayores a esto van a revisión",
        help: "Una baja muy grande suele ser un error de tipeo.",
        suffix: "%",
        min: 0.01,
        max: 100,
      },
      {
        key: "catalog.lowStockThreshold",
        kind: "number",
        label: "Avisar con stock bajo",
        help: "Cuando el proveedor informa este stock o menos. Vacío = no avisar.",
        suffix: "unidades o menos",
        min: 0,
        integer: true,
        nullable: true,
      },
      {
        key: "catalog.autoCreateProducts",
        kind: "switch",
        label: "Crear productos nuevos automáticamente",
        help: "Si la IA está segura de que es un producto nuevo. Apagado, todo producto nuevo pasa por revisión.",
      },
      {
        key: "catalog.reactivateOnQuote",
        kind: "switch",
        label: "Reactivar productos cuando vuelven a cotizarse",
        help: "Un producto no disponible vuelve a estar disponible si llega en una lista.",
      },
    ],
  },
  {
    id: "team",
    title: "Avisos al equipo por WhatsApp",
    description: "Pocos mensajes y solo con lo que requiere acción.",
    fields: [
      {
        key: "notifications.whatsappRecipients",
        kind: "phones",
        label: "Números que reciben los resúmenes",
        help: "Con código de país, sin + ni espacios (por ejemplo 59899123456). Hasta 10. Tienen que haberle escrito antes al número de la empresa.",
      },
      {
        key: "notifications.digestWindowMinutes",
        kind: "number",
        label: "Agrupar los avisos de",
        help: "Todo lo que pase en ese lapso llega en un solo mensaje.",
        suffix: "minutos",
        min: 1,
        max: 240,
        integer: true,
      },
      {
        key: "notifications.maxPerHour",
        kind: "number",
        label: "Máximo de resúmenes por hora",
        help: "Lo que exceda se junta en el siguiente.",
        suffix: "por persona",
        min: 1,
        max: 60,
        integer: true,
      },
      {
        key: "notifications.criticalMaxPerHour",
        kind: "number",
        label: "Máximo de avisos críticos por hora",
        help: "Los errores graves no esperan el agrupado, hasta este límite.",
        suffix: "por persona",
        min: 0,
        max: 20,
        integer: true,
      },
    ],
  },
  {
    id: "contacts",
    title: "Audios y bajas",
    description: "Transcripción de notas de voz y pedidos de no recibir mensajes.",
    fields: [
      {
        key: "transcription.maxAutoDurationSeconds",
        kind: "number",
        label: "Transcribir audios de hasta",
        help: "Los más largos quedan para escuchar a mano (con una alerta).",
        suffix: "segundos",
        min: 10,
        max: 3600,
        integer: true,
      },
      {
        key: "optOut.keywords",
        kind: "keywords",
        label: "Palabras para darse de baja",
        help: "Si el mensaje es solo una de estas (sin importar mayúsculas ni tildes). Separalas con comas.",
      },
      {
        key: "optIn.keywords",
        kind: "keywords",
        label: "Palabras para volver a darse de alta",
        help: "Separalas con comas.",
      },
      {
        key: "optOut.instructionReminderDays",
        kind: "number",
        label: "Recordar cómo darse de baja cada",
        help: "Se agrega al primer mensaje automático y después como mucho con esta frecuencia.",
        suffix: "días",
        min: 1,
        max: 365,
        integer: true,
      },
    ],
  },
];

/** "baja, Stop ,, cancelar" → ["BAJA", "STOP", "CANCELAR"] (1–20 words of ≤ 40 chars). */
export function parseKeywords(
  raw: string,
): { ok: true; value: string[] } | { ok: false; message: string } {
  const words = [
    ...new Set(
      raw
        .split(",")
        .map((w) => w.trim().toUpperCase())
        .filter(Boolean),
    ),
  ];
  if (words.length === 0) return { ok: false, message: "Poné al menos una palabra." };
  if (words.length > 20) return { ok: false, message: "Como máximo 20 palabras." };
  if (words.some((w) => w.length > 40))
    return { ok: false, message: "Cada palabra, hasta 40 letras." };
  return { ok: true, value: words };
}

/** One number per line or comma; digits only (8–15), up to 10. */
export function parsePhones(
  raw: string,
): { ok: true; value: string[] } | { ok: false; message: string } {
  const numbers = [
    ...new Set(
      raw
        .split(/[\n,]/)
        .map((n) => n.replace(/[\s+\-()]/g, ""))
        .filter(Boolean),
    ),
  ];
  const bad = numbers.find((n) => !/^\d{8,15}$/.test(n));
  if (bad)
    return { ok: false, message: `"${bad}" no parece un número de WhatsApp con código de país.` };
  if (numbers.length > 10) return { ok: false, message: "Como máximo 10 números." };
  return { ok: true, value: numbers };
}
