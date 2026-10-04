import { describe, expect, it } from "bun:test";
import { z } from "zod";
import { signUpAndOrg, withTestDb } from "./helpers";

const projectSchema = z.object({
  id: z.string(),
  name: z.string(),
  publicKey: z.string(),
});

describe("projects", () => {
  it("create → list → get → patch → delete within org", async () => {
    const ctx = await withTestDb();
    try {
      const { cookie } = await signUpAndOrg(ctx.app);
      const create = await ctx.app.request("/api/v1/projects", {
        method: "POST",
        headers: { "content-type": "application/json", cookie },
        body: JSON.stringify({ name: "Portal", slug: "portal" }),
      });
      expect(create.status).toBe(201);
      const project = projectSchema.parse(await create.json());
      expect(project.publicKey).toMatch(/^oj_pk_/);

      const list = await ctx.app.request("/api/v1/projects", {
        headers: { cookie },
      });
      expect(z.array(projectSchema).parse(await list.json()).length).toBe(1);

      const get = await ctx.app.request(`/api/v1/projects/${project.id}`, {
        headers: { cookie },
      });
      expect(get.status).toBe(200);

      const patch = await ctx.app.request(`/api/v1/projects/${project.id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json", cookie },
        body: JSON.stringify({ name: "Portal v2" }),
      });
      expect(patch.status).toBe(200);
      expect(projectSchema.parse(await patch.json()).name).toBe("Portal v2");

      const del = await ctx.app.request(`/api/v1/projects/${project.id}`, {
        method: "DELETE",
        headers: { cookie },
      });
      expect(del.status).toBe(204);
    } finally {
      await ctx.stop();
    }
  }, 120_000);

  it("other-org member gets 404 not 403", async () => {
    const ctx = await withTestDb();
    try {
      const a = await signUpAndOrg(ctx.app, "a@t.dev");
      const b = await signUpAndOrg(ctx.app, "b@t.dev");
      const created = await ctx.app.request("/api/v1/projects", {
        method: "POST",
        headers: { "content-type": "application/json", cookie: a.cookie },
        body: JSON.stringify({ name: "P", slug: "p" }),
      });
      const { id } = projectSchema.parse(await created.json());
      const res = await ctx.app.request(`/api/v1/projects/${id}`, {
        headers: { cookie: b.cookie },
      });
      expect(res.status).toBe(404);
    } finally {
      await ctx.stop();
    }
  }, 120_000);
});
