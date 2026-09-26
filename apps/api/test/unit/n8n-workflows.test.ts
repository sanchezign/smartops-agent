import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { sanitizeWorkflow, WORKFLOW_FILES } from "../../scripts/n8n/sanitize.js";

/**
 * Static checks of n8n/workflows/*.json (phase 6 M4). They run on the drafts now and on
 * the versions the user exports from n8n later: the workflows must keep the backend
 * contract (only existing internal routes, Header Auth credentials by reference, no
 * secrets, no pinned data) — the runtime side of the contract is n8n-contract.test.ts.
 */

type Node = {
  name: string;
  type: string;
  parameters: Record<string, unknown>;
  credentials?: Record<string, { id: string; name: string }>;
};
type Workflow = {
  name: string;
  nodes: Node[];
  connections: Record<string, { main: { node: string }[][] }>;
  settings: Record<string, unknown>;
  pinData?: unknown;
};

const DIR = new URL("../../../../n8n/workflows/", import.meta.url);
const workflows = Object.entries(WORKFLOW_FILES).map(([name, file]) => {
  const raw = readFileSync(new URL(file, DIR), "utf8");
  return { name, file, raw, wf: JSON.parse(raw) as Workflow };
});
const byName = (name: string) => workflows.find((w) => w.name === name)!.wf;

/** Internal routes of the backend (src/modules/internal/internal.routes.ts). */
const ROUTES: ReadonlyArray<readonly [string, RegExp]> = [
  ["POST", /\/internal\/classify$/],
  ["POST", /\/internal\/extract$/],
  ["POST", /\/internal\/catalog\/ingest$/],
  ["GET", /\/internal\/runs\/\{\{.+\}\}$/],
  ["POST", /\/internal\/notifications$/],
  ["POST", /\/internal\/n8n\/errors$/],
  ["POST", /\/internal\/messages\/ack$/],
];

describe("n8n workflows (static contract)", () => {
  it("the four SmartOps workflows exist, without pinned data and without secrets", () => {
    for (const { file, wf, raw } of workflows) {
      expect(wf.name, file).toBe(
        Object.keys(WORKFLOW_FILES).find((k) => WORKFLOW_FILES[k] === file),
      );
      expect(wf.pinData, file).toBeUndefined();
      expect(raw, file).not.toMatch(/\$env\./); // config lives in the Config node
      expect(sanitizeWorkflow(wf as unknown as Record<string, unknown>).problems, file).toEqual([]);
    }
  });

  it("every HTTP node calls an existing internal route with the 'SmartOps API' Header Auth credential", () => {
    const httpNodes = workflows.flatMap(({ wf }) =>
      wf.nodes.filter((n) => n.type === "n8n-nodes-base.httpRequest"),
    );
    expect(httpNodes.length).toBeGreaterThanOrEqual(7);
    for (const node of httpNodes) {
      const url = String(node.parameters.url);
      const method = String(node.parameters.method ?? "GET");
      expect(url, node.name).toMatch(/^=\{\{ \$\('Config'\)\.first\(\)\.json\.apiBaseUrl \}\}/);
      expect(
        ROUTES.some(([m, re]) => m === method && re.test(url)),
        `${node.name} ${method} ${url}`,
      ).toBe(true);
      expect(node.parameters.authentication, node.name).toBe("genericCredentialType");
      expect(node.parameters.genericAuthType, node.name).toBe("httpHeaderAuth");
      expect(node.credentials?.httpHeaderAuth?.name, node.name).toBe("SmartOps API");
    }
  });

  it("the receiver webhook is protected by the shared secret and answers immediately", () => {
    const hook = byName("SmartOps · Receptor").nodes.find(
      (n) => n.type === "n8n-nodes-base.webhook",
    )!;
    expect(hook.parameters).toMatchObject({
      httpMethod: "POST",
      path: "smartops-message-ready",
      authentication: "headerAuth",
    });
    // "Immediately" is the default: n8n omits it from exports.
    expect(hook.parameters.responseMode ?? "onReceived").toBe("onReceived");
    expect(hook.credentials?.httpHeaderAuth?.name).toBe("SmartOps webhook secret");
  });

  it("every classification that needs a person reaches the Notificador with its kind (phase 8: no lost orders)", () => {
    const receiver = byName("SmartOps · Receptor");
    const ruta = receiver.nodes.find((n) => n.name === "Ruta")!;
    const rules = (
      ruta.parameters.rules as {
        values: { conditions: { conditions: { rightValue?: string }[] }; outputKey: string }[];
      }
    ).values;
    const expected: Record<string, string> = {
      customer_query: "customer_query",
      internal_order: "order",
    };
    for (const [classification, kind] of Object.entries(expected)) {
      const index = rules.findIndex((r) =>
        r.conditions.conditions.some((c) => c.rightValue === classification),
      );
      expect(index, `${classification} has a route`).toBeGreaterThanOrEqual(0);
      // Follow the route: Set node → Execute Workflow (Notificador).
      const setName = receiver.connections.Ruta!.main[index]![0]!.node;
      const set = receiver.nodes.find((n) => n.name === setName)!;
      const assignments = (
        set.parameters.assignments as { assignments: { name: string; value: string }[] }
      ).assignments;
      expect(assignments.find((a) => a.name === "kind")?.value, classification).toBe(kind);
      const execName = receiver.connections[setName]!.main[0]![0]!.node;
      const exec = receiver.nodes.find((n) => n.name === execName)!;
      expect(exec.type).toBe("n8n-nodes-base.executeWorkflow");
      expect((exec.parameters.workflowId as { cachedResultName?: string }).cachedResultName).toBe(
        "SmartOps · Notificador",
      );
    }
  });

  it("full vs partial is never decided in n8n: only the receiver looks at the classification", () => {
    for (const name of ["SmartOps · Procesador", "SmartOps · Notificador"]) {
      expect(JSON.stringify(byName(name)), name).not.toMatch(/classification|price_list_full/);
    }
  });

  it("connections point to existing nodes; every workflow but the error one has an error workflow setting", () => {
    for (const { file, wf } of workflows) {
      const names = new Set(wf.nodes.map((n) => n.name));
      for (const [from, out] of Object.entries(wf.connections)) {
        expect(names.has(from), `${file}: ${from}`).toBe(true);
        for (const branch of out.main)
          for (const target of branch)
            expect(names.has(target.node), `${file}: → ${target.node}`).toBe(true);
      }
      if (wf.name !== "SmartOps · Errores")
        expect(wf.settings, file).toHaveProperty("errorWorkflow");
    }
  });
});

describe("export sanitizer", () => {
  const exported = {
    name: "SmartOps · Receptor",
    active: true,
    versionId: "v",
    meta: { instanceId: "abc" },
    tags: [{ name: "x" }],
    pinData: { "Mensaje listo": [{ json: { body: { from: "59899123456" } } }] },
    staticData: { lastId: 3 },
    nodes: [
      {
        name: "Clasificar",
        type: "n8n-nodes-base.httpRequest",
        parameters: {},
        credentials: { httpHeaderAuth: { id: "12", name: "SmartOps API" } },
      },
    ],
    connections: {},
    settings: { executionOrder: "v1" },
  };

  it("drops pinned data, static data and metadata; keeps credential references only", () => {
    const { workflow, removed, problems } = sanitizeWorkflow(exported);
    expect(removed.sort()).toEqual(["meta", "pinData", "staticData", "tags", "versionId"]);
    expect(problems).toEqual([]);
    expect(JSON.stringify(workflow)).not.toContain("59899123456");
    expect(workflow).toMatchObject({
      active: false,
      nodes: [{ credentials: { httpHeaderAuth: { id: "12", name: "SmartOps API" } } }],
    });
  });

  it("refuses anything that looks like a secret", () => {
    const leak = (parameters: Record<string, unknown>) =>
      sanitizeWorkflow(
        { ...exported, nodes: [{ name: "X", type: "t", parameters }] },
        { secrets: ["my-internal-key-0123456789"] },
      ).problems;
    expect(leak({ note: "sk-ant-api03-abcdefghijklmnop" })).toContain("looks like a Anthropic key");
    expect(leak({ note: "EAAtest1234567890abcdefghij" })).toContain(
      "looks like a Meta access token",
    );
    expect(leak({ note: "value my-internal-key-0123456789" })).toContain(
      "contains a value from apps/api/.env",
    );
    expect(
      leak({
        headerParameters: { parameters: [{ name: "X-Internal-Api-Key", value: "plain" }] },
      })[0],
    ).toMatch(/literal X-Internal-Api-Key header/);
  });
});
