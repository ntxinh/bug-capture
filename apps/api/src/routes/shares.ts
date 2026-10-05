import { createHash, getRandomValues } from "node:crypto";
import type { Db } from "@bugcapture/db";
import { reportShares, reports } from "@bugcapture/db/schema";
import { and, eq, gt, isNull, or } from "drizzle-orm";
import { Hono } from "hono";
import { z } from "zod";
import type { Auth } from "../lib/auth";
import { reportInOrg } from "../lib/policy";
import { requireAuth } from "../lib/session";
import { zjson } from "../lib/validate";

function mintToken() {
  return `oj_${Buffer.from(getRandomValues(new Uint8Array(24))).toString("base64url")}`;
}
function hashToken(t: string) {
  return createHash("sha256").update(t).digest("hex");
}

export function sharesRoutes(db: Db, auth: Auth, baseUrl: string) {
  const authed = new Hono();
  authed.use("*", requireAuth(auth, db));

  authed.post(
    "/reports/:reportId/shares",
    zjson("json", z.object({ expiresAt: z.string().datetime().optional() })),
    async (c) => {
      const r = await reportInOrg(db, c.var.orgId, c.req.param("reportId"));
      if (!r) return c.json({ error: "not found" }, 404);
      const token = mintToken();
      const { expiresAt } = c.req.valid("json");
      const [row] = await db
        .insert(reportShares)
        .values({
          id: crypto.randomUUID(),
          reportId: r.id,
          tokenHash: hashToken(token),
          expiresAt: expiresAt ? new Date(expiresAt) : null,
          createdBy: c.var.user.id,
        })
        .returning();
      // Raw token shown exactly once:
      return c.json({ id: row.id, shareUrl: `${baseUrl}/r/${token}` }, 201);
    },
  );

  authed.delete("/shares/:id", async (c) => {
    // share → report → org check, then revoke
    const [s] = await db
      .select()
      .from(reportShares)
      .where(eq(reportShares.id, c.req.param("id")));
    if (!s) return c.json({ error: "not found" }, 404);
    const r = await reportInOrg(db, c.var.orgId, s.reportId);
    if (!r) return c.json({ error: "not found" }, 404);
    await db
      .update(reportShares)
      .set({ revokedAt: new Date() })
      .where(eq(reportShares.id, s.id));
    return c.body(null, 204);
  });

  // public lookup — separate router, no auth
  const pub = new Hono();
  pub.get("/r/:token", async (c) => {
    const h = hashToken(c.req.param("token"));
    const [s] = await db
      .select()
      .from(reportShares)
      .where(
        and(
          eq(reportShares.tokenHash, h),
          isNull(reportShares.revokedAt),
          or(
            isNull(reportShares.expiresAt),
            gt(reportShares.expiresAt, new Date()),
          ),
        ),
      );
    if (!s) return c.json({ error: "not found" }, 404);
    const [r] = await db
      .select()
      .from(reports)
      .where(eq(reports.id, s.reportId));
    if (!r) return c.json({ error: "not found" }, 404);
    return c.json({
      id: r.id,
      title: r.title,
      status: r.status,
      createdAt: r.createdAt,
    });
  });

  return { authed, pub };
}
