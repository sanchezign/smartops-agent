import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { WORKFLOW_FILES } from "../../scripts/n8n/sanitize.js";
import { createOrchestrator } from "../../src/modules/demo/demo-orchestrator.js";
import type { N8nWorkflow } from "../helpers/n8n-contract-check.js";
import { runExportedWorkflows, type Respond, type TraceEntry } from "../helpers/n8n-exec.js";

/**
 * Parity (ADR-025): the public demo plays the n8n workflows in-process. For every kind of
 * message, the EXPORTED workflows (n8n/workflows/*.json, run by test/helpers/n8n-exec.ts) and the
 * orchestrator must make the same internal API calls — same routes, same bodies, same order, same
 * waits. If someone changes a workflow (or the orchestrator) without the other, this fails.
 */

const DIR = new URL("../../../../n8n/workflows/", import.meta.url);
const load = (file: string) => JSON.parse(readFileSync(new URL(file, DIR), "utf8")) as N8nWorkflow;
const byTitle = Object.fromEntries(
  Object.entries(WORKFLOW_FILES).map(([title, file]) => [title, load(file)]),
);
const workflows = {
  receiver: byTitle["SmartOps · Receptor"]!,
  processor: byTitle["SmartOps · Procesador"]!,
  notifier: byTitle["SmartOps · Notificador"]!,
  errors: byTitle["SmartOps · Errores"]!,
};

const MSG = "01a0dc63-e4b1-716c-a982-fbceaa90e2bb";
const RUN = "01a0dc63-e4b1-716c-a982-fbceaa90e2ba";

interface Scenario {
  name: string;
  classification: string | null | undefined;
  /** Statuses answered by /extract, then by each GET /runs/:id (the last one repeats). */
  extractStatuses?: string[];
}

const scenarios: Scenario[] = [
  {
    name: "partial price update",
    classification: "price_update_partial",
    extractStatuses: ["extracted"],
  },
  { name: "full price list", classification: "price_list_full", extractStatuses: ["extracted"] },
  {
    name: "media without a label (classification null)",
    classification: null,
    extractStatuses: ["extracted"],
  },
  { name: "customer query", classification: "customer_query" },
  { name: "internal order", classification: "internal_order" },
  { name: "other", classification: "other" },
  {
    name: "extraction still running, then done",
    classification: "price_update_partial",
    extractStatuses: ["extracting", "extracting", "extracted"],
  },
  {
    name: "extraction ends in review (neither extracted nor extracting)",
    classification: "price_update_partial",
    extractStatuses: ["failed"],
  },
  {
    name: "extraction never finishes (30 polls, then it notifies anyway)",
    classification: "price_update_partial",
    extractStatuses: ["extracting"],
  },
];

function scriptedApi(s: Scenario): Respond {
  let extractAnswers = 0;
  const statuses = s.extractStatuses ?? ["extracted"];
  const next = () => statuses[Math.min(extractAnswers++, statuses.length - 1)]!;
  return (method, path) => {
    if (path === "/classify") {
      return { messageId: MSG, status: "classified", classification: s.classification, runId: RUN };
    }
    if (path === "/extract") return { runId: RUN, status: next() };
    if (method === "GET" && path === `/runs/${RUN}`) return { runId: RUN, status: next() };
    if (path === "/catalog/ingest") return { runId: RUN, status: "ingested" };
    return {};
  };
}

async function orchestratorTrace(s: Scenario): Promise<TraceEntry[]> {
  const respond = scriptedApi(s);
  const trace: TraceEntry[] = [];
  const orchestrator = createOrchestrator({
    call: async (method, path, body) => {
      trace.push({ call: `${method} ${path}`, ...(body !== undefined ? { body } : {}) });
      return respond(method, path, body);
    },
    sleep: async () => {
      trace.push({ wait: true });
    },
    logger: { info() {}, warn() {}, error() {} },
  });
  await orchestrator.handle({ messageId: MSG });
  return trace;
}

describe("orchestrator parity with the exported n8n workflows", () => {
  for (const s of scenarios) {
    it(s.name, async () => {
      const exported = runExportedWorkflows(workflows, { messageId: MSG }, scriptedApi(s));
      expect(await orchestratorTrace(s)).toEqual(exported);
    });
  }

  it("the scenarios cover every call the workflows can make", () => {
    const calls = new Set<string>();
    for (const s of scenarios) {
      for (const e of runExportedWorkflows(workflows, { messageId: MSG }, scriptedApi(s))) {
        if ("call" in e) calls.add(e.call);
      }
    }
    expect([...calls].sort()).toEqual(
      [
        "GET /runs/01a0dc63-e4b1-716c-a982-fbceaa90e2ba",
        "POST /catalog/ingest",
        "POST /classify",
        "POST /extract",
        "POST /messages/ack",
        "POST /notifications",
      ].sort(),
    );
  });

  it("a failing step is reported like the error workflow (and only once)", async () => {
    const calls: string[] = [];
    const orchestrator = createOrchestrator({
      call: async (method, path, body) => {
        calls.push(`${method} ${path}`);
        if (path === "/classify") return { classification: "price_update_partial", runId: RUN };
        if (path === "/extract") throw new Error("boom");
        if (path === "/n8n/errors")
          expect(body).toMatchObject({ workflow: "SmartOps · Procesador" });
        return {};
      },
      sleep: async () => {},
      logger: { info() {}, warn() {}, error() {} },
    });
    await orchestrator.handle({ messageId: MSG });
    expect(calls.filter((c) => c === "POST /n8n/errors")).toHaveLength(1);
    expect(calls.filter((c) => c === "POST /extract")).toHaveLength(3); // 3 tries, like n8n
  });
});
