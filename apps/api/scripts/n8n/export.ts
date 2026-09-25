/**
 * n8n:export — exports the SmartOps workflows from the local n8n (Docker) into
 * n8n/workflows/, sanitized (no pinData, no secrets; credentials only as references).
 *
 *   pnpm --filter @smartops/api n8n:export
 *
 * Runs `n8n export:workflow` INSIDE the n8n container (docker compose exec) and copies the
 * files out (docker compose cp). Fails without writing anything if a secret is found.
 * Credentials are NEVER exported (no export:credentials).
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { sanitizeWorkflow, WORKFLOW_FILES } from "./sanitize.js";

const root = fileURLToPath(new URL("../../../../", import.meta.url));
const outDir = join(root, "n8n", "workflows");
const containerDir = "/tmp/smartops-export";

function envSecrets(): string[] {
  try {
    const env = readFileSync(join(root, "apps", "api", ".env"), "utf8");
    return env
      .split(/\r?\n/)
      .filter((l) =>
        /^(INTERNAL_API_KEY|N8N_WEBHOOK_SECRET|ANTHROPIC_API_KEY|WHATSAPP_ACCESS_TOKEN|WHATSAPP_APP_SECRET|TRANSCRIPTION_API_KEY)=/.test(
          l,
        ),
      )
      .map((l) => l.slice(l.indexOf("=") + 1).trim())
      .filter(Boolean);
  } catch {
    return [];
  }
}

const docker = (...args: string[]) =>
  execFileSync("docker", ["compose", ...args], { cwd: root, stdio: ["ignore", "pipe", "inherit"] });

const tmp = mkdtempSync(join(tmpdir(), "smartops-n8n-"));
try {
  docker("exec", "-T", "n8n", "rm", "-rf", containerDir);
  docker(
    "exec",
    "-T",
    "n8n",
    "n8n",
    "export:workflow",
    "--all",
    "--separate",
    "--pretty",
    `--output=${containerDir}/`,
  );
  docker("cp", `n8n:${containerDir}/.`, tmp);

  const secrets = envSecrets();
  const outputs: { file: string; content: string }[] = [];
  const problems: string[] = [];
  for (const file of readdirSync(tmp).filter((f) => f.endsWith(".json"))) {
    const raw = JSON.parse(readFileSync(join(tmp, file), "utf8")) as Record<string, unknown>;
    const target = WORKFLOW_FILES[String(raw.name)];
    if (!target) {
      process.stdout.write(`skipped (not a SmartOps workflow): ${String(raw.name)}\n`);
      continue;
    }
    const result = sanitizeWorkflow(raw, { secrets });
    problems.push(...result.problems.map((p) => `${target}: ${p}`));
    outputs.push({ file: target, content: `${JSON.stringify(result.workflow, null, 2)}\n` });
    process.stdout.write(`${target}: removed ${result.removed.join(", ") || "nothing"}\n`);
  }
  if (problems.length > 0) {
    process.stderr.write(`NOT written — possible secrets:\n  ${problems.join("\n  ")}\n`);
    process.exitCode = 1;
  } else {
    for (const o of outputs) writeFileSync(join(outDir, o.file), o.content);
    process.stdout.write(`exported ${outputs.length} workflows to n8n/workflows/ (run prettier)\n`);
  }
} finally {
  rmSync(tmp, { recursive: true, force: true });
}
