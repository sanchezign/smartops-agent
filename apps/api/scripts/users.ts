/**
 * users:* — user management from the server (phase 8, ADR-018). The ONLY way to create the
 * first admin: no default password, no HTTP bootstrap. Passwords are NEVER command-line
 * arguments (shell history): typed twice at a hidden prompt, or read from stdin.
 *
 *   pnpm --filter @smartops/api users create --email ana@ferreteria.uy --name "Ana" --role admin
 *   pnpm --filter @smartops/api users list
 *   pnpm --filter @smartops/api users reset-password --email ana@ferreteria.uy
 *   pnpm --filter @smartops/api users unlock --email ana@ferreteria.uy
 *   pnpm --filter @smartops/api users set-role --email luis@ferreteria.uy --role operator
 *   pnpm --filter @smartops/api users deactivate|reactivate --email luis@ferreteria.uy
 *   ... --password-stdin (e.g. `printf '%s' "$PW" | pnpm … users create … --password-stdin`)
 *   ... --by <your name> (recorded in the audit log; default: the OS user)
 */
import { userInfo } from "node:os";
import { parseArgs } from "node:util";
import { createPrismaClient } from "../src/common/db.js";
import { AppError } from "../src/common/errors/app-error.js";
import { createLogger } from "../src/common/logger.js";
import { loadEnv } from "../src/config/env.js";
import { createUsersRepository } from "../src/modules/users/users.repository.js";
import { createUsersService } from "../src/modules/users/users.service.js";

const { positionals, values } = parseArgs({
  allowPositionals: true,
  options: {
    email: { type: "string" },
    name: { type: "string" },
    role: { type: "string" },
    by: { type: "string" },
    "password-stdin": { type: "boolean", default: false },
  },
});

const env = loadEnv();
const logger = createLogger(env);
const [action] = positionals;
const ACTIONS = [
  "create",
  "list",
  "reset-password",
  "unlock",
  "set-role",
  "deactivate",
  "reactivate",
];

function fail(message: string): never {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}

if (!action || !ACTIONS.includes(action)) fail(`usage: users ${ACTIONS.join("|")} [--email …]`);
if (action !== "list" && !values.email) fail("pass --email <email>");

/** Reads a line without echoing it (TTY), or all of stdin (--password-stdin). */
async function readSecret(prompt: string): Promise<string> {
  if (values["password-stdin"] || !process.stdin.isTTY) {
    const chunks: Buffer[] = [];
    for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
    return Buffer.concat(chunks)
      .toString("utf8")
      .replace(/\r?\n$/, "");
  }
  process.stdout.write(prompt);
  process.stdin.setRawMode(true);
  process.stdin.resume();
  process.stdin.setEncoding("utf8");
  return new Promise((resolve) => {
    let value = "";
    const onData = (key: string) => {
      for (const ch of key) {
        if (ch === "\r" || ch === "\n") {
          process.stdin.setRawMode(false);
          process.stdin.pause();
          process.stdin.off("data", onData);
          process.stdout.write("\n");
          resolve(value);
          return;
        }
        if (ch === "\u0003") fail("\ncancelled"); // Ctrl+C
        if (ch === "\u007f" || ch === "\b") value = value.slice(0, -1);
        else value += ch;
      }
    };
    process.stdin.on("data", onData);
  });
}

async function newPassword(): Promise<string> {
  const first = await readSecret("Nueva contraseña (mín. 15 caracteres, no se muestra): ");
  if (values["password-stdin"] || !process.stdin.isTTY) return first;
  const second = await readSecret("Repetila: ");
  if (first !== second) fail("Las contraseñas no coinciden.");
  return first;
}

const prisma = createPrismaClient(env.DATABASE_URL, logger);
const service = createUsersService({
  // Sessions (phase 8 M3) are revoked on role change / deactivation / password reset.
  repository: createUsersRepository(prisma),
});
const actor = { label: `cli:${values.by ?? userInfo().username}` };

async function target() {
  const user = await service.findByEmail(values.email as string);
  if (!user) fail(`No user with email ${values.email}`);
  return user;
}

try {
  switch (action) {
    case "list": {
      const users = await service.list();
      for (const u of users) {
        process.stdout.write(
          `${u.email}\t${u.role}\t${u.active ? "active" : "INACTIVE"}\t${u.name}` +
            `${u.lockedUntil && u.lockedUntil > new Date() ? `\tLOCKED until ${u.lockedUntil.toISOString()}` : ""}\n`,
        );
      }
      if (users.length === 0) process.stdout.write("(no users yet — create the first admin)\n");
      break;
    }
    case "create": {
      if (!values.name) fail("pass --name <name>");
      if (values.role !== "admin" && values.role !== "operator") fail("--role admin|operator");
      const user = await service.create(
        {
          email: values.email as string,
          name: values.name,
          role: values.role,
          password: await newPassword(),
        },
        actor,
      );
      process.stdout.write(`created ${user.email} (${user.role})\n`);
      break;
    }
    case "reset-password": {
      const user = await target();
      const { revokedSessions } = await service.resetPassword(user.id, await newPassword(), actor);
      process.stdout.write(`password reset; ${revokedSessions} session(s) closed\n`);
      break;
    }
    case "unlock": {
      await service.unlock((await target()).id, actor);
      process.stdout.write("unlocked\n");
      break;
    }
    case "set-role": {
      if (values.role !== "admin" && values.role !== "operator") fail("--role admin|operator");
      const { revokedSessions } = await service.update(
        (await target()).id,
        { role: values.role },
        actor,
      );
      process.stdout.write(`role set to ${values.role}; ${revokedSessions} session(s) closed\n`);
      break;
    }
    case "deactivate":
    case "reactivate": {
      const { revokedSessions } = await service.update(
        (await target()).id,
        { active: action === "reactivate" },
        actor,
      );
      process.stdout.write(`${action}d; ${revokedSessions} session(s) closed\n`);
      break;
    }
  }
} catch (err) {
  if (err instanceof AppError) {
    const details = Array.isArray(err.details)
      ? (err.details as { message?: string }[]).map((d) => `  - ${d.message}`).join("\n")
      : "";
    fail(`${err.message}${details ? `\n${details}` : ""}`);
  }
  throw err;
} finally {
  await prisma.$disconnect();
}
