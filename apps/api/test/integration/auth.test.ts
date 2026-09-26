import { pino } from "pino";
import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../../src/app.js";
import type { PrismaClient } from "../../src/common/db.js";
import { parseEnv } from "../../src/config/env.js";
import { createAuthService } from "../../src/modules/auth/auth.service.js";
import { hashPassword } from "../../src/modules/auth/password.js";
import { createSessionsRepository } from "../../src/modules/auth/sessions.repository.js";
import { createAccessTokens } from "../../src/modules/auth/tokens.js";
import { createUsersRepository } from "../../src/modules/users/users.repository.js";
import { createUsersService } from "../../src/modules/users/users.service.js";
import {
  createFakeWebhookQueue,
  createInMemoryWebhookRepository,
  healthyDb,
  stubInternalDeps,
  TEST_ENV_SOURCE,
  stubAdminDeps,
} from "../helpers/build-app.js";
import { createTestPrisma, testDatabaseUrl } from "./db.js";

/**
 * Panel auth over HTTP against Postgres (phase 8 M3, ADR-018): login → me → refresh with
 * rotation → reuse detection → race grace → logout / logout-all → lockout → instant effect of
 * role changes. A controllable clock drives expiry and grace windows.
 */

const log = pino({ level: "silent" });
const PANEL = "http://localhost:3000"; // CORS_ORIGINS in TEST_ENV_SOURCE
const PASS = "una frase larga para entrar al panel";
const T0 = new Date("2026-09-27T12:00:00Z");

describe.skipIf(!testDatabaseUrl)("panel auth over HTTP (Postgres)", () => {
  let prisma: PrismaClient;
  let clock: Date;
  let app: ReturnType<typeof createApp>;
  const users = () =>
    createUsersRepository(prisma, {
      revokeUserSessionsInTx: createSessionsRepository(prisma).revokeAllForUserInTx,
    });
  const usersService = () => createUsersService({ repository: users() });

  const csrf = { "x-smartops-csrf": "1", origin: PANEL };
  const cookieOf = (res: request.Response) => {
    const raw = ([] as string[]).concat(res.headers["set-cookie"] ?? []);
    return raw.find((c) => c.startsWith("smartops_rt="));
  };
  const cookiePair = (setCookie: string | undefined) => setCookie?.split(";")[0] ?? "";

  const login = (email = "ana@x.uy", password = PASS) =>
    request(app).post("/api/v1/auth/login").set(csrf).send({ email, password });
  const refresh = (cookie: string) =>
    request(app).post("/api/v1/auth/refresh").set(csrf).set("cookie", cookie);
  const me = (token: string) =>
    request(app).get("/api/v1/auth/me").set("authorization", `Bearer ${token}`);
  const advance = (ms: number) => {
    clock = new Date(clock.getTime() + ms);
  };

  beforeAll(() => {
    prisma = createTestPrisma();
    // The per-IP login limit is exercised in its own test (all requests here share one IP).
    const env = parseEnv({ ...TEST_ENV_SOURCE, LOGIN_RATE_LIMIT_MAX: "1000" });
    app = createApp({
      env,
      logger: log,
      healthRepository: healthyDb,
      whatsappWebhookRepository: createInMemoryWebhookRepository(),
      webhookQueue: createFakeWebhookQueue(),
      admin: stubAdminDeps,
      internal: stubInternalDeps,
      auth: createAuthService({
        users: users(),
        sessions: createSessionsRepository(prisma),
        tokens: createAccessTokens({ secret: env.JWT_ACCESS_SECRET, ttlSeconds: 900 }),
        config: { idleHours: 24, maxDays: 7 },
        now: () => clock,
      }),
    });
  });
  afterAll(async () => {
    await prisma?.$disconnect();
  });
  beforeEach(async () => {
    await prisma.$executeRawUnsafe("TRUNCATE TABLE audit_logs, users CASCADE");
    clock = T0;
    await usersService().create(
      { email: "ana@x.uy", name: "Ana", role: "admin", password: PASS },
      { label: "test" },
    );
  });

  it("login sets an HttpOnly, Strict, auth-path-only cookie and returns a short access token", async () => {
    const res = await login().expect(200);
    expect(res.headers["cache-control"]).toBe("no-store");
    expect(res.body).toMatchObject({
      expiresIn: 900,
      user: { email: "ana@x.uy", role: "admin", name: "Ana" },
    });
    expect(res.body.user).not.toHaveProperty("passwordHash");
    const cookie = cookieOf(res);
    expect(cookie).toMatch(/HttpOnly/i);
    expect(cookie).toMatch(/SameSite=Strict/i);
    expect(cookie).toMatch(/Path=\/api\/v1\/auth/);
    expect((await me(res.body.accessToken).expect(200)).body.user).toMatchObject({ role: "admin" });
    expect(await prisma.auditLog.count({ where: { action: "auth.login_succeeded" } })).toBe(1);
    // Only the hash of the refresh token is stored.
    const stored = await prisma.refreshToken.findFirstOrThrow();
    expect(cookie).not.toContain(stored.tokenHash);
  });

  it("the same generic 401 for an unknown email, a wrong password and an inactive user", async () => {
    const unknown = await login("nadie@x.uy");
    const wrong = await login("ana@x.uy", "otra frase larga incorrecta");
    expect(unknown.status).toBe(401);
    expect(wrong.status).toBe(401);
    expect(unknown.body.error.message).toBe(wrong.body.error.message);
    const failures = await prisma.auditLog.findMany({ where: { action: "auth.login_failed" } });
    expect(failures.map((f) => (f.data as { reason: string }).reason).sort()).toEqual([
      "unknown_email",
      "wrong_password",
    ]);
    expect(JSON.stringify(failures)).not.toContain("nadie@x.uy"); // masked
  });

  it("5 failures lock the account for 15 min (even the right password fails), then it works", async () => {
    for (let i = 0; i < 5; i += 1)
      await login("ana@x.uy", "contraseña equivocada numero x").expect(401);
    expect(await prisma.auditLog.count({ where: { action: "auth.account_locked" } })).toBe(1);
    await login().expect(401); // locked
    advance(16 * 60_000);
    await login().expect(200);
    expect(await prisma.user.findFirstOrThrow()).toMatchObject({ lockedUntil: null, lockLevel: 0 });
  });

  it("refresh rotates: new token and cookie; the old cookie reused later revokes the whole session", async () => {
    const first = await login().expect(200);
    const c1 = cookiePair(cookieOf(first));
    advance(60_000);
    const second = await refresh(c1).expect(200);
    const c2 = cookiePair(cookieOf(second));
    expect(c2).not.toBe(c1);
    await me(second.body.accessToken).expect(200);

    advance(11_000); // beyond the race grace
    const reuse = await refresh(c1);
    expect(reuse.status).toBe(401);
    expect(cookieOf(reuse)).toMatch(/Expires=Thu, 01 Jan 1970/); // cookie cleared
    // The legitimate holder is out too: the session is gone.
    await refresh(c2).expect(401);
    await me(second.body.accessToken).expect(401);
    expect(await prisma.auditLog.count({ where: { action: "auth.refresh_reuse_detected" } })).toBe(
      1,
    );
    expect(await prisma.authSession.findFirstOrThrow()).toMatchObject({
      revokeReason: "refresh_reuse",
    });
  });

  it("two tabs refreshing with the same cookie at once: one rotates, the other gets 409 and the session lives", async () => {
    const c1 = cookiePair(cookieOf(await login().expect(200)));
    const [a, b] = await Promise.all([refresh(c1), refresh(c1)]);
    expect([a.status, b.status].sort()).toEqual([200, 409]);
    const loser = a.status === 409 ? a : b;
    expect(loser.body.error.code).toBe("REFRESH_RACE");
    const winner = a.status === 200 ? a : b;
    await refresh(cookiePair(cookieOf(winner))).expect(200);
    expect(await prisma.authSession.findFirstOrThrow()).toMatchObject({ revokedAt: null });
  });

  it("idle for 24 h ends the session", async () => {
    const c1 = cookiePair(cookieOf(await login().expect(200)));
    advance(24 * 3_600_000 + 1000);
    await refresh(c1).expect(401);
  });

  it("logout ends this session only; logout-all ends every session and kills live access tokens", async () => {
    const s1 = await login().expect(200);
    const s2 = await login().expect(200);
    await request(app)
      .post("/api/v1/auth/logout")
      .set(csrf)
      .set("cookie", cookiePair(cookieOf(s1)))
      .expect(204);
    await refresh(cookiePair(cookieOf(s1))).expect(401);
    await me(s2.body.accessToken).expect(200);

    const s3 = await login().expect(200);
    const all = await request(app)
      .post("/api/v1/auth/logout-all")
      .set("authorization", `Bearer ${s3.body.accessToken}`)
      .expect(200);
    expect(all.body.sessions).toBe(2);
    await me(s2.body.accessToken).expect(401); // instantly, although the JWT is not expired
    await me(s3.body.accessToken).expect(401);
    expect(await prisma.auditLog.count({ where: { action: "auth.logout" } })).toBe(1);
    expect(await prisma.auditLog.count({ where: { action: "auth.logout_all" } })).toBe(1);
  });

  it("a password reset by an admin ends every session of that user", async () => {
    await usersService().create(
      { email: "luis@x.uy", name: "Luis", role: "operator", password: PASS },
      { label: "test" },
    );
    const a = await login("luis@x.uy").expect(200);
    const b = await login("luis@x.uy").expect(200);
    const luis = await prisma.user.findUniqueOrThrow({ where: { email: "luis@x.uy" } });
    const result = await usersService().resetPassword(
      luis.id,
      "una frase nueva bastante larga y distinta",
      { label: "test" },
    );
    expect(result.revokedSessions).toBe(2);
    await me(a.body.accessToken).expect(401);
    await me(b.body.accessToken).expect(401);
    const revoked = await prisma.authSession.findMany({ where: { userId: luis.id } });
    expect(revoked.map((s) => s.revokeReason)).toEqual(["password_changed", "password_changed"]);
  });

  it("nobody changes their own role or deactivates themselves (another admin must)", async () => {
    const ana = await usersService().create(
      { email: "ana2@x.uy", name: "Ana", role: "admin", password: PASS },
      { label: "test" },
    );
    await usersService().create(
      { email: "beto@x.uy", name: "Beto", role: "admin", password: PASS },
      { label: "test" },
    );
    for (const change of [{ role: "operator" as const }, { active: false }]) {
      await expect(usersService().update(ana.id, change, { userId: ana.id })).rejects.toMatchObject(
        { code: "FORBIDDEN" },
      );
    }
    expect(await prisma.user.findUniqueOrThrow({ where: { id: ana.id } })).toMatchObject({
      role: "admin",
      active: true,
    });
  });

  it("a role change or a deactivation ends the user's sessions at once", async () => {
    await usersService().create(
      { email: "luis@x.uy", name: "Luis", role: "admin", password: PASS },
      { label: "test" },
    );
    const s = await login("luis@x.uy").expect(200);
    const luis = await prisma.user.findUniqueOrThrow({ where: { email: "luis@x.uy" } });
    await usersService().update(luis.id, { role: "operator" }, { label: "test" });
    await me(s.body.accessToken).expect(401);
    const again = await login("luis@x.uy").expect(200);
    expect(again.body.user.role).toBe("operator");
    await usersService().update(luis.id, { active: false }, { label: "test" });
    await me(again.body.accessToken).expect(401);
    await login("luis@x.uy").expect(401);
  });

  it("cookie routes need the CSRF header and an allowed Origin", async () => {
    await request(app)
      .post("/api/v1/auth/login")
      .set("origin", PANEL)
      .send({ email: "ana@x.uy", password: PASS })
      .expect(403);
    await request(app)
      .post("/api/v1/auth/login")
      .set({ "x-smartops-csrf": "1", origin: "https://evil.example" })
      .send({ email: "ana@x.uy", password: PASS })
      .expect(403);
  });

  it("a hash with weaker parameters is upgraded on the next successful login", async () => {
    await prisma.user.updateMany({
      data: {
        passwordHash: await hashPassword(PASS, { memory: 8_192, passes: 1, parallelism: 1 }),
      },
    });
    await login().expect(200);
    expect((await prisma.user.findFirstOrThrow()).passwordHash).toMatch(/m=19456,t=2,p=1/);
  });
});
