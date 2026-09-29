import { describe, expect, it } from "vitest";
import { userErrorKey } from "../src/features/users/errors";
import { ApiError } from "../src/lib/api-client";

/** User management errors → message keys (phase 9 M6; keys since phase 13). */

describe("userErrorKey", () => {
  it("last admin, own role, duplicate email, password policy", () => {
    expect(
      userErrorKey(
        new ApiError(409, "CONFLICT", "The last active admin cannot be demoted or deactivated"),
      ),
    ).toEqual({ key: "lastAdmin" });
    expect(userErrorKey(new ApiError(403, "FORBIDDEN", "x"))).toEqual({ key: "ownRole" });
    expect(userErrorKey(new ApiError(409, "CONFLICT", "A user with that email exists"))).toEqual({
      key: "emailTaken",
    });
    expect(
      userErrorKey(
        new ApiError(400, "VALIDATION_ERROR", "Password does not meet the policy", [
          { message: "At least 15 characters." },
        ]),
      ),
    ).toEqual({ key: "invalid", details: ["At least 15 characters."] });
  });

  it("anything else: the request id when there is one", () => {
    expect(userErrorKey(new ApiError(500, "INTERNAL", "x", undefined, "req-1"))).toEqual({
      key: "withCode",
      params: { requestId: "req-1" },
    });
    expect(userErrorKey(new ApiError(500, "INTERNAL", "x"))).toEqual({ key: "noCode" });
    expect(userErrorKey(new Error("offline"))).toEqual({ key: "generic" });
  });
});
