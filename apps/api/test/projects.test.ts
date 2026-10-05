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

  it("409s on duplicate slug, env key, and origin", async () => {
    const ctx = await withTestDb();
    try {
      const { cookie } = await signUpAndOrg(ctx.app);
      const post = (path: string, body: Record<string, unknown>) =>
        ctx.app.request(path, {
          method: "POST",
          headers: { "content-type": "application/json", cookie },
          body: JSON.stringify(body),
        });

      const first = await post("/api/v1/projects", {
        name: "Portal",
        slug: "portal",
      });
      expect(first.status).toBe(201);
      const { id } = z.object({ id: z.string() }).parse(await first.json());
      const dup = await post("/api/v1/projects", {
        name: "Portal 2",
        slug: "portal",
      });
      expect(dup.status).toBe(409);
      expect((await dup.json()).error).toBe("slug already used");

      const envBody = { name: "prod", key: "prod" };
      expect(
        (await post(`/api/v1/projects/${id}/environments`, envBody)).status,
      ).toBe(201);
      expect(
        (await post(`/api/v1/projects/${id}/environments`, envBody)).status,
      ).toBe(409);

      const originBody = { origin: "https://app.example.com" };
      expect(
        (await post(`/api/v1/projects/${id}/origins`, originBody)).status,
      ).toBe(201);
      expect(
        (await post(`/api/v1/projects/${id}/origins`, originBody)).status,
      ).toBe(409);
    } finally {
      await ctx.stop();
    }
  }, 120_000);
});
