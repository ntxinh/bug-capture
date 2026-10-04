import { createDb, type Db, migrate } from "@bugcapture/db";
import { PostgreSqlContainer } from "@testcontainers/postgresql";
import { buildApp } from "../src/app";
import { createAuth } from "../src/lib/auth";

process.env.TESTCONTAINERS_RYUK_DISABLED ??= "true";
process.env.DOCKER_HOST ??= `unix:///run/user/${process.getuid()}/podman/podman.sock`;

export interface TestCtx {
  app: ReturnType<typeof buildApp>;
  db: Db;
  stop: () => Promise<void>;
}

export async function withTestDb(): Promise<TestCtx> {
  const container = await new PostgreSqlContainer("postgres:16-alpine").start();
  const url = container.getConnectionUri();
  await migrate(url);
  const db = createDb(url);
  const auth = createAuth(db, "test-secret", "http://localhost:3000");
  const app = buildApp(auth);
  return { app, db, stop: () => container.stop() };
}

export async function signUpAndOrg(
  app: ReturnType<typeof buildApp>,
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
