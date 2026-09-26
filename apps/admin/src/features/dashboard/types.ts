/** GET /api/v1/admin/dashboard (phase 9 M1). Money = Decimal strings. */
export interface DashboardData {
  timeZone: string;
  days: number;
  messages: { day: string; count: number }[];
  runs: {
    automatic: number;
    neededPerson: number;
    failed: number;
    inProgress: number;
    automationRate: number | null;
  };
  prefilter: { total: number; byRule: { rule: string; count: number }[]; savedUsd: string };
  ai: {
    byDay: { day: string; usd: string }[];
    totalUsd: string;
    todayUsd: string;
    budgetTotalUsd: string;
    budgetDailyUsd: string;
  };
  errors: {
    failedWebhooks: number;
    failedDeliveries: number;
    failedRuns: number;
    failedOutbound: number;
    openIntegrationAlerts: number;
  };
  pending: { reviews: number; openAlerts: number; humanConversations: number };
}

/** Why a message never reached the LLM (pre-filter rules, phase 6). */
export const PREFILTER_RULE_LABEL: Record<string, string> = {
  no_price_signal: "Saludos y charla",
  customer_contact: "Clientes (consulta o pedido)",
  non_content_type: "Stickers, reacciones, ubicaciones",
  media_unavailable: "Archivo no disponible",
  audio_too_long: "Audios largos (para escuchar)",
  audio_not_transcribed: "Audios sin transcribir",
};
