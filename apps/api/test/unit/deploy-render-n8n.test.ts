import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  renderCredentials,
  renderWorkflows,
  stableId,
} from "../../../../deploy/lib/render-n8n.mjs";

/**
 * deploy/lib/render-n8n.mjs (phase 12, user addendum D): the demo's n8n has no editor, so the
 * committed workflows are imported by CLI. The exports carry no ids, but the workflows call
 * each other by id and use credentials by id — the renderer must restore exactly those, point
 * the Config node at the API inside Docker, and build the Header Auth credentials from the
 * server's secrets. Verified for real against n8n 2.40.6 (import + publish + webhook call).
 */

const DIR = new URL("../../../../n8n/workflows/", import.meta.url);
const exported = readdirSync(DIR)
  .filter((f) => f.endsWith(".json"))
  .map((f) => JSON.parse(readFileSync(new URL(f, DIR), "utf8")) as Record<string, unknown>);
const API = "http://api:4000/api/v1";
const secrets = {
  INTERNAL_API_KEY: "k".repeat(40),
  N8N_WEBHOOK_SECRET: "s".repeat(40),
};

type Node = {
  name: string;
  type: string;
  parameters?: Record<string, unknown>;
  credentials?: Record<string, { id: string; name: string }>;
};
const nodesOf = (w: Record<string, unknown>) => w.nodes as Node[];

describe("render-n8n (deploy)", () => {
  const rendered = renderWorkflows(exported, { apiBaseUrl: API });
  const byName = new Map(rendered.map((w) => [w.name, w]));

  it("every Execute Workflow node and settings.errorWorkflow point at a rendered workflow", () => {
    const ids = new Set(rendered.map((w) => w.id));
    expect(ids.size).toBe(rendered.length);
    for (const w of rendered) {
      for (const node of nodesOf(w)) {
        if (node.type !== "n8n-nodes-base.executeWorkflow") continue;
        const ref = node.parameters?.workflowId as { value: string; cachedResultName: string };
        expect(byName.get(ref.cachedResultName)?.id).toBe(ref.value);
      }
      const errorWorkflow = (w.settings as { errorWorkflow?: string }).errorWorkflow;
      if (errorWorkflow) {
        const handler = rendered.find((x) => x.id === errorWorkflow)!;
        expect(nodesOf(handler).some((n) => n.type === "n8n-nodes-base.errorTrigger")).toBe(true);
      }
    }
  });

  it("the Config node talks to the API inside Docker; imported inactive (published after)", () => {
    for (const w of rendered) {
      expect(w.active).toBe(false);
      const config = nodesOf(w).find((n) => n.name === "Config");
      const assignments = (
        config?.parameters?.assignments as { assignments: { name: string; value: string }[] }
      ).assignments;
      expect(assignments.find((a) => a.name === "apiBaseUrl")?.value).toBe(API);
    }
    // The committed files are untouched (the renderer works on copies).
    expect(JSON.stringify(exported)).not.toContain(API);
  });

  it("ids are stable across runs (a re-import replaces, never duplicates)", () => {
    expect(renderWorkflows(exported, { apiBaseUrl: API }).map((w) => w.id)).toEqual(
      rendered.map((w) => w.id),
    );
    expect(stableId("SmartOps · Receptor")).toMatch(/^[0-9A-Za-z]{16}$/);
    expect(stableId("a")).not.toBe(stableId("b"));
  });

  it("builds exactly the Header Auth credentials the nodes reference, with the server's values", () => {
    const credentials = renderCredentials(exported, secrets);
    const referenced = new Map<string, string>();
    for (const w of exported)
      for (const node of nodesOf(w))
        for (const ref of Object.values(node.credentials ?? {})) referenced.set(ref.id, ref.name);
    expect(new Map(credentials.map((c) => [c.id, c.name]))).toEqual(referenced);
    expect(credentials.find((c) => c.name === "SmartOps API")?.data).toEqual({
      name: "X-Internal-Api-Key",
      value: secrets.INTERNAL_API_KEY,
    });
    expect(credentials.find((c) => c.name === "SmartOps webhook secret")?.data).toEqual({
      name: "X-SmartOps-Secret",
      value: secrets.N8N_WEBHOOK_SECRET,
    });
  });

  it("refuses missing / short secrets, unknown credentials and dangling references", () => {
    expect(() => renderCredentials(exported, { ...secrets, N8N_WEBHOOK_SECRET: "" })).toThrow(
      /N8N_WEBHOOK_SECRET is missing/,
    );
    expect(() => renderCredentials(exported, { ...secrets, INTERNAL_API_KEY: "short" })).toThrow(
      /INTERNAL_API_KEY/,
    );
    const unknownCredential = structuredClone(exported);
    nodesOf(unknownCredential[0]!).find((n) => n.credentials)!.credentials!.httpHeaderAuth!.name =
      "Something else";
    expect(() => renderCredentials(unknownCredential, secrets)).toThrow(
      /no value source|two names/,
    );
    const withoutNotifier = exported.filter((w) => w.name !== "SmartOps · Notificador");
    expect(() => renderWorkflows(withoutNotifier, { apiBaseUrl: API })).toThrow(/not exported/);
    expect(() => renderWorkflows(exported, { apiBaseUrl: "http://api:4000" })).toThrow(
      /apiBaseUrl/,
    );
  });
});
