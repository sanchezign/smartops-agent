import type { N8nWorkflow } from "./n8n-contract-check.js";

/**
 * Runs the EXPORTED n8n workflows (n8n/workflows/*.json) against scripted API answers and records
 * what they do: every internal API call and every Wait node, in order. Used by the parity test
 * (ADR-025): the in-process orchestrator must produce the same trace. It understands exactly the
 * node types and expression surface our workflows use (Webhook, Set, HTTP Request, Switch, If,
 * Execute Workflow, Wait, NoOp; `$('Node').first().json`, `$json`, `$runIndex`) and fails loudly on
 * anything else.
 */

export type TraceEntry =
  { call: string; body?: unknown } | { wait: true } | { error: string; body: unknown };

export type Respond = (method: string, path: string, body: unknown) => Record<string, unknown>;

type Json = Record<string, unknown>;

interface Node {
  name: string;
  type: string;
  parameters: Record<string, unknown>;
}

function evaluate(
  value: unknown,
  outputs: Map<string, Json>,
  json: unknown,
  runIndex: number,
): unknown {
  if (typeof value !== "string") return value;
  const run = (expr: string): unknown => {
    const $ = (name: string) => {
      const out = outputs.get(name);
      if (!out) throw new Error(`no output for node "${name}"`);
      return { first: () => ({ json: out }) };
    };
    return (
      new Function("$", "$json", "$runIndex", `return (${expr});`) as (
        a: unknown,
        b: unknown,
        c: number,
      ) => unknown
    )($, json, runIndex);
  };
  const text = value.startsWith("=") ? value.slice(1) : value;
  if (!value.startsWith("=") && !text.includes("{{")) return value;
  const trimmed = text.trim();
  if (
    trimmed.startsWith("{{") &&
    trimmed.endsWith("}}") &&
    trimmed.indexOf("}}") === trimmed.length - 2
  )
    return run(trimmed.slice(2, -2));
  return text.replace(/\{\{([\s\S]*?)\}\}/g, (_m, expr: string) => String(run(expr)));
}

export function runExportedWorkflows(
  workflows: Record<"receiver" | "processor" | "notifier" | "errors", N8nWorkflow>,
  event: { messageId: string },
  respond: Respond,
): TraceEntry[] {
  const trace: TraceEntry[] = [];
  const byName = new Map(Object.values(workflows).map((w) => [w.name, w]));

  const runWorkflow = (wf: N8nWorkflow, triggerJson: Json): void => {
    const nodes = new Map<string, Node>(wf.nodes.map((n) => [n.name, n as Node]));
    const outputs = new Map<string, Json>();
    const runs = new Map<string, number>();
    const trigger = wf.nodes.find((n) => /Trigger$|\.webhook$/.test(n.type));
    if (!trigger) throw new Error(`${wf.name}: no trigger`);
    outputs.set(trigger.name, triggerJson);
    const queue: { name: string; json: Json }[] = [];
    const follow = (from: string, json: Json, branch = 0) => {
      for (const t of wf.connections[from]?.main?.[branch] ?? [])
        queue.push({ name: t.node, json });
    };
    follow(trigger.name, triggerJson);

    while (queue.length) {
      const { name, json } = queue.shift()!;
      const node = nodes.get(name);
      if (!node) throw new Error(`${wf.name}: missing node ${name}`);
      const runIndex = runs.get(name) ?? 0;
      runs.set(name, runIndex + 1);
      const ev = (v: unknown) => evaluate(v, outputs, json, runIndex);
      const p = node.parameters;
      switch (node.type) {
        case "n8n-nodes-base.set": {
          const out: Json = {};
          const a = (p.assignments as { assignments?: { name: string; value: unknown }[] })
            ?.assignments;
          for (const x of a ?? []) out[x.name] = ev(x.value);
          outputs.set(name, out);
          follow(name, out);
          break;
        }
        case "n8n-nodes-base.httpRequest": {
          const base = String((outputs.get("Config") as { apiBaseUrl?: string }).apiBaseUrl);
          const url = String(ev(p.url));
          const path = url.slice(base.length).replace(/^\/internal/, "");
          const method = String(p.method ?? "GET");
          const raw = p.sendBody ? ev(p.jsonBody) : undefined;
          const body = typeof raw === "string" ? (JSON.parse(raw) as unknown) : raw;
          trace.push({ call: `${method} ${path}`, ...(body !== undefined ? { body } : {}) });
          const res = respond(method, path, body);
          outputs.set(name, res);
          follow(name, res);
          break;
        }
        case "n8n-nodes-base.switch": {
          const rules = (p.rules as { values: { conditions: { conditions: Cond[] } }[] }).values;
          const hit = rules.findIndex((r) => r.conditions.conditions.every((c) => cond(c, ev)));
          outputs.set(name, json);
          follow(name, json, hit === -1 ? rules.length : hit); // the extra output = fallback
          break;
        }
        case "n8n-nodes-base.if": {
          const c = (p.conditions as { conditions: Cond[] }).conditions;
          outputs.set(name, json);
          follow(name, json, c.every((x) => cond(x, ev)) ? 0 : 1);
          break;
        }
        case "n8n-nodes-base.executeWorkflow": {
          const target = String(
            (p.workflowId as { cachedResultName?: string }).cachedResultName ?? "",
          );
          const sub = byName.get(target);
          if (!sub) throw new Error(`${wf.name} › ${name}: unknown sub-workflow "${target}"`);
          outputs.set(name, json);
          runWorkflow(sub, json);
          follow(name, json);
          break;
        }
        case "n8n-nodes-base.wait":
          trace.push({ wait: true });
          outputs.set(name, json);
          follow(name, json);
          break;
        case "n8n-nodes-base.noOp":
          outputs.set(name, json);
          follow(name, json);
          break;
        default:
          throw new Error(`${wf.name} › ${name}: node type ${node.type} not supported`);
      }
    }
  };

  runWorkflow(workflows.receiver, { body: event, headers: {}, params: {}, query: {} });
  return trace;
}

interface Cond {
  leftValue: unknown;
  rightValue?: unknown;
  operator: { operation: string };
}
function cond(c: Cond, ev: (v: unknown) => unknown): boolean {
  const left = ev(c.leftValue);
  switch (c.operator.operation) {
    case "equals":
      return left === ev(c.rightValue);
    case "true":
      return left === true;
    default:
      throw new Error(`unsupported condition "${c.operator.operation}"`);
  }
}
