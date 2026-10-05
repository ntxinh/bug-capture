import { createHash } from "node:crypto";
import type { Db } from "@bugcapture/db";
import { personalAccessTokens, user } from "@bugcapture/db/schema";
import { and, eq, isNull } from "drizzle-orm";
import { createMiddleware } from "hono/factory";
import type { Auth } from "./auth";

export type SessionUser = { id: string; email: string; name: string };

declare module "hono" {
  interface ContextVariableMap {
    user: SessionUser;
    orgId: string;
    authKind: "session" | "pat";
  }
}

export function requireAuth(auth: Auth, db: Db) {
  return createMiddleware(async (c, next) => {
    const bearer = c.req.header("authorization");
    if (bearer?.startsWith("Bearer oj_pat_")) {
      const hash = createHash("sha256").update(bearer.slice(7)).digest("hex");
      const [row] = await db
        .select({
          t: personalAccessTokens,
          u: { id: user.id, email: user.email, name: user.name },
        })
        .from(personalAccessTokens)
        .innerJoin(user, eq(user.id, personalAccessTokens.userId))
        .where(
          and(
            eq(personalAccessTokens.tokenHash, hash),
            isNull(personalAccessTokens.revokedAt),
          ),
        );
      if (!row) return c.json({ error: "unauthorized" }, 401);
      c.set("user", row.u);
      c.set("orgId", row.t.organizationId);
      c.set("authKind", "pat");
      db.update(personalAccessTokens)
        .set({ lastUsedAt: new Date() })
        .where(eq(personalAccessTokens.id, row.t.id))
        .execute()
        .catch(() => {});
      await next();
      return;
    }
    const session = await auth.api.getSession({ headers: c.req.raw.headers });
    if (!session) return c.json({ error: "unauthorized" }, 401);
    const orgId = session.session.activeOrganizationId;
    if (!orgId) return c.json({ error: "no active organization" }, 400);
    c.set("user", {
      id: session.user.id,
      email: session.user.email,
      name: session.user.name,
    });
    c.set("orgId", orgId);
    c.set("authKind", "session");
    await next();
  });
}
