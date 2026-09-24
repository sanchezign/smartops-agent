import { describe, expect, it } from "vitest";
import { z } from "zod";
import { AppError, errors } from "../../src/common/errors/app-error.js";
import { mapError } from "../../src/common/errors/error-handler.js";
import { Prisma } from "../../src/generated/prisma/client.js";

const prod = { isProduction: true, requestId: "req-1" };
const dev = { isProduction: false, requestId: "req-1" };

function prismaError(code: string) {
  return new Prisma.PrismaClientKnownRequestError("db error", { code, clientVersion: "7.10.0" });
}

describe("mapError", () => {
  it("maps AppError to its status, code, message and details", () => {
    const mapped = mapError(errors.conflict("Duplicated", { field: "waId" }), prod);
    expect(mapped.statusCode).toBe(409);
    expect(mapped.unexpected).toBe(false);
    expect(mapped.body).toEqual({
      error: {
        code: "CONFLICT",
        message: "Duplicated",
        details: { field: "waId" },
        requestId: "req-1",
      },
    });
  });

  it("maps ZodError to 400 VALIDATION_ERROR with per-field details", () => {
    const result = z.object({ price: z.number().positive() }).safeParse({ price: -1 });
    expect(result.success).toBe(false);
    const mapped = mapError(result.error, prod);
    expect(mapped.statusCode).toBe(400);
    expect(mapped.body.error.code).toBe("VALIDATION_ERROR");
    expect(mapped.body.error.details).toEqual([
      expect.objectContaining({ path: "price", code: "too_small" }),
    ]);
  });

  it("maps Prisma P2002 (unique violation) to 409 CONFLICT", () => {
    const mapped = mapError(prismaError("P2002"), prod);
    expect(mapped.statusCode).toBe(409);
    expect(mapped.body.error.code).toBe("CONFLICT");
  });

  it("maps Prisma P2025 (record not found) to 404 NOT_FOUND", () => {
    expect(mapError(prismaError("P2025"), prod).statusCode).toBe(404);
  });

  it("treats other Prisma errors as unexpected 500s", () => {
    const mapped = mapError(prismaError("P1001"), prod);
    expect(mapped.statusCode).toBe(500);
    expect(mapped.unexpected).toBe(true);
  });

  it("hides internal messages in production", () => {
    const mapped = mapError(new Error("password=hunter2 leaked"), prod);
    expect(mapped.statusCode).toBe(500);
    expect(mapped.body.error).toEqual({
      code: "INTERNAL_ERROR",
      message: "Internal server error",
      requestId: "req-1",
    });
  });

  it("shows the internal message outside production", () => {
    expect(mapError(new Error("boom"), dev).body.error.message).toBe("boom");
  });

  it("handles non-Error throwables", () => {
    expect(mapError("a string", prod).body.error.code).toBe("INTERNAL_ERROR");
  });

  it("keeps custom AppError 5xx as unexpected", () => {
    expect(mapError(new AppError(503, "SERVICE_UNAVAILABLE", "down"), prod).unexpected).toBe(true);
  });
});
