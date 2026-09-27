import { describe, expect, it } from "vitest";
import {
  EMPTY_LOCKOUT,
  isLocked,
  lockDurationMs,
  registerFailure,
  registerSuccess,
  type LockoutState,
} from "../../src/modules/auth/login-lockout.js";
import { hashPassword, parsePhc, verifyPassword } from "../../src/modules/auth/password.js";
import { checkPassword } from "../../src/modules/auth/password-policy.js";

const GOOD = "caballo correcto batería grapa";

describe("Argon2id hashing (OWASP minimum, PHC string)", () => {
  it("hashes to a PHC string with the OWASP parameters and a random salt", async () => {
    const a = await hashPassword(GOOD);
    const b = await hashPassword(GOOD);
    expect(a).toMatch(/^\$argon2id\$v=19\$m=19456,t=2,p=1\$[A-Za-z0-9+/]+\$[A-Za-z0-9+/]+$/);
    expect(a).not.toBe(b); // different salts
    expect(parsePhc(a)?.hash.length).toBe(32);
  });

  it("verifies the right password only", async () => {
    const stored = await hashPassword(GOOD);
    expect(await verifyPassword(stored, GOOD)).toEqual({ ok: true, needsRehash: false });
    expect((await verifyPassword(stored, `${GOOD}!`)).ok).toBe(false);
  });

  it("normalizes Unicode (NFKC): the same passphrase typed differently matches", async () => {
    const composed = "contraseña larga de prueba ñandú"; // precomposed ñ / ú
    const decomposed = composed.normalize("NFD");
    const stored = await hashPassword(composed);
    expect((await verifyPassword(stored, decomposed)).ok).toBe(true);
  });

  it("asks for a rehash when the stored parameters are weaker than the current ones", async () => {
    const weak = await hashPassword(GOOD, { memory: 8_192, passes: 1, parallelism: 1 });
    expect(await verifyPassword(weak, GOOD)).toEqual({ ok: true, needsRehash: true });
    expect(await verifyPassword(weak, "wrong password here!!")).toEqual({
      ok: false,
      needsRehash: false,
    });
  });

  it("rejects malformed stored values instead of throwing", async () => {
    expect(await verifyPassword("plaintext", GOOD)).toEqual({ ok: false, needsRehash: false });
    expect(await verifyPassword("$argon2i$v=19$m=1,t=1,p=1$x$y", GOOD)).toMatchObject({
      ok: false,
    });
  });
});

describe("password policy (OWASP / NIST 800-63B)", () => {
  it("accepts a long passphrase with any characters and no composition rules", () => {
    expect(checkPassword(GOOD)).toEqual([]);
    expect(checkPassword("solo minusculas y espacios")).toEqual([]);
    expect(checkPassword("🌵 cactus del desierto 🌵")).toEqual([]);
  });

  it.each([
    ["short", "corta123", "too_short"],
    ["exactly 14", "abcdefghijklm!", "too_short"],
    ["too long", "a b ".repeat(40), "too_long"],
    ["repeated char", "aaaaaaaaaaaaaaaa", "trivial_pattern"],
    ["repeated chunk", "abcabcabcabcabcabc", "trivial_pattern"],
    ["number sequence", "123456789012345", "trivial_pattern"],
    ["keyboard row", "qwertyuiopasdfgh", "trivial_pattern"],
    ["known long password", "1q2w3e4r5t6y7u8i9o0p", "common"],
  ])("rejects %s", (_label, password, issue) => {
    expect(checkPassword(password)).toContain(issue);
  });

  it("rejects passwords containing the email, the name or the product name", () => {
    expect(
      checkPassword("hola soy ana.perez y esta es mi clave", { email: "ana.perez@x.uy" }),
    ).toContain("contains_personal_info");
    expect(
      checkPassword("mi apellido es Rodriguez larguisimo", { name: "Ana Rodriguez" }),
    ).toContain("contains_personal_info");
    expect(checkPassword("la clave de SmartOps del panel")).toContain("contains_personal_info");
  });

  it("measures length in characters, not bytes", () => {
    expect(checkPassword("ñandúñandúñandúx")).not.toContain("too_short"); // 16 chars, >16 bytes
  });
});

describe("login lockout (5 in 15 min → 15 min, doubling, capped at 1 h)", () => {
  const t0 = new Date("2026-09-27T10:00:00Z");
  const at = (min: number) => new Date(t0.getTime() + min * 60_000);
  const fail = (state: LockoutState, when: Date) => registerFailure(state, when);

  function failTimes(state: LockoutState, count: number, start: Date) {
    let s = state;
    let lockedNow = false;
    for (let i = 0; i < count; i += 1) {
      const r = fail(s, new Date(start.getTime() + i * 1000));
      s = r.next;
      lockedNow = r.lockedNow;
    }
    return { state: s, lockedNow };
  }

  it("locks on the 5th failure within the window, for 15 min", () => {
    const four = failTimes(EMPTY_LOCKOUT, 4, t0);
    expect(four.lockedNow).toBe(false);
    expect(isLocked(four.state, at(1))).toBe(false);
    const five = failTimes(EMPTY_LOCKOUT, 5, t0);
    expect(five.lockedNow).toBe(true);
    expect(isLocked(five.state, at(14))).toBe(true);
    expect(isLocked(five.state, at(16))).toBe(false);
  });

  it("failures spread beyond 15 min do not accumulate", () => {
    let s = EMPTY_LOCKOUT;
    for (let i = 0; i < 10; i += 1) s = fail(s, at(i * 16)).next;
    expect(s.lockedUntil).toBeNull();
    expect(s.failedCount).toBe(1);
  });

  it("each consecutive lock doubles, capped at 1 h", () => {
    expect([0, 1, 2, 3, 4].map(lockDurationMs)).toEqual(
      [15, 30, 60, 60, 60].map((m) => m * 60_000),
    );
  });

  it("failures while locked do not extend the lock; a success resets everything", () => {
    const locked = failTimes(EMPTY_LOCKOUT, 5, t0).state;
    const again = fail(locked, at(5));
    expect(again.next).toEqual(locked);
    // Mutation testing finding (phase 10 M9): a failed attempt against an ALREADY locked
    // account must never report lockedNow: true (that would mean "just now locked", which
    // could trigger a duplicate lock notification / audit entry for every retry).
    expect(again.lockedNow).toBe(false);
    expect(registerSuccess()).toEqual(EMPTY_LOCKOUT);
  });

  it("lockLevel only ever increases across consecutive lockouts, doubling the duration each time (mutation finding)", () => {
    // Stryker survivor: `lockLevel: state.lockLevel + 1` mutated to `- 1` would make the level
    // go negative and the lock duration SHRINK instead of doubling on repeated lockouts.
    // The 5th (locking) failure of a batch of `count` lands at `start + (count - 1) * 1000 ms`.
    const first = failTimes(EMPTY_LOCKOUT, 5, t0);
    const firstLockedAt = new Date(t0.getTime() + 4 * 1000);
    expect(first.state.lockLevel).toBe(1);
    expect(first.state.lockedUntil!.getTime() - firstLockedAt.getTime()).toBe(15 * 60_000);

    // Past the first lock: five more failures trigger the SECOND lockout, doubled.
    const secondStart = at(16);
    const second = failTimes(first.state, 5, secondStart);
    const secondLockedAt = new Date(secondStart.getTime() + 4 * 1000);
    expect(second.state.lockLevel).toBe(2);
    expect(second.state.lockedUntil!.getTime() - secondLockedAt.getTime()).toBe(30 * 60_000);
  });
});
