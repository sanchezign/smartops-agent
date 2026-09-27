import type { PrismaClient } from "../../common/db.js";

/**
 * Where an injected demo message is in the pipeline (phase 9 M8), for the "Probar el sistema"
 * timeline: received → file downloaded → transcribed / read → classified → processed →
 * outcome. Ids, statuses and counts only (the panel links to the screens).
 */
export function createDemoTraceRepository(prisma: PrismaClient) {
  return {
    async byWamid(wamid: string) {
      const message = await prisma.message.findUnique({
        where: { waMessageId: wamid },
        select: {
          id: true,
          conversationId: true,
          type: true,
          mediaFile: {
            select: {
              status: true,
              transcription: { select: { status: true } },
              documentConversion: { select: { status: true } },
            },
          },
          ingestionRuns: {
            orderBy: { createdAt: "desc" },
            take: 1,
            select: {
              id: true,
              status: true,
              classification: true,
              prefilterRule: true,
              errors: true,
              _count: { select: { priceChanges: true } },
            },
          },
        },
      });
      if (!message) return { received: false as const };
      const run = message.ingestionRuns[0] ?? null;
      const [pendingReviews, createdProducts] = run
        ? await Promise.all([
            prisma.reviewItem.count({ where: { ingestionRunId: run.id, status: "pending" } }),
            prisma.priceChange.count({ where: { ingestionRunId: run.id, oldPrice: null } }),
          ])
        : [0, 0];
      return {
        received: true as const,
        message: { id: message.id, conversationId: message.conversationId, type: message.type },
        media: message.mediaFile
          ? {
              status: message.mediaFile.status,
              transcription: message.mediaFile.transcription?.status ?? null,
              conversion: message.mediaFile.documentConversion?.status ?? null,
            }
          : null,
        run: run
          ? {
              id: run.id,
              status: run.status,
              classification: run.classification,
              prefilterRule: run.prefilterRule,
              reason: (run.errors as { reason?: string } | null)?.reason ?? null,
              priceChanges: run._count.priceChanges - createdProducts,
              createdProducts,
              pendingReviews,
            }
          : null,
      };
    },
  };
}
export type DemoTraceRepository = ReturnType<typeof createDemoTraceRepository>;
