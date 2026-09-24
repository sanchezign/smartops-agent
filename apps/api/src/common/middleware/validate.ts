import type { RequestHandler, Response } from "express";
import type { z, ZodType } from "zod";
import { errors } from "../errors/app-error.js";

type Part = "body" | "params" | "query";
type Schemas = Partial<Record<Part, ZodType>>;

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Locals {
      /** Parsed output of validate(); Express 5's req.query is read-only. */
      validated?: Partial<Record<Part, unknown>>;
    }
  }
}

/**
 * Validates body/params/query with Zod. Parsed values go to res.locals.validated
 * (and replace req.body). Failures → 400 VALIDATION_ERROR with per-field details.
 */
export function validate(schemas: Schemas): RequestHandler {
  return (req, res, next) => {
    const validated: Partial<Record<Part, unknown>> = {};
    const details: { location: Part; path: string; message: string; code: string }[] = [];

    for (const part of ["params", "query", "body"] as const) {
      const schema = schemas[part];
      if (!schema) continue;
      const result = schema.safeParse(req[part]);
      if (result.success) {
        validated[part] = result.data;
      } else {
        for (const issue of result.error.issues) {
          details.push({
            location: part,
            path: issue.path.join("."),
            message: issue.message,
            code: issue.code,
          });
        }
      }
    }

    if (details.length > 0) {
      next(errors.validation(details));
      return;
    }
    if (schemas.body) req.body = validated.body;
    res.locals.validated = validated;
    next();
  };
}

/** Typed accessor for controllers: `const body = getValidated<typeof createSchema>(res, "body")`. */
export function getValidated<S extends ZodType>(res: Response, part: Part): z.output<S> {
  return res.locals.validated?.[part] as z.output<S>;
}
