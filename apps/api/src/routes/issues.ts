import type { Db } from "@bugcapture/db";
import { externalLinks, projectIntegrations } from "@bugcapture/db/schema";
import { and, eq } from "drizzle-orm";
import { Hono } from "hono";
import type { Auth } from "../lib/auth";
import { unsealConfig } from "../lib/integration-config";
import { emitReportEvent } from "../lib/outbox";
import { isMember, reportInOrg } from "../lib/policy";
import { requireAuth } from "../lib/session";
import { type GitHubConfig, GitHubIssueTracker } from "../lib/trackers";

export function issuesRoutes(db: Db, auth: Auth, baseUrl: string) {
  const r = new Hono();
  r.use("/reports/*", requireAuth(auth, db));

  r.post("/reports/:id/issues", async (c) => {
    if (!(await isMember(db, c.var.user.id, c.var.orgId)))
      return c.json({ error: "forbidden" }, 403);
    const rep = await reportInOrg(db, c.var.orgId, c.req.param("id"));
    if (!rep) return c.json({ error: "not found" }, 404);
    const [int] = await db
      .select()
      .from(projectIntegrations)
      .where(
        and(
          eq(projectIntegrations.projectId, rep.projectId),
          eq(projectIntegrations.provider, "github"),
          eq(projectIntegrations.enabled, true),
        ),
      );
    if (!int) return c.json({ error: "no github integration" }, 404);
    const reportUrl = `${baseUrl}/app/report.html?id=${rep.id}`;
    let cfg: GitHubConfig;
    try {
      cfg = unsealConfig(
        int.config as Record<string, unknown>,
      ) as unknown as GitHubConfig;
    } catch {
      return c.json({ error: "integrations key not configured" }, 503);
    }
    let link: { externalId: string; url: string };
    try {
      link = await new GitHubIssueTracker().createIssue(
        { ...rep, url: reportUrl },
        cfg,
      );
    } catch {
      return c.json({ error: "github upstream" }, 502);
    }
    await db.transaction(async (tx) => {
      await tx.insert(externalLinks).values({
        id: crypto.randomUUID(),
        reportId: rep.id,
        provider: "github",
        externalId: link.externalId,
        url: link.url,
      });
      await emitReportEvent(tx, "issue.linked", rep.id, {
        title: rep.title,
        status: rep.status,
        url: reportUrl,
        externalUrl: link.url,
      });
    });
    return c.json(link, 201);
  });

  return r;
}
