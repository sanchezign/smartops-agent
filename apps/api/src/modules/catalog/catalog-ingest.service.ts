import { errors } from "../../common/errors/app-error.js";
import type { Logger } from "../../common/logger.js";
import type { StoredExtraction } from "../extraction/ingestion.service.js";
import type { SettingsService } from "../settings/settings.service.js";
import type { CatalogSettings } from "../settings/settings.schemas.js";
import {
  supplierLockKey,
  toPlain,
  type CatalogRepository,
  type IngestContext,
} from "./catalog.repository.js";
import { planIngestion, type PlannedLine, type PlanWarning } from "./ingest-plan.js";
import { normalizeSupplierName } from "./supplier-name.js";
import { resolveSupplierInTx } from "./supplier-resolution.js";

/**
 * Catalog ingest (phase 5 M4): applies an extracted run to the supplier's catalog.
 * - Locked per run (extracted → ingesting, atomic): concurrent calls never apply twice;
 *   a finished run returns its stored report (idempotent).
 * - Supplier resolution (user rule 2026-09-25): contact already linked → that supplier;
 *   else the document's supplierName matched (normalized) with existing suppliers → link;
 *   no match → a supplier is created (supplierName, else the WhatsApp profile name) and
 *   linked, with an informative warning. Several matches → run gate unknown_supplier.
 * - planIngestion decides; the repository applies everything in ONE transaction under
 *   per-contact and per-supplier advisory locks.
 */

export type IngestWarning = PlanWarning | { code: SupplierWarningCode; message: string };
type SupplierWarningCode =
  "supplier_created" | "supplier_linked" | "supplier_name_mismatch" | "tax_basis_changed";

export interface IngestCounts {
  created: number;
  updated: number;
  unchanged: number;
  review: number;
  unavailableCandidates: number;
  globalChange: boolean;
  alerts: number;
  superseded: number;
}

export interface IngestResult {
  runId: string;
  status: string;
  supplierId: string | null;
  counts?: IngestCounts;
  pendingReviews: number;
  gate?: { kind: string };
  warnings: IngestWarning[];
}

/** ingestion_runs.report written by the ingest (Decimals as plain strings). */
export interface IngestReport {
  version: 1;
  settings?: CatalogSettings;
  supplier?: { id: string; name: string; created: boolean; linked: boolean };
  counts?: IngestCounts;
  lines?: {
    index: number;
    name: string;
    action: string;
    kind: string | null;
    reasons: string[];
    productId: string | null;
    oldPrice: string | null;
    newPrice: string | null;
    currency: string | null;
    changePct: string | null;
  }[];
  gate?: { kind: string; [key: string]: unknown };
  pendingReviews: number;
  warnings: IngestWarning[];
}

export interface CatalogIngestService {
  ingest(runId: string, log: Logger): Promise<IngestResult>;
}

function resultFromReport(ctx: IngestContext): IngestResult {
  const report = ctx.run.report as Partial<IngestReport> | null;
  return {
    runId: ctx.run.id,
    status: ctx.run.status,
    supplierId: ctx.run.supplierId,
    ...(report?.counts ? { counts: report.counts } : {}),
    pendingReviews: report?.pendingReviews ?? 0,
    ...(report?.gate ? { gate: { kind: report.gate.kind } } : {}),
    warnings: report?.warnings ?? [],
  };
}

function lineReport(line: PlannedLine, productId: string | null) {
  return {
    index: line.index,
    name: line.item.name,
    action: line.action,
    kind: line.kind,
    reasons: line.reasons,
    productId,
    oldPrice: toPlain(line.oldPrice),
    newPrice: toPlain(line.newPrice),
    currency: line.currency,
    changePct: toPlain(line.changePct),
  };
}

export function createCatalogIngestService(deps: {
  repository: CatalogRepository;
  settings: SettingsService;
  now?: () => Date;
}): CatalogIngestService {
  const now = deps.now ?? (() => new Date());

  return {
    async ingest(runId, log) {
      const ctx = await deps.repository.getIngestContext(runId);
      if (!ctx) throw errors.notFound("Ingestion run not found");
      switch (ctx.run.status) {
        case "ingested":
        case "rejected":
          return resultFromReport(ctx); // idempotent
        case "ingesting":
          throw errors.inProgress("Ingest already running for this run");
        case "needs_review":
          throw errors.conflict("The run waits for human review", {
            reviewItemIds: ctx.pendingGates.map((g) => g.id),
            kinds: ctx.pendingGates.map((g) => g.kind),
          });
        case "extracted":
          break;
        default:
          throw errors.notReady(`Run is ${ctx.run.status}: extract it first`);
      }
      const stored = ctx.run.rawExtraction as StoredExtraction | null;
      if (!stored?.output) throw errors.conflict("The run has no stored extraction");

      const settings = await deps.settings.getCatalogSettings(log);
      if (!(await deps.repository.claimForIngest(runId))) {
        const current = await deps.repository.getIngestContext(runId);
        if (current?.run.status === "ingesting")
          throw errors.inProgress("Ingest already running for this run");
        if (current && ["ingested", "rejected"].includes(current.run.status))
          return resultFromReport(current);
        throw errors.conflict(`Run is ${current?.run.status ?? "missing"}`);
      }

      const output = stored.output;
      try {
        const result = await deps.repository.transaction(async (tx) => {
          const warnings: IngestWarning[] = [];
          const at = now();

          // ─── Supplier ───
          const resolution = await resolveSupplierInTx(tx, ctx.contact, output.supplierName);
          if (resolution.status === "ambiguous") {
            await tx.createGate({
              runId,
              supplierId: null,
              kind: "unknown_supplier",
              reasons: ["ambiguous_supplier_name"],
              proposal: { supplierName: output.supplierName, candidates: resolution.candidates },
            });
            const report: IngestReport = {
              version: 1,
              gate: { kind: "unknown_supplier", supplierName: output.supplierName },
              pendingReviews: 1,
              warnings,
            };
            await tx.finishRun(runId, {
              status: "needs_review",
              supplierId: null,
              report: report as never,
            });
            return { status: "needs_review", supplierId: null, report };
          }
          const { supplierId, created, linked } = resolution;
          warnings.push(...resolution.warnings);

          await tx.lock(supplierLockKey(supplierId));
          const supplier = (await tx.getSupplier(supplierId))!;
          if (
            !linked &&
            output.supplierName &&
            normalizeSupplierName(output.supplierName) !== supplier.normalizedName
          ) {
            warnings.push({
              code: "supplier_name_mismatch",
              message: `El documento dice "${output.supplierName}" pero el contacto está vinculado a "${supplier.name}".`,
            });
          }
          const supplierInfo = { id: supplier.id, name: supplier.name, created, linked };

          // ─── Plan ───
          const catalog = await tx.loadCatalog(supplierId);
          const plan = planIngestion({
            output,
            refs: stored.refs,
            catalogTruncated: stored.catalogTruncated,
            catalog,
            settings,
            supplierTaxIncluded: supplier.taxIncluded,
            messageAt: ctx.messageAt,
            overrides: {
              acceptTaxChange: ctx.approvedGates.includes("tax_basis_changed"),
              forceReview: ctx.approvedGates.includes("suspicious_instructions"),
              documentIncomplete: stored.documentIncomplete === true,
            },
          });

          if (plan.gated) {
            await tx.createGate({
              runId,
              supplierId,
              kind: "tax_basis_changed",
              reasons: ["tax_basis_changed"],
              proposal: { previous: plan.gate.previous, current: plan.gate.current },
            });
            const report: IngestReport = {
              version: 1,
              settings,
              supplier: supplierInfo,
              gate: { ...plan.gate },
              pendingReviews: 1,
              warnings: [
                ...warnings,
                {
                  code: "tax_basis_changed",
                  message: `Cambio de base de IVA (${plan.gate.previous ? "con" : "sin"} IVA → ${plan.gate.current ? "con" : "sin"} IVA): la corrida espera revisión.`,
                },
              ],
            };
            await tx.finishRun(runId, {
              status: "needs_review",
              supplierId,
              report: report as never,
            });
            return { status: "needs_review", supplierId, report };
          }

          const applied = await tx.applyPlan({
            runId,
            messageId: ctx.run.messageId,
            messageAt: ctx.messageAt,
            supplierId,
            lines: plan.lines,
            catalogReviews: plan.catalogReviews,
            globalChange: plan.globalChange,
            taxIncluded: plan.taxIncluded,
            listCurrency: output.currency,
            catalog,
            now: at,
          });
          const count = (action: string) => plan.lines.filter((l) => l.action === action).length;
          const counts: IngestCounts = {
            created: count("create"),
            updated: count("update"),
            unchanged: count("unchanged"),
            review: count("review"),
            unavailableCandidates: plan.catalogReviews.length,
            globalChange: plan.globalChange !== null,
            alerts: applied.alerts,
            superseded: applied.superseded,
          };
          const report: IngestReport = {
            version: 1,
            settings,
            supplier: supplierInfo,
            counts,
            lines: plan.lines.map((l) => lineReport(l, applied.lines[l.index]?.productId ?? null)),
            pendingReviews: applied.reviewItems,
            warnings: [...warnings, ...plan.warnings],
          };
          await tx.finishRun(runId, { status: "ingested", supplierId, report: report as never });
          return { status: "ingested", supplierId, report };
        });

        log.info(
          {
            runId,
            status: result.status,
            supplierId: result.supplierId,
            counts: result.report.counts,
            pendingReviews: result.report.pendingReviews,
          },
          "catalog ingest finished",
        );
        return {
          runId,
          status: result.status,
          supplierId: result.supplierId,
          ...(result.report.counts ? { counts: result.report.counts } : {}),
          pendingReviews: result.report.pendingReviews,
          ...(result.report.gate ? { gate: { kind: result.report.gate.kind } } : {}),
          warnings: result.report.warnings,
        };
      } catch (err) {
        await deps.repository.releaseIngest(runId);
        throw err;
      }
    },
  };
}
