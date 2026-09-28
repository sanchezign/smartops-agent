import { pino } from "pino";
import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../../src/app.js";
import type { PrismaClient } from "../../src/common/db.js";
import { parseEnv } from "../../src/config/env.js";
import { createAuthService } from "../../src/modules/auth/auth.service.js";
import { createSessionsRepository } from "../../src/modules/auth/sessions.repository.js";
import { createAccessTokens } from "../../src/modules/auth/tokens.js";
import { createPublicAccount } from "../../src/modules/demo/public-account.js";
import { createUsersRepository } from "../../src/modules/users/users.repository.js";
import { createUsersService } from "../../src/modules/users/users.service.js";
import {
  createFakeWebhookQueue,
  createInMemoryWebhookRepository,
  healthyDb,
  stubAdminDeps,
  stubInternalDeps,
  TEST_ENV_SOURCE,
} from "../helpers/build-app.js";
import { createTestPrisma, testDatabaseUrl } from "./db.js";

/**
 * The shared public demo operator (phase 12, user addendum A). In the public demo EVERY visitor
 * logs in as the same operator, so anything scoped to "the user" is shared by strangers:
 * - wrong passwords never lock it (it would lock everybody out: a trivial DoS) — the per-IP
 *   login limiter protects it instead;
 * - "close every session" is refused (it would log every other visitor out);
 * - an admin cannot change its role, active flag or password, nor revoke its sessions;
 * - every OTHER account keeps the normal lockout.
 */

const log = pino({ level: "silent" });
const PANEL = "http://localhost:3000"; // CORS_ORIGINS in TEST_ENV_SOURCE
const PUBLIC = "demo@ferreteria.demo";
const PUBLIC_PASS = "probá el panel sin miedo";
const PASS = "una frase larga para entrar al panel";

describe.skipIf(!testDatabaseUrl)("the shared public demo operator (Postgres)", () => {
  let prisma: PrismaClient;
  const publicAccount = createPublicAccount({ demoMode: true, operatorEmail: PUBLIC });
  const users = () =>
    createUsersRepository(prisma, {
      revokeUserSessionsInTx: createSessionsRepository(prisma).revokeAllForUserInTx,
    });
  const usersService = () => createUsersService({ repository: users(), publicAccount });
  const csrf = { "x-smartops-csrf": "1", origin: PANEL };

  const buildApp = (env: Record<string, string> = {}) => {
    const parsed = parseEnv({ ...TEST_ENV_SOURCE, LOGIN_RATE_LIMIT_MAX: "1000", ...env });
    return createApp({
      env: parsed,
      logger: log,
      healthRepository: healthyDb,
      whatsappWebhookRepository: createInMemoryWebhookRepository(),
      webhookQueue: createFakeWebhookQueue(),
      admin: stubAdminDeps,
      internal: stubInternalDeps,
      auth: createAuthService({
        users: users(),
        sessions: createSessionsRepository(prisma),
        tokens: createAccessTokens({ secret: parsed.JWT_ACCESS_SECRET, ttlSeconds: 900 }),
        config: { idleHours: 24, maxDays: 7 },
        publicAccount,
      }),
    });
  };
  let app: ReturnType<typeof createApp>;
  const login = (email: string, password: string, ip?: string, target = app) => {
    const req = request(target).post("/api/v1/auth/login").set(csrf);
    return (ip ? req.set("x-forwarded-for", ip) : req).send({ email, password });
  };
  const me = (token: string) =>
    request(app).get("/api/v1/auth/me").set("authorization", `Bearer ${token}`);

  beforeAll(() => {
    prisma = createTestPrisma();
    app = buildApp();
  });
  afterAll(async () => {
    await prisma?.$disconnect();
  });
  beforeEach(async () => {
    await prisma.$executeRawUnsafe("TRUNCATE TABLE audit_logs, users CASCADE");
    // Created like the demo seed does (the CLI's policy would refuse a password that is public).
    const repo = users();
    const { hashPassword } = await import("../../src/modules/auth/password.js");
    await repo.create(
      {
        email: PUBLIC,
        name: "Operador demo",
        role: "operator",
        passwordHash: await hashPassword(PUBLIC_PASS),
      },
      { label: "test" },
    );
    await usersService().create(
      { email: "ana@x.uy", name: "Ana", role: "admin", password: PASS },
      { label: "test" },
    );
  });

  it("wrong passwords never lock the public account: the right one keeps working for everyone", async () => {
    for (let i = 0; i < 8; i += 1)
      await login(PUBLIC, "una contraseña equivocada cualquiera").expect(401);
    const operator = await prisma.user.findUniqueOrThrow({ where: { email: PUBLIC } });
    expect(operator).toMatchObject({ failedLoginCount: 0, lockedUntil: null, lockLevel: 0 });
    expect(await prisma.auditLog.count({ where: { action: "auth.account_locked" } })).toBe(0);
    await login(PUBLIC, PUBLIC_PASS).expect(200);
    // Failures are still audited (the per-IP limiter and the logs are the protection).
    expect(await prisma.auditLog.count({ where: { action: "auth.login_failed" } })).toBe(8);
  });

  it("any other account still locks after 5 failures", async () => {
    for (let i = 0; i < 5; i += 1)
      await login("ana@x.uy", "una contraseña equivocada cualquiera").expect(401);
    await login("ana@x.uy", PASS).expect(401);
    expect(await prisma.auditLog.count({ where: { action: "auth.account_locked" } })).toBe(1);
  });

  it("the protection is the per-IP login limiter: one IP is throttled, other visitors are not", async () => {
    const limited = buildApp({ LOGIN_RATE_LIMIT_MAX: "3", TRUST_PROXY: "1" });
    for (let i = 0; i < 3; i += 1)
      await login(PUBLIC, "una contraseña equivocada cualquiera", "203.0.113.7", limited).expect(
        401,
      );
    const throttled = await login(PUBLIC, PUBLIC_PASS, "203.0.113.7", limited);
    expect(throttled.status).toBe(429);
    await login(PUBLIC, PUBLIC_PASS, "203.0.113.8", limited).expect(200);
  });

  it("logout-all is refused: it would log every other visitor out", async () => {
    const visitorA = await login(PUBLIC, PUBLIC_PASS).expect(200);
    const visitorB = await login(PUBLIC, PUBLIC_PASS).expect(200);
    const res = await request(app)
      .post("/api/v1/auth/logout-all")
      .set("authorization", `Bearer ${visitorA.body.accessToken}`);
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe("FORBIDDEN");
    await me(visitorA.body.accessToken).expect(200);
    await me(visitorB.body.accessToken).expect(200);
    // A normal account can still close all its sessions.
    const ana = await login("ana@x.uy", PASS).expect(200);
    await request(app)
      .post("/api/v1/auth/logout-all")
      .set("authorization", `Bearer ${ana.body.accessToken}`)
      .expect(200);
  });

  it("an admin cannot change its role, deactivate it, reset its password or revoke its sessions", async () => {
    const operator = await prisma.user.findUniqueOrThrow({ where: { email: PUBLIC } });
    const admin = { label: "test" };
    for (const attempt of [
      () => usersService().update(operator.id, { role: "admin" }, admin),
      () => usersService().update(operator.id, { active: false }, admin),
      () => usersService().resetPassword(operator.id, "una frase nueva bastante larga", admin),
      () => usersService().assertModifiable(operator.id),
    ]) {
      await expect(attempt()).rejects.toMatchObject({ code: "FORBIDDEN" });
    }
    expect(await prisma.user.findUniqueOrThrow({ where: { email: PUBLIC } })).toMatchObject({
      role: "operator",
      active: true,
    });
    // Other users are managed as usual.
    const ana = await prisma.user.findUniqueOrThrow({ where: { email: "ana@x.uy" } });
    await expect(usersService().assertModifiable(ana.id)).resolves.toMatchObject({
      email: "ana@x.uy",
    });
  });

  it("outside DEMO_MODE the same email is an ordinary account", async () => {
    const service = createUsersService({ repository: users() });
    const operator = await prisma.user.findUniqueOrThrow({ where: { email: PUBLIC } });
    await expect(service.assertModifiable(operator.id)).resolves.toMatchObject({ email: PUBLIC });
  });
});
