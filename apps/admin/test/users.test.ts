import { describe, expect, it } from "vitest";
import { userErrorMessage } from "../src/features/users/errors";
import { ApiError } from "../src/lib/api-client";

/** User management errors in plain language (phase 9 M6). */

describe("userErrorMessage", () => {
  it("last admin, own role, duplicate email, password policy", () => {
    expect(
      userErrorMessage(
        new ApiError(409, "CONFLICT", "The last active admin cannot be demoted or deactivated"),
      ),
    ).toMatch(/sin un administrador activo/);
    expect(userErrorMessage(new ApiError(403, "FORBIDDEN", "x"))).toMatch(/propio rol/);
    expect(userErrorMessage(new ApiError(409, "CONFLICT", "A user with that email exists"))).toBe(
      "Ya hay un usuario con ese email.",
    );
    expect(
      userErrorMessage(
        new ApiError(400, "VALIDATION_ERROR", "Password does not meet the policy", [
          { message: "Mínimo 15 caracteres." },
        ]),
      ),
    ).toBe("Mínimo 15 caracteres.");
  });
});
