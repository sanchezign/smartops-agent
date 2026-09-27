import type { z } from "zod";

/**
 * Checks the exported n8n workflows against the backend's contract (phase 10 M4) by
 * "dry-running" them: each workflow gets its trigger input (the message.ready payload, the
 * sub-workflow inputs the caller workflows build, an Error Trigger sample), its Set nodes are
 * evaluated, and every HTTP Request node's method, URL, credential and JSON body are computed
 * from its REAL n8n expressions and validated with the SAME Zod schemas the API uses.
 *
 * Supported expression surface (what our workflows use): `={{ … }}` values and `{{ … }}`
 * inside strings; `$('Node').first().json`, `$json`. A new construct fails loudly ("add a
 * sample") instead of passing silently. The workflows are our own files: evaluating their
 * expressions in a test is fine.
 */

export type N8nNode = {
  name: string;
  type: string;
  parameters: Record<string, unknown>;
  credentials?: Record<string, { name: string }>;
};
export type N8nWorkflow = {
  name: string;
  nodes: N8nNode[];
  connections: Record<string, { main: { node: string }[][] }>;
};
export type RouteSchemas = { body?: z.ZodType; params?: z.ZodType };

export interface ContractCheckInput {
  workflows: Record<"receiver" | "processor" | "notifier" | "errors", N8nWorkflow>;
  /** "METHOD /internal/path" → schemas (INTERNAL_ROUTE_SCHEMAS with the /internal prefix). */
  routes: Record<string, RouteSchemas>;
  credential: string;
  /** What the webhook node receives from the backend (a message.ready payload). */
  messageReady: Record<string, unknown>;
  /** Sample API responses, by route key (what `$json` is after that HTTP node). */
  responses: Record<string, Record<string, unknown>>;
  errorTrigger: Record<string, unknown>;
}

export interface ContractCheckResult {
  problems: string[];
  /** Every route called, with the workflow and node. */
  calls: { route: string; workflow: string; node: string }[];
  /** Inputs handed to each sub-workflow (by its name). */
  subWorkflowInputs: Record<string, Record<string, unknown>[]>;
}

type Outputs = Map<string, unknown>;

function evaluate(value: unknown, outputs: Outputs, json: unknown): unknown {
  if (typeof value !== "string" || !value.startsWith("=")) return value;
  const text = value.slice(1);
  const $ = (name: string) => {
    if (!outputs.has(name)) throw new Error(`no sample output for node "${name}"`);
    const data = outputs.get(name);
    return { first: () => ({ json: data }), item: { json: data } };
  };
  const run = (expr: string): unknown =>
    (new Function("$", "$json", `return (${expr});`) as (a: unknown, b: unknown) => unknown)(
      $,
      json,
    );
  const trimmed = text.trim();
  if (
    trimmed.startsWith("{{") &&
    trimmed.endsWith("}}") &&
    trimmed.indexOf("}}") === trimmed.length - 2
  ) {
    return run(trimmed.slice(2, -2));
  }
  return text.replace(/\{\{([\s\S]*?)\}\}/g, (_m, expr: string) => String(run(expr)));
}

function setNodeOutput(node: N8nNode, outputs: Outputs, json: unknown): Record<string, unknown> {
  const params = node.parameters as {
    assignments?: { assignments?: { name: string; value: unknown }[] };
    includeOtherFields?: boolean;
  };
  const out: Record<string, unknown> =
    params.includeOtherFields && json && typeof json === "object" ? { ...json } : {};
  for (const a of params.assignments?.assignments ?? [])
    out[a.name] = evaluate(a.value, outputs, json);
  return out;
}

function routeMatch(
  routes: Record<string, RouteSchemas>,
  method: string,
  path: string,
): { key: string; params: Record<string, string> } | null {
  for (const key of Object.keys(routes)) {
    const [m, pattern] = key.split(" ") as [string, string];
    if (m !== method) continue;
    const names: string[] = [];
    const re = new RegExp(
      `^${pattern.replace(/:(\w+)/g, (_x, n: string) => {
        names.push(n);
        return "([^/]+)";
      })}$`,
    );
    const hit = re.exec(path);
    if (hit) return { key, params: Object.fromEntries(names.map((n, i) => [n, hit[i + 1]!])) };
  }
  return null;
}

/** Target sub-workflow of an Execute Workflow node (by the name n8n caches). */
const subWorkflowName = (node: N8nNode) =>
  String((node.parameters.workflowId as { cachedResultName?: string })?.cachedResultName ?? "");

export function checkN8nContract(input: ContractCheckInput): ContractCheckResult {
  const problems: string[] = [];
  const calls: ContractCheckResult["calls"] = [];
  const subWorkflowInputs: Record<string, Record<string, unknown>[]> = {};

  const runWorkflow = (wf: N8nWorkflow, triggerOutput: unknown) => {
    const outputs: Outputs = new Map();
    const byName = new Map(wf.nodes.map((n) => [n.name, n]));
    const trigger = wf.nodes.find((n) => /Trigger$|\.webhook$/.test(n.type));
    if (!trigger) {
      problems.push(`${wf.name}: no trigger node`);
      return;
    }
    // Walk the graph from the trigger (breadth first). `json` = output of the previous node.
    const queue: { name: string; json: unknown }[] = [];
    const visited = new Set<string>();
    const follow = (from: string, json: unknown, branch?: number) => {
      const outs = wf.connections[from]?.main ?? [];
      outs.forEach((targets, i) => {
        if (branch !== undefined && i !== branch) return;
        for (const t of targets ?? []) queue.push({ name: t.node, json });
      });
    };
    outputs.set(trigger.name, triggerOutput);
    follow(trigger.name, triggerOutput);

    while (queue.length) {
      const { name, json } = queue.shift()!;
      const node = byName.get(name);
      if (!node) {
        problems.push(`${wf.name}: connection to a missing node "${name}"`);
        continue;
      }
      // A node reached from several branches runs once per distinct input in n8n; for the
      // contract one evaluation per path is enough — but loops (the processor's polling)
      // must not spin forever.
      const visitKey = `${name}|${JSON.stringify(json)}`;
      if (visited.has(visitKey)) continue;
      visited.add(visitKey);
      try {
        switch (node.type) {
          case "n8n-nodes-base.set": {
            const out = setNodeOutput(node, outputs, json);
            outputs.set(name, out);
            follow(name, out);
            break;
          }
          case "n8n-nodes-base.httpRequest": {
            const res = checkHttpNode(wf, node, outputs, json);
            outputs.set(name, res);
            follow(name, res);
            break;
          }
          case "n8n-nodes-base.if": {
            const c = (
              node.parameters.conditions as {
                conditions: {
                  leftValue: unknown;
                  rightValue?: unknown;
                  operator: { operation: string };
                }[];
              }
            ).conditions;
            const pass = c.every((cond) => {
              const left = evaluate(cond.leftValue, outputs, json);
              if (cond.operator.operation === "equals")
                return left === evaluate(cond.rightValue, outputs, json);
              throw new Error(`unsupported If operation "${cond.operator.operation}"`);
            });
            outputs.set(name, json);
            follow(name, json, pass ? 0 : 1);
            break;
          }
          case "n8n-nodes-base.switch": {
            // Routing is checked by n8n-workflows.test.ts; here every branch is explored.
            outputs.set(name, json);
            follow(name, json);
            break;
          }
          case "n8n-nodes-base.executeWorkflow": {
            const target = subWorkflowName(node);
            (subWorkflowInputs[target] ??= []).push(json as Record<string, unknown>);
            outputs.set(name, json);
            follow(name, json);
            break;
          }
          case "n8n-nodes-base.wait":
          case "n8n-nodes-base.noOp": {
            outputs.set(name, json);
            follow(name, json);
            break;
          }
          default:
            problems.push(
              `${wf.name} › ${name}: node type ${node.type} not understood by the check`,
            );
        }
      } catch (err) {
        problems.push(`${wf.name} › ${name}: ${(err as Error).message}`);
      }
    }
  };

  const checkHttpNode = (
    wf: N8nWorkflow,
    node: N8nNode,
    outputs: Outputs,
    json: unknown,
  ): Record<string, unknown> => {
    const where = `${wf.name} › ${node.name}`;
    const p = node.parameters;
    const method = String(p.method ?? "GET");
    const url = String(evaluate(p.url, outputs, json));
    const base = String((outputs.get("Config") as { apiBaseUrl?: string } | undefined)?.apiBaseUrl);
    if (!url.startsWith(`${base}/`)) {
      problems.push(`${where}: URL does not start with the Config apiBaseUrl (${url})`);
      return {};
    }
    const path = url.slice(base.length);
    const match = routeMatch(input.routes, method, path);
    if (!match) {
      problems.push(`${where}: ${method} ${path} is not a route of the contract`);
      return {};
    }
    calls.push({ route: match.key, workflow: wf.name, node: node.name });
    if (
      node.credentials?.httpHeaderAuth?.name !== input.credential ||
      p.genericAuthType !== "httpHeaderAuth"
    )
      problems.push(
        `${where}: must authenticate with the "${input.credential}" Header Auth credential`,
      );

    const schemas = input.routes[match.key]!;
    if (schemas.params) {
      const r = schemas.params.safeParse(match.params);
      if (!r.success) problems.push(`${where}: params rejected by the API: ${r.error.message}`);
    }
    if (schemas.body) {
      if (p.sendBody !== true || p.specifyBody !== "json") {
        problems.push(`${where}: ${match.key} needs a JSON body`);
      } else {
        const raw = evaluate(p.jsonBody, outputs, json);
        let body: unknown;
        try {
          body = typeof raw === "string" ? JSON.parse(raw) : raw;
        } catch {
          problems.push(`${where}: jsonBody is not JSON`);
        }
        const r = schemas.body.safeParse(body);
        if (!r.success)
          problems.push(
            `${where}: body ${JSON.stringify(body)} rejected by the API: ${r.error.issues
              .map((i) => `${i.path.join(".") || "(root)"} ${i.message}`)
              .join("; ")}`,
          );
      }
    } else if (p.sendBody === true) {
      problems.push(`${where}: ${match.key} takes no body`);
    }
    return input.responses[match.key] ?? {};
  };

  const { receiver, processor, notifier, errors } = input.workflows;
  runWorkflow(receiver, { body: input.messageReady, headers: {}, params: {}, query: {} });
  for (const i of subWorkflowInputs[processor.name] ?? []) runWorkflow(processor, i);
  for (const i of subWorkflowInputs[notifier.name] ?? []) runWorkflow(notifier, i);
  runWorkflow(errors, input.errorTrigger);
  return { problems, calls, subWorkflowInputs };
}
