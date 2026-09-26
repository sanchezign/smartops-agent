import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { PrismaClient } from "../../src/common/db.js";
import { verifyPassword } from "../../src/modules/auth/password.js";
import { createUsersRepository } from "../../src/modules/users/users.repository.js";
import { createUsersService } from "../../src/modules/users/users.service.js";
import { createTestPrisma, testDatabaseUrl } from "./db.js";

/** Users + passwords against Postgres (phase 8 M2, ADR-018). */

const PASS = "una frase larga para el panel de prueba";
const cli = { label: "cli:test" };

describe.skipIf(!testDatabaseUrl)("users (Postgres)", () => {
  let prisma: PrismaClient;
  const service = () => createUsersService({ repository: createUsersRepository(prisma) });

  beforeAll(() => {
    prisma = createTestPrisma();
  });
  afterAll(async () => {
    await prisma?.$disconnect();
  });
  beforeEach(async () => {
    await prisma.$executeRawUnsafe("TRUNCATE TABLE audit_logs, users CASCADE");
  });

  it("creates a user with an Argon2id hash (never the password) and audits it", async () => {
    const user = await service().create(
      { email: "  Ana@Ferreteria.UY ", name: "Ana", role: "admin", password: PASS },
      cli,
    );
    expect(user).toMatchObject({ email: "ana@ferreteria.uy", role: "admin", active: true });
    expect(user).not.toHaveProperty("passwordHash");
    const row = await prisma.user.findUniqueOrThrow({ where: { id: user.id } });
    expect(row.passwordHash).toMatch(/^\$argon2id\$/);
    expect(row.passwordHash).not.toContain(PASS);
    expect((await verifyPassword(row.passwordHash, PASS)).ok).toBe(true);
    const audit = await prisma.auditLog.findMany();
    expect(audit).toEqual([
      expect.objectContaining({
        action: "user.created",
        entity: "user",
        entityId: user.id,
        actorType: "system",
        data: { role: "admin", actor: "cli:test" },
      }),
    ]);
    expect(JSON.stringify(audit)).not.toContain(PASS);
  });

  it("refuses a weak password (policy) and a duplicate email", async () => {
    await expect(
      service().create({ email: "a@x.uy", name: "A", role: "operator", password: "corta" }, cli),
    ).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    await service().create({ email: "a@x.uy", name: "A", role: "operator", password: PASS }, cli);
    await expect(
      service().create({ email: "A@X.UY", name: "B", role: "operator", password: PASS }, cli),
    ).rejects.toMatchObject({ code: "CONFLICT" });
  });

  it("never leaves the system without an active admin (demote / deactivate)", async () => {
    const admin = await service().create(
      { email: "admin@x.uy", name: "Admin", role: "admin", password: PASS },
      cli,
    );
    await expect(service().update(admin.id, { role: "operator" }, cli)).rejects.toMatchObject({
      code: "CONFLICT",
    });
    await expect(service().update(admin.id, { active: false }, cli)).rejects.toMatchObject({
      code: "CONFLICT",
    });
    const second = await service().create(
      { email: "admin2@x.uy", name: "Segunda", role: "admin", password: PASS },
      cli,
    );
    await service().update(admin.id, { role: "operator" }, cli); // allowed now
    const audit = await prisma.auditLog.findFirstOrThrow({
      where: { action: "user.role_changed" },
    });
    expect(audit).toMatchObject({ entityId: admin.id, data: { from: "admin", to: "operator" } });
    await expect(service().update(second.id, { active: false }, cli)).rejects.toMatchObject({
      code: "CONFLICT",
    });
  });

  it("two admins demoting each other at the same time: exactly one wins", async () => {
    const a = await service().create(
      { email: "a@x.uy", name: "Aaaa", role: "admin", password: PASS },
      cli,
    );
    const b = await service().create(
      { email: "b@x.uy", name: "Bbbb", role: "admin", password: PASS },
      cli,
    );
    const results = await Promise.allSettled([
      service().update(a.id, { role: "operator" }, { userId: b.id }),
      service().update(b.id, { role: "operator" }, { userId: a.id }),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(await prisma.user.count({ where: { role: "admin", active: true } })).toBe(1);
  });

  it("reset-password applies the policy, resets the lockout and is audited", async () => {
    const user = await service().create(
      { email: "op@x.uy", name: "Operadora", role: "operator", password: PASS },
      cli,
    );
    await prisma.user.update({
      where: { id: user.id },
      data: { failedLoginCount: 3, lockedUntil: new Date(Date.now() + 60_000), lockLevel: 2 },
    });
    await expect(service().resetPassword(user.id, "123456789012345", cli)).rejects.toMatchObject({
      code: "VALIDATION_ERROR",
    });
    const next = "otra frase distinta y bien larga";
    await service().resetPassword(user.id, next, cli);
    const row = await prisma.user.findUniqueOrThrow({ where: { id: user.id } });
    expect(row).toMatchObject({ failedLoginCount: 0, lockedUntil: null, lockLevel: 0 });
    expect((await verifyPassword(row.passwordHash, next)).ok).toBe(true);
    expect(await prisma.auditLog.count({ where: { action: "user.password_reset" } })).toBe(1);
  });

  it("unlock clears a lock and is audited", async () => {
    const user = await service().create(
      { email: "op@x.uy", name: "Operadora", role: "operator", password: PASS },
      cli,
    );
    await prisma.user.update({
      where: { id: user.id },
      data: { lockedUntil: new Date(Date.now() + 60_000), lockLevel: 1 },
    });
    await service().unlock(user.id, cli);
    expect(await prisma.user.findUniqueOrThrow({ where: { id: user.id } })).toMatchObject({
      lockedUntil: null,
      lockLevel: 0,
    });
    expect(await prisma.auditLog.count({ where: { action: "user.unlocked" } })).toBe(1);
  });
});
