// Renders the versioned n8n workflows (n8n/workflows/*.json) for a CLI import on the server
// (phase 12, user addendum D: the demo's n8n has NO editor — workflows arrive by CLI only).
//
// The committed exports are sanitized: no workflow ids, credentials only as { id, name }
// references. But the workflows point at each other by id (Execute Workflow nodes, the
// error workflow in settings) and at credentials by id, so an import must restore exactly
// those ids. This module:
//   1. gives each workflow the id its callers reference (by name for Execute Workflow nodes,
//      by the Error Trigger for settings.errorWorkflow); any other workflow gets a stable id
//      derived from its name;
//   2. points the "Config" node's apiBaseUrl at the API inside the Docker network;
//   3. builds the Header Auth credentials the nodes reference, from the server's secrets.
// Pure functions + a tiny CLI. No dependencies: it runs with the API image's Node.
//
//   node render-n8n.mjs --workflows <dir> --out <dir> --api-base-url http://api:4000/api/v1
//   (secrets from the environment: INTERNAL_API_KEY, N8N_WEBHOOK_SECRET)

import { createHash } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

/** Which secret feeds each credential the workflows reference (docs/n8n-setup.md §2). */
export const CREDENTIALS = {
  "SmartOps API": { header: "X-Internal-Api-Key", secret: "INTERNAL_API_KEY" },
  "SmartOps webhook secret": { header: "X-SmartOps-Secret", secret: "N8N_WEBHOOK_SECRET" },
};

const EXECUTE_WORKFLOW = "n8n-nodes-base.executeWorkflow";
const ERROR_TRIGGER = "n8n-nodes-base.errorTrigger";
const ID_ALPHABET = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";

/** A stable 16-character n8n-style id for a workflow nobody references by id. */
export function stableId(name) {
  const digest = createHash("sha256").update(`smartops:${name}`).digest();
  let id = "";
  for (let i = 0; i < 16; i += 1) id += ID_ALPHABET[digest[i] % ID_ALPHABET.length];
  return id;
}

/**
 * @param {Array<Record<string, any>>} workflows parsed exports
 * @param {{ apiBaseUrl: string }} options
 * @returns {Array<Record<string, any>>} workflows with ids, ready for `n8n import:workflow`
 */
export function renderWorkflows(workflows, options) {
  if (!/^https?:\/\/[^/]+\/api\/v1$/.test(options.apiBaseUrl))
    throw new Error(
      `apiBaseUrl must look like http://host:port/api/v1 (got ${options.apiBaseUrl})`,
    );
  const byName = new Map(workflows.map((w) => [w.name, w]));
  if (byName.size !== workflows.length) throw new Error("two workflows share a name");

  const ids = new Map(); // workflow name -> id
  const assign = (name, id, why) => {
    if (!byName.has(name)) throw new Error(`${why} references "${name}", which is not exported`);
    const previous = ids.get(name);
    if (previous && previous !== id)
      throw new Error(`"${name}" is referenced with two ids (${previous}, ${id})`);
    ids.set(name, id);
  };

  for (const workflow of workflows) {
    for (const node of workflow.nodes ?? []) {
      if (node.type !== EXECUTE_WORKFLOW) continue;
      const ref = node.parameters?.workflowId;
      if (!ref || typeof ref !== "object" || !ref.value || !ref.cachedResultName)
        throw new Error(
          `${workflow.name} / ${node.name}: sub-workflow must be picked from the list`,
        );
      assign(ref.cachedResultName, String(ref.value), `${workflow.name} / ${node.name}`);
    }
  }
  const errorIds = new Set(
    workflows.map((w) => w.settings?.errorWorkflow).filter((id) => typeof id === "string"),
  );
  if (errorIds.size > 1) throw new Error(`several error workflows referenced: ${[...errorIds]}`);
  if (errorIds.size === 1) {
    const handlers = workflows.filter((w) => (w.nodes ?? []).some((n) => n.type === ERROR_TRIGGER));
    if (handlers.length !== 1)
      throw new Error(
        "settings.errorWorkflow is set, but not exactly one workflow has an Error Trigger",
      );
    assign(handlers[0].name, [...errorIds][0], "settings.errorWorkflow");
  }

  return workflows.map((workflow) => {
    const copy = structuredClone(workflow);
    copy.id = ids.get(workflow.name) ?? stableId(workflow.name);
    copy.active = false; // published explicitly after the import (n8n publish:workflow)
    for (const node of copy.nodes ?? []) {
      const assignments = node.parameters?.assignments?.assignments;
      if (node.name !== "Config" || !Array.isArray(assignments)) continue;
      for (const a of assignments) if (a.name === "apiBaseUrl") a.value = options.apiBaseUrl;
    }
    return copy;
  });
}

/**
 * The Header Auth credentials the workflows reference, with their values.
 * @param {Array<Record<string, any>>} workflows
 * @param {Record<string, string | undefined>} secrets e.g. process.env
 */
export function renderCredentials(workflows, secrets) {
  const refs = new Map(); // id -> { id, name, type }
  for (const workflow of workflows) {
    for (const node of workflow.nodes ?? []) {
      for (const [type, ref] of Object.entries(node.credentials ?? {})) {
        const previous = refs.get(ref.id);
        if (previous && previous.name !== ref.name)
          throw new Error(`credential id ${ref.id} has two names (${previous.name}, ${ref.name})`);
        refs.set(ref.id, { id: ref.id, name: ref.name, type });
      }
    }
  }
  return [...refs.values()].map((ref) => {
    const spec = CREDENTIALS[ref.name];
    if (!spec || ref.type !== "httpHeaderAuth")
      throw new Error(`no value source for credential "${ref.name}" (${ref.type})`);
    const value = secrets[spec.secret]?.trim();
    if (!value || value.length < 32)
      throw new Error(`${spec.secret} is missing or shorter than 32 characters`);
    return { id: ref.id, name: ref.name, type: ref.type, data: { name: spec.header, value } };
  });
}

function main(argv) {
  const arg = (flag) => {
    const i = argv.indexOf(flag);
    if (i < 0 || !argv[i + 1]) throw new Error(`missing ${flag}`);
    return argv[i + 1];
  };
  const dir = arg("--workflows");
  const out = arg("--out");
  const files = readdirSync(dir)
    .filter((f) => f.endsWith(".json"))
    .sort();
  const workflows = files.map((f) => JSON.parse(readFileSync(join(dir, f), "utf8")));
  const rendered = renderWorkflows(workflows, { apiBaseUrl: arg("--api-base-url") });
  const credentials = renderCredentials(workflows, process.env);
  mkdirSync(join(out, "workflows"), { recursive: true, mode: 0o700 });
  for (const w of rendered)
    writeFileSync(join(out, "workflows", `${w.id}.json`), JSON.stringify(w), { mode: 0o600 });
  writeFileSync(join(out, "credentials.json"), JSON.stringify(credentials), { mode: 0o600 });
  // Only ids and names: never a credential value on stdout.
  for (const w of rendered) process.stdout.write(`${w.id}\t${w.name}\n`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  try {
    main(process.argv.slice(2));
  } catch (err) {
    process.stderr.write(`render-n8n: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  }
}
