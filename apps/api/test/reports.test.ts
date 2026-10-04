import { describe, expect, it } from "bun:test";
import { member, reportArtifacts, reportShares } from "@bugcapture/db/schema";
import { z } from "zod";
import { signUpAndOrg, type TestCtx, withTestDb } from "./helpers";

const reportSchema = z.object({
  id: z.string(),
  projectId: z.string(),
  environmentId: z.string().nullable(),
  title: z.string(),
  status: z.string(),
  createdBy: z.string(),
});

const shareSchema = z.looseObject({
  id: z.string(),
  visibility: z.string(),
  expiresAt: z.string().nullable(),
  createdAt: z.string(),
  revokedAt: z.string().nullable(),
});

const detailSchema = z.object({
  id: z.string(),
  artifacts: z.array(z.object({ id: z.string(), type: z.string() })),
  shares: z.array(shareSchema),
});

async function createProject(app: TestCtx["app"], cookie: string, slug = "p") {
  const r = await app.request("/api/v1/projects", {
    method: "POST",
    headers: { "content-type": "application/json", cookie },
    body: JSON.stringify({ name: "P", slug }),
  });
  return z.object({ id: z.string() }).parse(await r.json());
}

async function createReport(
  app: TestCtx["app"],
  cookie: string,
  body: Record<string, unknown>,
) {
  return app.request("/api/v1/reports", {
    method: "POST",
    headers: { "content-type": "application/json", cookie },
    body: JSON.stringify(body),
  });
}

/** Sign up a user (no org), add them as plain member of orgId, activate that org. */
async function signUpMember(
  app: TestCtx["app"],
  db: TestCtx["db"],
  orgId: string,
  email: string,
) {
  const signUp = await app.request("/api/auth/sign-up/email", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email, password: "password123!", name: "M" }),
  });
  const cookie = signUp.headers.get("set-cookie")?.split(";")[0];
  if (!cookie) throw new Error("no session cookie");
  const { user: u } = z
    .object({ user: z.object({ id: z.string() }) })
    .parse(await signUp.json());
  await db.insert(member).values({
    id: crypto.randomUUID(),
    organizationId: orgId,
    userId: u.id,
    role: "member",
    createdAt: new Date(),
  });
  const setActive = await app.request("/api/auth/organization/set-active", {
    method: "POST",
    headers: { "content-type": "application/json", cookie },
    body: JSON.stringify({ organizationId: orgId }),
  });
  return {
    cookie: setActive.headers.get("set-cookie")?.split(";")[0] ?? cookie,
    userId: u.id,
  };
}

describe("reports", () => {
  it("creates a report under an org project, with and without environmentId", async () => {
    const ctx = await withTestDb();
    try {
      const { cookie } = await signUpAndOrg(ctx.app);
      const p = await createProject(ctx.app, cookie);
      const envRes = await ctx.app.request(
        `/api/v1/projects/${p.id}/environments`,
        {
          method: "POST",
          headers: { "content-type": "application/json", cookie },
          body: JSON.stringify({ name: "prod", key: "prod" }),
        },
      );
      const env = z.object({ id: z.string() }).parse(await envRes.json());

      const res = await createReport(ctx.app, cookie, {
        projectId: p.id,
        title: "Save button 500s",
      });
      expect(res.status).toBe(201);
      const r = reportSchema.parse(await res.json());
      expect(r.status).toBe("open");
      expect(r.environmentId).toBeNull();

      const withEnv = await createReport(ctx.app, cookie, {
        projectId: p.id,
        environmentId: env.id,
        title: "Checkout broken",
        description: "500 on submit",
        captureMode: "manual",
      });
      expect(withEnv.status).toBe(201);
      expect(reportSchema.parse(await withEnv.json()).environmentId).toBe(
        env.id,
      );
    } finally {
      await ctx.stop();
    }
  }, 120_000);

  it("returns 404 creating a report against a foreign-org project", async () => {
    const ctx = await withTestDb();
    try {
      const a = await signUpAndOrg(ctx.app, "a@t.dev");
      const b = await signUpAndOrg(ctx.app, "b@t.dev");
      const p = await createProject(ctx.app, a.cookie);
      const res = await createReport(ctx.app, b.cookie, {
        projectId: p.id,
        title: "x",
      });
      expect(res.status).toBe(404);
    } finally {
      await ctx.stop();
    }
  }, 120_000);

  it("lists reports filtered by projectId, status, and assignedTo", async () => {
    const ctx = await withTestDb();
    try {
      const { cookie, orgId } = await signUpAndOrg(ctx.app);
      const m = await signUpMember(ctx.app, ctx.db, orgId, "m@t.dev");
      const p1 = await createProject(ctx.app, cookie);
      const p2 = await createProject(ctx.app, cookie, "p2");
      const r1 = reportSchema.parse(
        await (
          await createReport(ctx.app, cookie, {
            projectId: p1.id,
            title: "one",
          })
        ).json(),
      );
      await createReport(ctx.app, cookie, { projectId: p2.id, title: "two" });
      await ctx.app.request(`/api/v1/reports/${r1.id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json", cookie },
        body: JSON.stringify({ status: "in_progress", assignedTo: m.userId }),
      });

      const list = (q: string) =>
        ctx.app.request(`/api/v1/reports${q}`, { headers: { cookie } });
      expect(
        z.array(reportSchema).parse(await (await list("")).json()).length,
      ).toBe(2);
      const byProject = z
        .array(reportSchema)
        .parse(await (await list(`?projectId=${p1.id}`)).json());
      expect(byProject.length).toBe(1);
      expect(byProject[0].id).toBe(r1.id);
      const byStatus = z
        .array(reportSchema)
        .parse(await (await list("?status=in_progress")).json());
      expect(byStatus.length).toBe(1);
      expect(byStatus[0].id).toBe(r1.id);
      const byAssignee = z
        .array(reportSchema)
        .parse(await (await list(`?assignedTo=${m.userId}`)).json());
      expect(byAssignee.length).toBe(1);
      expect(byAssignee[0].id).toBe(r1.id);
      expect(
        z
          .array(reportSchema)
          .parse(await (await list("?status=resolved")).json()).length,
      ).toBe(0);
    } finally {
      await ctx.stop();
    }
  }, 120_000);

  it("detail returns report with artifacts and shares (no tokenHash)", async () => {
    const ctx = await withTestDb();
    try {
      const { cookie } = await signUpAndOrg(ctx.app);
      const p = await createProject(ctx.app, cookie);
      const rep = reportSchema.parse(
        await (
          await createReport(ctx.app, cookie, {
            projectId: p.id,
            title: "det",
          })
        ).json(),
      );
      await ctx.db.insert(reportArtifacts).values({
        id: crypto.randomUUID(),
        reportId: rep.id,
        type: "screenshot",
        storageProvider: "local",
        storageKey: "k/1.png",
        contentType: "image/png",
        sizeBytes: 10,
        sha256: "abc",
      });
      await ctx.db.insert(reportShares).values({
        id: crypto.randomUUID(),
        reportId: rep.id,
        tokenHash: "hash-1",
        createdBy: rep.createdBy,
      });

      const res = await ctx.app.request(`/api/v1/reports/${rep.id}`, {
        headers: { cookie },
      });
      expect(res.status).toBe(200);
      const d = detailSchema.parse(await res.json());
      expect(d.artifacts.length).toBe(1);
      expect(d.artifacts[0].type).toBe("screenshot");
      expect(d.shares.length).toBe(1);
      expect(d.shares[0]).not.toHaveProperty("tokenHash");
    } finally {
      await ctx.stop();
    }
  }, 120_000);

  it("patches status open→in_progress and assignee", async () => {
    const ctx = await withTestDb();
    try {
      const { cookie, orgId } = await signUpAndOrg(ctx.app);
      const m = await signUpMember(ctx.app, ctx.db, orgId, "m@t.dev");
      const p = await createProject(ctx.app, cookie);
      const rep = reportSchema.parse(
        await (
          await createReport(ctx.app, cookie, {
            projectId: p.id,
            title: "t",
          })
        ).json(),
      );

      const patch = await ctx.app.request(`/api/v1/reports/${rep.id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json", cookie },
        body: JSON.stringify({ status: "in_progress", assignedTo: m.userId }),
      });
      expect(patch.status).toBe(200);
      const updated = z
        .object({ status: z.string(), assignedTo: z.string().nullable() })
        .parse(await patch.json());
      expect(updated.status).toBe("in_progress");
      expect(updated.assignedTo).toBe(m.userId);
    } finally {
      await ctx.stop();
    }
  }, 120_000);

  it("rejects invalid status value on patch with 400", async () => {
    const ctx = await withTestDb();
    try {
      const { cookie } = await signUpAndOrg(ctx.app);
      const p = await createProject(ctx.app, cookie);
      const rep = reportSchema.parse(
        await (
          await createReport(ctx.app, cookie, {
            projectId: p.id,
            title: "t",
          })
        ).json(),
      );
      const res = await ctx.app.request(`/api/v1/reports/${rep.id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json", cookie },
        body: JSON.stringify({ status: "bogus" }),
      });
      expect(res.status).toBe(400);
    } finally {
      await ctx.stop();
    }
  }, 120_000);

  it("admin (owner) deletes any report", async () => {
    const ctx = await withTestDb();
    try {
      const { cookie, orgId } = await signUpAndOrg(ctx.app);
      const m = await signUpMember(ctx.app, ctx.db, orgId, "m@t.dev");
      const p = await createProject(ctx.app, cookie);
      // member creates the report; owner deletes it
      const rep = reportSchema.parse(
        await (
          await createReport(ctx.app, m.cookie, {
            projectId: p.id,
            title: "t",
          })
        ).json(),
      );
      const del = await ctx.app.request(`/api/v1/reports/${rep.id}`, {
        method: "DELETE",
        headers: { cookie },
      });
      expect(del.status).toBe(204);
      const get = await ctx.app.request(`/api/v1/reports/${rep.id}`, {
        headers: { cookie },
      });
      expect(get.status).toBe(404);
    } finally {
      await ctx.stop();
    }
  }, 120_000);

  it("non-admin creator deletes their own report", async () => {
    const ctx = await withTestDb();
    try {
      const { cookie, orgId } = await signUpAndOrg(ctx.app);
      const m = await signUpMember(ctx.app, ctx.db, orgId, "m@t.dev");
      const p = await createProject(ctx.app, cookie);
      const rep = reportSchema.parse(
        await (
          await createReport(ctx.app, m.cookie, {
            projectId: p.id,
            title: "t",
          })
        ).json(),
      );
      const del = await ctx.app.request(`/api/v1/reports/${rep.id}`, {
        method: "DELETE",
        headers: { cookie: m.cookie },
      });
      expect(del.status).toBe(204);
    } finally {
      await ctx.stop();
    }
  }, 120_000);

  it("non-admin non-creator cannot delete (403)", async () => {
    const ctx = await withTestDb();
    try {
      const { cookie, orgId } = await signUpAndOrg(ctx.app);
      const m = await signUpMember(ctx.app, ctx.db, orgId, "m@t.dev");
      const p = await createProject(ctx.app, cookie);
      const rep = reportSchema.parse(
        await (
          await createReport(ctx.app, cookie, {
            projectId: p.id,
            title: "t",
          })
        ).json(),
      );
      const del = await ctx.app.request(`/api/v1/reports/${rep.id}`, {
        method: "DELETE",
        headers: { cookie: m.cookie },
      });
      expect(del.status).toBe(403);
    } finally {
      await ctx.stop();
    }
  }, 120_000);

  it("other-org member gets 404 on get/patch/delete", async () => {
    const ctx = await withTestDb();
    try {
      const a = await signUpAndOrg(ctx.app, "a@t.dev");
      const b = await signUpAndOrg(ctx.app, "b@t.dev");
      const p = await createProject(ctx.app, a.cookie);
      const rep = reportSchema.parse(
        await (
          await createReport(ctx.app, a.cookie, {
            projectId: p.id,
            title: "t",
          })
        ).json(),
      );

      const get = await ctx.app.request(`/api/v1/reports/${rep.id}`, {
        headers: { cookie: b.cookie },
      });
      expect(get.status).toBe(404);
      const patch = await ctx.app.request(`/api/v1/reports/${rep.id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json", cookie: b.cookie },
        body: JSON.stringify({ status: "resolved" }),
      });
      expect(patch.status).toBe(404);
      const del = await ctx.app.request(`/api/v1/reports/${rep.id}`, {
        method: "DELETE",
        headers: { cookie: b.cookie },
      });
      expect(del.status).toBe(404);
      // foreign report is invisible in list too
      const list = await ctx.app.request("/api/v1/reports", {
        headers: { cookie: b.cookie },
      });
      expect(z.array(reportSchema).parse(await list.json()).length).toBe(0);
    } finally {
      await ctx.stop();
    }
  }, 120_000);
});
