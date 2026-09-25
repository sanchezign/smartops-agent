/**
 * Sanitizes an exported n8n workflow before it is committed to n8n/workflows/ (phase 6):
 * - keeps only name, nodes, connections, settings (active: false);
 * - drops pinData (pinned test data can hold real phone numbers / messages), staticData,
 *   meta, tags, sharing and version info;
 * - credentials stay as REFERENCES ({ id, name }); their values are never in a workflow
 *   export, and anything that looks like a secret makes the export fail.
 */

export interface SanitizeResult {
  workflow: Record<string, unknown>;
  removed: string[];
  problems: string[];
}

const SECRET_PATTERNS: ReadonlyArray<readonly [string, RegExp]> = [
  ["Anthropic key", /sk-ant-[A-Za-z0-9_-]{10,}/],
  ["Meta access token", /\bEAA[A-Za-z0-9]{20,}/],
  ["Groq key", /\bgsk_[A-Za-z0-9]{20,}/],
  ["long hex secret", /\b[0-9a-f]{48,}\b/],
];

const SENSITIVE_HEADERS = /^(x-internal-api-key|x-smartops-secret|authorization)$/i;

function literalSensitiveHeaders(nodes: unknown[]): string[] {
  const found: string[] = [];
  for (const node of nodes as { name?: string; parameters?: Record<string, unknown> }[]) {
    const headers = (
      node.parameters?.headerParameters as
        { parameters?: { name?: string; value?: string }[] } | undefined
    )?.parameters;
    for (const h of headers ?? []) {
      if (
        h.name &&
        SENSITIVE_HEADERS.test(h.name) &&
        h.value &&
        !String(h.value).startsWith("={{")
      ) {
        found.push(
          `${node.name ?? "?"}: literal ${h.name} header (use the Header Auth credential)`,
        );
      }
    }
  }
  return found;
}

export function sanitizeWorkflow(
  input: Record<string, unknown>,
  options: { secrets?: string[] } = {},
): SanitizeResult {
  const keep = ["name", "nodes", "connections", "settings"];
  const removed = Object.keys(input).filter((k) => !keep.includes(k) && k !== "active");
  const nodes = (input.nodes as Record<string, unknown>[] | undefined) ?? [];
  const workflow: Record<string, unknown> = {
    name: input.name,
    nodes: nodes.map((node) => {
      const copy = { ...node };
      // Never carry pinned data or credential payloads inside nodes.
      delete copy.pinData;
      const creds = copy.credentials as Record<string, { id?: string; name?: string }> | undefined;
      if (creds) {
        copy.credentials = Object.fromEntries(
          Object.entries(creds).map(([type, ref]) => [
            type,
            { id: ref.id ?? "", name: ref.name ?? "" },
          ]),
        );
      }
      return copy;
    }),
    connections: input.connections ?? {},
    settings: input.settings ?? {},
    active: false,
  };

  const text = JSON.stringify(workflow);
  const problems: string[] = [];
  for (const [label, re] of SECRET_PATTERNS)
    if (re.test(text)) problems.push(`looks like a ${label}`);
  for (const secret of options.secrets ?? []) {
    if (secret.length >= 16 && text.includes(secret))
      problems.push("contains a value from apps/api/.env");
  }
  problems.push(...literalSensitiveHeaders(nodes));
  return { workflow, removed, problems };
}

/** File name in n8n/workflows/ for each SmartOps workflow. */
export const WORKFLOW_FILES: Record<string, string> = {
  "SmartOps · Receptor": "receiver.json",
  "SmartOps · Procesador": "processor.json",
  "SmartOps · Notificador": "notifier.json",
  "SmartOps · Errores": "errors.json",
};
