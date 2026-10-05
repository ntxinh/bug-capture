import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDb, type Db, migrate } from "@bugcapture/db";
import { LocalFsStorage } from "@bugcapture/storage";
import { PostgreSqlContainer } from "@testcontainers/postgresql";
import { type App, buildApp } from "../src/app";
import { createAuth } from "../src/lib/auth";

process.env.TESTCONTAINERS_RYUK_DISABLED ??= "true";
process.env.DOCKER_HOST ??= `unix:///run/user/${process.getuid()}/podman/podman.sock`;

export interface TestCtx {
  app: App;
  db: Db;
  storage: LocalFsStorage;
  stop: () => Promise<void>;
}

export async function withTestDb(): Promise<TestCtx> {
  const container = await new PostgreSqlContainer("postgres:16-alpine").start();
  const url = container.getConnectionUri();
  await migrate(url);
  const db = createDb(url);
  const auth = createAuth(db, "test-secret", "http://localhost:3000");
  const storage = new LocalFsStorage(
    await mkdtemp(join(tmpdir(), "oj-art-")),
    "http://localhost:3000",
  );
  const app = buildApp(db, auth, "http://localhost:3000", storage);
  return { app, db, storage, stop: () => container.stop() };
}

export async function signUpAndOrg(
  app: App,
  email = "a@t.dev",
  password = "password123!",
) {
  const signUp = await app.request("/api/auth/sign-up/email", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email, password, name: "A" }),
  });
  const cookie = signUp.headers.get("set-cookie")?.split(";")[0];
  if (!cookie) throw new Error("no session cookie");
  const org = await app.request("/api/auth/organization/create", {
    method: "POST",
    headers: { "content-type": "application/json", cookie },
    body: JSON.stringify({
      name: "Acme",
      slug: `acme-${Math.random().toString(36).slice(2, 8)}`,
    }),
  });
  const orgBody = (await org.json()) as { id: string };
  const setActive = await app.request("/api/auth/organization/set-active", {
    method: "POST",
    headers: { "content-type": "application/json", cookie },
    body: JSON.stringify({ organizationId: orgBody.id }),
  });
  return {
    cookie: setActive.headers.get("set-cookie")?.split(";")[0] ?? cookie,
    orgId: orgBody.id,
  };
}
