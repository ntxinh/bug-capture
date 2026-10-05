import { describe, expect, it } from "bun:test";
import { z } from "zod";
import { signUpAndOrg, type TestCtx, withTestDb } from "./helpers";

const sessionSchema = z.object({
  id: z.string(),
  projectId: z.string(),
  environmentId: z.string().nullable(),
  status: z.string(),
  startedAt: z.string(),
  endedAt: z.string().nullable(),
});

async function createProject(ctx: TestCtx, cookie: string) {
  const p = await ctx.app.request("/api/v1/projects", {
    method: "POST",
    headers: { "content-type": "application/json", cookie },
    body: JSON.stringify({
      name: "P",
      slug: `p-${crypto.randomUUID().slice(0, 8)}`,
    }),
  });
  return z.object({ id: z.string() }).parse(await p.json());
}

async function createEnv(
  ctx: TestCtx,
  cookie: string,
  projectId: string,
  key = "prod",
) {
  const e = await ctx.app.request(
    `/api/v1/projects/${projectId}/environments`,
    {
      method: "POST",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({ name: key, key }),
    },
  );
  return z.object({ id: z.string() }).parse(await e.json());
}

async function createSession(
  ctx: TestCtx,
  cookie: string,
  body: Record<string, unknown>,
) {
  return ctx.app.request("/api/v1/capture-sessions", {
    method: "POST",
    headers: { "content-type": "application/json", cookie },
    body: JSON.stringify(body),
  });
}

async function patch(ctx: TestCtx, cookie: string, id: string, status: string) {
  return ctx.app.request(`/api/v1/capture-sessions/${id}`, {
    method: "PATCH",
    headers: { "content-type": "application/json", cookie },
    body: JSON.stringify({ status }),
  });
}

describe("capture-sessions", () => {
  it("creates a recording session and walks the happy path recording→stopped→submitted", async () => {
    const ctx = await withTestDb();
    try {
      const { cookie } = await signUpAndOrg(ctx.app);
      const project = await createProject(ctx, cookie);
      const env = await createEnv(ctx, cookie, project.id);

      const res = await createSession(ctx, cookie, {
        projectId: project.id,
        environmentId: env.id,
      });
      expect(res.status).toBe(201);
      const s = sessionSchema.parse(await res.json());
      expect(s.status).toBe("recording");
      expect(s.environmentId).toBe(env.id);
      expect(s.endedAt).toBeNull();

      const stopped = await patch(ctx, cookie, s.id, "stopped");
      expect(stopped.status).toBe(200);
      const s2 = sessionSchema.parse(await stopped.json());
      expect(s2.status).toBe("stopped");
      expect(s2.endedAt).not.toBeNull();

      const submitted = await patch(ctx, cookie, s.id, "submitted");
      expect(submitted.status).toBe(200);
      expect(sessionSchema.parse(await submitted.json()).status).toBe(
        "submitted",
      );
    } finally {
      await ctx.stop();
    }
  }, 120_000);

  it("stopped→discarded ok; stopped→recording and discarded→* return 400", async () => {
    const ctx = await withTestDb();
    try {
      const { cookie } = await signUpAndOrg(ctx.app);
      const project = await createProject(ctx, cookie);
      const s = sessionSchema.parse(
        await (
          await createSession(ctx, cookie, { projectId: project.id })
        ).json(),
      );

      await patch(ctx, cookie, s.id, "stopped");

      const back = await patch(ctx, cookie, s.id, "recording");
      expect(back.status).toBe(400);
      const err = z
        .object({ error: z.string(), from: z.string(), to: z.string() })
        .parse(await back.json());
      expect(err.error).toBe("invalid transition");
      expect(err.from).toBe("stopped");
      expect(err.to).toBe("recording");

      const discarded = await patch(ctx, cookie, s.id, "discarded");
      expect(discarded.status).toBe(200);
      expect(sessionSchema.parse(await discarded.json()).status).toBe(
        "discarded",
      );

      for (const next of ["recording", "stopped", "submitted"]) {
        const res = await patch(ctx, cookie, s.id, next);
        expect(res.status).toBe(400);
      }
    } finally {
      await ctx.stop();
    }
  }, 120_000);

  it("lists sessions by projectId", async () => {
    const ctx = await withTestDb();
    try {
      const { cookie } = await signUpAndOrg(ctx.app);
      const project = await createProject(ctx, cookie);
      const other = await createProject(ctx, cookie);
      await createSession(ctx, cookie, { projectId: project.id });
      await createSession(ctx, cookie, { projectId: project.id });
      await createSession(ctx, cookie, { projectId: other.id });

      const res = await ctx.app.request(
        `/api/v1/capture-sessions?projectId=${project.id}`,
        { headers: { cookie } },
      );
      expect(res.status).toBe(200);
      const rows = z.array(sessionSchema).parse(await res.json());
      expect(rows.length).toBe(2);
      for (const row of rows) expect(row.projectId).toBe(project.id);
    } finally {
      await ctx.stop();
    }
  }, 120_000);

  it("rejects an environmentId that belongs to a different project with 404", async () => {
    const ctx = await withTestDb();
    try {
      const { cookie } = await signUpAndOrg(ctx.app);
      const project = await createProject(ctx, cookie);
      const other = await createProject(ctx, cookie);
      const foreignEnv = await createEnv(ctx, cookie, other.id);

      const res = await createSession(ctx, cookie, {
        projectId: project.id,
        environmentId: foreignEnv.id,
      });
      expect(res.status).toBe(404);
    } finally {
      await ctx.stop();
    }
  }, 120_000);

  it("second patch on a transitioned session is rejected (409/400)", async () => {
    const ctx = await withTestDb();
    try {
      const { cookie } = await signUpAndOrg(ctx.app);
      const project = await createProject(ctx, cookie);
      const s = sessionSchema.parse(
        await (
          await createSession(ctx, cookie, { projectId: project.id })
        ).json(),
      );
      // submit the session, then retry a transition from the stale "stopped" view
      expect((await patch(ctx, cookie, s.id, "stopped")).status).toBe(200);
      expect((await patch(ctx, cookie, s.id, "submitted")).status).toBe(200);
      const stale = await patch(ctx, cookie, s.id, "stopped");
      expect([400, 409]).toContain(stale.status);
    } finally {
      await ctx.stop();
    }
  }, 120_000);
});
