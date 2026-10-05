import { zValidator } from "@hono/zod-validator";
import type { ValidationTargets } from "hono";
import type { z } from "zod";

/**
 * zValidator with a consistent domain error shape:
 * `{ error: "invalid request", issues }` + 400 instead of zValidator's
 * default `{ success: false, error: ZodError }`.
 */
export const zjson = <T extends keyof ValidationTargets, S extends z.ZodType>(
  target: T,
  schema: S,
) =>
  zValidator(target, schema, (result, c) => {
    if (!result.success) {
      return c.json(
        { error: "invalid request", issues: result.error.issues },
        400,
      );
    }
  });
