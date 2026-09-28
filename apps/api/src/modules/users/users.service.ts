import { z } from "zod";
import { errors } from "../../common/errors/app-error.js";
import type { UserRole } from "../../generated/prisma/enums.js";
import { EMPTY_LOCKOUT } from "../auth/login-lockout.js";
import { hashPassword } from "../auth/password.js";
import { checkPassword, PASSWORD_ISSUE_TEXT } from "../auth/password-policy.js";
import {
  NO_PUBLIC_ACCOUNT,
  PUBLIC_ACCOUNT_REFUSED,
  type PublicAccount,
} from "../demo/public-account.js";
import type { AuditActor, PublicUser, UsersRepository } from "./users.repository.js";

/**
 * User management (phase 8, ADR-018): used by the CLI (`users:*`, the ONLY way to create the
 * first admin — no default password, no HTTP bootstrap) and by the admin routes (M4).
 */

export const emailSchema = z.string().trim().toLowerCase().pipe(z.email().max(254));
export const nameSchema = z.string().trim().min(1).max(120);
export const roleSchema = z.enum(["admin", "operator"]);

export function assertPasswordPolicy(
  password: string,
  context: { email?: string | null; name?: string | null },
): void {
  const issues = checkPassword(password, context);
  if (issues.length > 0) {
    throw errors.validation(
      issues.map((code) => ({ path: ["password"], code, message: PASSWORD_ISSUE_TEXT[code] })),
      "Password does not meet the policy",
    );
  }
}

export function createUsersService(deps: {
  repository: UsersRepository;
  /** The shared public demo operator (DEMO_MODE): not modifiable from the panel. */
  publicAccount?: PublicAccount;
}) {
  const { repository } = deps;
  const publicAccount = deps.publicAccount ?? NO_PUBLIC_ACCOUNT;

  async function mustFind(id: string) {
    const user = await repository.findById(id);
    if (!user) throw errors.notFound("User not found");
    return user;
  }

  /**
   * The public demo operator is shared by every visitor (phase 12): a role / active / password
   * change or a session revocation would hit all of them and outlive the demo reset.
   */
  async function assertModifiable(id: string) {
    const user = await mustFind(id);
    if (publicAccount.isPublic(user.email)) throw errors.forbidden(PUBLIC_ACCOUNT_REFUSED);
    return user;
  }

  return {
    list: () => repository.list(),

    async create(
      input: { email: string; name: string; role: UserRole; password: string },
      actor: AuditActor,
    ): Promise<PublicUser> {
      const email = emailSchema.parse(input.email);
      const name = nameSchema.parse(input.name);
      const role = roleSchema.parse(input.role);
      assertPasswordPolicy(input.password, { email, name });
      if (await repository.findByEmail(email))
        throw errors.conflict("A user with that email exists");
      return repository.create(
        { email, name, role, passwordHash: await hashPassword(input.password) },
        actor,
      );
    },

    assertModifiable,

    async update(id: string, change: { role?: UserRole; active?: boolean }, actor: AuditActor) {
      if (change.role !== undefined) roleSchema.parse(change.role);
      if (publicAccount.email !== null) await assertModifiable(id);
      // Nobody changes their own role or deactivates themselves (user rule, phase 9 M6): another
      // admin has to do it, so a mistake cannot lock the only person who could fix it.
      if (actor.userId === id && (change.role !== undefined || change.active === false)) {
        throw errors.forbidden("You cannot change your own role or deactivate yourself");
      }
      const result = await repository.update(id, change, actor);
      if (result === "not_found") throw errors.notFound("User not found");
      if (result === "last_admin")
        throw errors.conflict("The last active admin cannot be demoted or deactivated");
      return result;
    },

    async resetPassword(id: string, password: string, actor: AuditActor) {
      const user = await assertModifiable(id);
      assertPasswordPolicy(password, { email: user.email, name: user.name });
      const revokedSessions = await repository.setPassword(
        id,
        await hashPassword(password),
        actor,
        {
          revokeSessions: true,
          audit: true,
        },
      );
      return { revokedSessions };
    },

    async unlock(id: string, actor: AuditActor) {
      await mustFind(id);
      await repository.saveLockout(id, EMPTY_LOCKOUT);
      await repository.audit({ action: "user.unlocked", entityId: id }, actor);
    },

    async findByEmail(email: string) {
      return repository.findByEmail(emailSchema.parse(email));
    },
  };
}
export type UsersService = ReturnType<typeof createUsersService>;
