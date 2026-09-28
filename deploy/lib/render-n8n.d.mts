// Types for render-n8n.mjs (plain ESM so it runs with the API image's Node, no build step).
export declare const CREDENTIALS: Record<string, { header: string; secret: string }>;
export declare function stableId(name: string): string;
export declare function renderWorkflows(
  workflows: Array<Record<string, unknown>>,
  options: { apiBaseUrl: string },
): Array<Record<string, unknown> & { id: string; name: string; active: boolean }>;
export declare function renderCredentials(
  workflows: Array<Record<string, unknown>>,
  secrets: Record<string, string | undefined>,
): Array<{ id: string; name: string; type: string; data: { name: string; value: string } }>;
