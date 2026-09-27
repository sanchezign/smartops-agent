import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { CONTRACT_FILE, INTERNAL_PREFIX, renderContract } from "../../scripts/n8n/contract.js";
import { WORKFLOW_FILES } from "../../scripts/n8n/sanitize.js";
import { listRoutes } from "../../src/app.js";
import { messageReadyPayloadSchema } from "../../src/modules/integration/message-ready.js";
import { INTERNAL_ROUTE_SCHEMAS } from "../../src/modules/internal/internal.routes.js";
import { buildTestApp } from "../helpers/build-app.js";
import {
  checkN8nContract,
  type ContractCheckInput,
  type N8nWorkflow,
  type RouteSchemas,
} from "../helpers/n8n-contract-check.js";

/**
 * n8n contract (phase 10 M4): n8n/contract.json is generated from the code and must be fresh;
 * the internal routes table is exactly what the API mounts; and every HTTP node of the
 * EXPORTED workflows, dry-run with its real expressions, calls a contract route with a body
 * the API accepts. (Runtime side, over HTTP with a fake orchestrator: n8n-contract integration
 * test.)
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

const RUN = "01a0dc63-e4b1-716c-a982-fbceaa90e2ba";
const MSG = "01a0dc63-e4b1-716c-a982-fbceaa90e2bb";
const ID = "01a0dc63-e4b1-716c-a982-fbceaa90e2bc";
const routes: Record<string, RouteSchemas> = Object.fromEntries(
  Object.entries(INTERNAL_ROUTE_SCHEMAS).map(([key, s]) => {
    const [method, path] = key.split(" ");
    return [`${method} /internal${path}`, s as RouteSchemas];
  }),
);
const messageReady = messageReadyPayloadSchema.parse({
  version: 1,
  type: "message.ready",
  eventId: ID,
  messageId: MSG,
  conversationId: ID,
  contactId: ID,
  contactKind: "supplier",
  messageType: "document",
  receivedAt: "2026-09-27T12:00:00.000Z",
});
const input = (wfs = workflows): ContractCheckInput => ({
  workflows: wfs,
  routes,
  credential: "SmartOps API",
  messageReady,
  responses: {
    "POST /internal/classify": {
      runId: RUN,
      messageId: MSG,
      status: "classified",
      classification: "price_update_partial",
    },
    "POST /internal/extract": { runId: RUN, status: "extracted" },
    "GET /internal/runs/:id": { runId: RUN, status: "extracted" },
    "POST /internal/catalog/ingest": { runId: RUN, status: "ingested" },
  },
  // Error Trigger output (n8n docs, "Error Trigger node").
  errorTrigger: {
    execution: {
      id: "231",
      url: "https://n8n.example/execution/231",
      retryOf: null,
      error: { message: "Example Error Message", stack: "Stacktrace" },
      lastNodeExecuted: "Node With Error",
      mode: "manual",
    },
    workflow: { id: "1", name: "Example Workflow" },
  },
});
const clone = () => JSON.parse(JSON.stringify(workflows)) as typeof workflows;
const node = (wf: N8nWorkflow, name: string) => wf.nodes.find((n) => n.name === name)!;

describe("n8n contract", () => {
  it("n8n/contract.json is up to date (regenerate: pnpm --filter @smartops/api n8n:contract)", () => {
    expect(readFileSync(CONTRACT_FILE, "utf8")).toBe(renderContract());
  });

  it("the route table is exactly what the API mounts under /internal", () => {
    const mounted = listRoutes(buildTestApp())
      .filter((r) => r.includes(` ${INTERNAL_PREFIX}/`))
      .map((r) => r.replace(INTERNAL_PREFIX, ""))
      .sort();
    expect(mounted).toEqual(Object.keys(INTERNAL_ROUTE_SCHEMAS).sort());
  });

  it("every HTTP node of the exported workflows calls a contract route with a valid body", () => {
    const result = checkN8nContract(input());
    expect(result.problems).toEqual([]);

    const called = new Set(result.calls.map((c) => c.route));
    // Only GET /rules is not used by the workflows today (kept for the notifier's future rules).
    expect(Object.keys(routes).filter((r) => !called.has(r))).toEqual(["GET /internal/rules"]);

    // What the receiver and the processor hand to the notifier: every kind it must handle.
    const kinds = (result.subWorkflowInputs["SmartOps · Notificador"] ?? []).map((i) => i.kind);
    expect(new Set(kinds)).toEqual(new Set(["run", "customer_query", "order"]));
    expect(result.subWorkflowInputs["SmartOps · Procesador"]).toEqual([{ runId: RUN }]);
    // The supplier ack is only sent for lists (If node), and with the run id.
    expect(result.calls.filter((c) => c.route === "POST /internal/messages/ack")).toHaveLength(1);
  });

  describe("detects a workflow that breaks the contract", () => {
    const problemsAfter = (mutate: (w: ReturnType<typeof clone>) => void) => {
      const w = clone();
      mutate(w);
      return checkN8nContract(input(w)).problems.join("\n");
    };

    it("a renamed body field", () => {
      expect(
        problemsAfter((w) => {
          const p = node(w.receiver, "Clasificar").parameters;
          p.jsonBody = String(p.jsonBody).replace("messageId:", "msgId:");
        }),
      ).toMatch(/Clasificar: body .* rejected by the API/);
    });

    it("a path that is not a route", () => {
      expect(
        problemsAfter((w) => {
          const p = node(w.processor, "Extraer").parameters;
          p.url = String(p.url).replace("/internal/extract", "/internal/extraer");
        }),
      ).toMatch(/Extraer: POST \/internal\/extraer is not a route of the contract/);
    });

    it("the wrong method", () => {
      expect(
        problemsAfter((w) => {
          node(w.notifier, "Acuse al proveedor").parameters.method = "PUT";
        }),
      ).toMatch(/Acuse al proveedor: PUT \/internal\/messages\/ack is not a route/);
    });

    it("another credential", () => {
      expect(
        problemsAfter((w) => {
          node(w.errors, "Avisar al backend").credentials = { httpHeaderAuth: { name: "Otra" } };
        }),
      ).toMatch(/Avisar al backend: must authenticate with the "SmartOps API"/);
    });

    it("a notifier input the API would reject (a kind it does not know)", () => {
      expect(
        problemsAfter((w) => {
          const set = node(w.receiver, "Datos del pedido").parameters as {
            assignments: { assignments: { name: string; value: unknown }[] };
          };
          set.assignments.assignments.find((a) => a.name === "kind")!.value = "pedido";
        }),
      ).toMatch(/Registrar notificación: body .*"pedido".* rejected/);
    });

    it("a reference to a node that does not exist", () => {
      expect(
        problemsAfter((w) => {
          const p = node(w.processor, "Ingestar al catálogo").parameters;
          p.jsonBody = String(p.jsonBody).replace("Corrida a procesar", "Corrida");
        }),
      ).toMatch(/no sample output for node "Corrida"/);
    });
  });
});
