import { createHash, getRandomValues, randomUUID } from "node:crypto";
import type { Db } from "@bugcapture/db";
import { personalAccessTokens } from "@bugcapture/db/schema";
import { and, eq, isNull } from "drizzle-orm";
import { Hono } from "hono";
import { z } from "zod";
import type { Auth } from "../lib/auth";
import { isUniqueViolation } from "../lib/errors";
import { requireAuth } from "../lib/session";
import { zjson } from "../lib/validate";

const mintToken = () =>
  `oj_pat_${Buffer.from(getRandomValues(new Uint8Array(24))).toString("base64url")}`;

export function tokensRoutes(db: Db, auth: Auth) {
  const r = new Hono();
  r.use("*", requireAuth(auth, db));
  // session-only: a PAT must not mint, list, or revoke tokens
  r.use("*", async (c, next) =>
    c.var.authKind === "pat" ? c.json({ error: "forbidden" }, 403) : next(),
  );

  r.get("/", async (c) =>
    c.json(
      await db
        .select({
          id: personalAccessTokens.id,
          label: personalAccessTokens.label,
          createdAt: personalAccessTokens.createdAt,
          lastUsedAt: personalAccessTokens.lastUsedAt,
          revokedAt: personalAccessTokens.revokedAt,
        })
        .from(personalAccessTokens)
        .where(eq(personalAccessTokens.organizationId, c.var.orgId)),
    ),
  );

  r.post(
    "/",
    zjson("json", z.object({ label: z.string().min(1).max(80) })),
    async (c) => {
      const row = {
        id: randomUUID(),
        userId: c.var.user.id,
        organizationId: c.var.orgId,
        label: c.req.valid("json").label,
        tokenHash: "",
      };
      let token = mintToken();
      for (let attempt = 0; attempt < 2; attempt++) {
        row.tokenHash = createHash("sha256").update(token).digest("hex");
        try {
          await db.insert(personalAccessTokens).values(row);
          return c.json({ id: row.id, label: row.label, token }, 201);
        } catch (e) {
          if (attempt === 0 && isUniqueViolation(e)) {
            token = mintToken(); // astronomically rare hash collision: regen once
            continue;
          }
          throw e;
        }
      }
      throw new Error("unreachable");
    },
  );

  r.delete("/:id", async (c) => {
    const [row] = await db
      .update(personalAccessTokens)
      .set({ revokedAt: new Date() })
      .where(
        and(
          eq(personalAccessTokens.id, c.req.param("id")),
          eq(personalAccessTokens.organizationId, c.var.orgId),
          isNull(personalAccessTokens.revokedAt),
        ),
      )
      .returning();
    if (!row) return c.json({ error: "not found" }, 404);
    return c.body(null, 204);
  });

  return r;
}
