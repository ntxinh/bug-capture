# Phase 3 Backend MVP Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stand up the OpenJam server MVP — Better Auth + orgs, projects, reports, capture sessions, share issuance — as a Hono API on Bun backed by Postgres via Drizzle.

**Architecture:** `packages/db` (Drizzle schema + migrations) and `apps/api` (Hono on Bun.serve). Better Auth owns auth/org/member tables and `/api/auth/*`; domain routes own everything under `/api/v1/`. App-layer authorization via policy functions; no RLS. Tests use testcontainers + podman.

**Tech Stack:** Bun 1.3.x, Hono 4.13.x, better-auth 1.7.7, drizzle-orm 0.45.x, drizzle-kit 0.31.x, zod 4.6.x, @hono/zod-validator 0.9.1, postgres 3.4.x, @testcontainers/postgresql 12.x, postgres:16-alpine (compose/podman).

**Spec:** `docs/superpowers/specs/2026-10-04-phase3-backend-mvp-design.md` (extends `2026-10-04-bug-capture-design.md`)

## Global Constraints

- Better Auth owns `user|session|account|verification|organization|member|invitation|rate_limit` — domain code references but never modifies those tables.
- Domain FKs use `text` referencing `user.id`/`organization.id` (Better Auth IDs are text, not uuid — see auth schema).
- Cross-org access returns **404**, never 403 (no existence leak).
- Share tokens: raw shown once at creation; DB stores `sha256hex` only. `GET /r/:token` is the only public route.
- No stub files, no `viewer` role, no upload/R2/finalize routes — Phase 4. No `apps/web`.
- Vendored `apps/extension` untouched.
- Tests requiring containers set `DOCKER_HOST`/`TESTCONTAINERS_*` inside the test setup itself — no external env assumed.
- IDs: domain tables use `text` ids generated as `crypto.randomUUID()` at insert (consistency with BA's text ids); tokens/keys are `oj_pk_…`/`oj_…` urlsafe.

---

### Task 1: `packages/db` — schema + migrations

**Files:**
- Create: `packages/db/package.json`, `packages/db/tsconfig.json`, `packages/db/drizzle.config.ts`, `packages/db/src/index.ts`, `packages/db/src/schema/auth.ts`, `packages/db/src/schema/domain.ts`, `packages/db/src/migrate.ts`, `packages/db/src/client.ts`
- Test: `packages/db/test/migrate.test.ts`

**Interfaces:**
- Produces (consumed by every later task): `createDb(url: string)`, `migrate(url: string)`, `schema` re-export (`export * as schema from "./schema"`), and the table objects `user session account verification organization member invitation rateLimit projects projectEnvironments projectOrigins captureSessions reports reportArtifacts reportShares externalLinks`.
- Migration files generated under `packages/db/src/migrations/` and committed.

- [ ] **Step 1: Write `packages/db/package.json`**

```json
{
  "name": "@bugcapture/db",
  "version": "0.1.0",
  "type": "module",
  "exports": {
    ".": "./src/index.ts",
    "./schema": "./src/schema/index.ts",
    "./migrate": "./src/migrate.ts",
    "./client": "./src/client.ts"
  },
  "scripts": {
    "generate": "drizzle-kit generate",
    "check-types": "tsc --noEmit -p tsconfig.json"
  },
  "dependencies": {
    "drizzle-orm": "0.45.3",
    "postgres": "3.4.9"
  },
  "devDependencies": {
    "@testcontainers/postgresql": "12.2.0",
    "drizzle-kit": "0.31.11"
  }
}
```

- [ ] **Step 2: `tsconfig.json`** — same shape as sibling packages:

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": { "outDir": "dist", "rootDir": "src", "types": ["bun-types"] },
  "include": ["src"]
}
```

- [ ] **Step 3: Write `src/schema/auth.ts`** — Better Auth's expected tables (shape verified against the reference implementation; DO NOT copy comments/abstractions — plain tables). Write this file with exactly these definitions:

```typescript
import { boolean, index, integer, bigint, pgTable, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";

export const user = pgTable("user", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  email: text("email").notNull().unique(),
  emailVerified: boolean("email_verified").default(false).notNull(),
  image: text("image"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

export const session = pgTable(
  "session",
  {
    id: text("id").primaryKey(),
    expiresAt: timestamp("expires_at").notNull(),
    token: text("token").notNull().unique(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").notNull(),
    ipAddress: text("ip_address"),
    userAgent: text("user_agent"),
    userId: text("user_id").notNull().references(() => user.id, { onDelete: "cascade" }),
    activeOrganizationId: text("active_organization_id"),
  },
  (t) => [index("session_userId_idx").on(t.userId)],
);

export const account = pgTable(
  "account",
  {
    id: text("id").primaryKey(),
    accountId: text("account_id").notNull(),
    providerId: text("provider_id").notNull(),
    userId: text("user_id").notNull().references(() => user.id, { onDelete: "cascade" }),
    accessToken: text("access_token"),
    refreshToken: text("refresh_token"),
    idToken: text("id_token"),
    accessTokenExpiresAt: timestamp("access_token_expires_at"),
    refreshTokenExpiresAt: timestamp("refresh_token_expires_at"),
    scope: text("scope"),
    password: text("password"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").notNull(),
  },
  (t) => [index("account_userId_idx").on(t.userId)],
);

export const verification = pgTable(
  "verification",
  {
    id: text("id").primaryKey(),
    identifier: text("identifier").notNull(),
    value: text("value").notNull(),
    expiresAt: timestamp("expires_at").notNull(),
    createdAt: timestamp("created_at").defaultNow(),
    updatedAt: timestamp("updated_at").defaultNow(),
  },
  (t) => [index("verification_identifier_idx").on(t.identifier)],
);

export const rateLimit = pgTable("rate_limit", {
  id: text("id").primaryKey(),
  key: text("key").notNull().unique(),
  count: integer("count").notNull(),
  lastRequest: bigint("last_request", { mode: "number" }).notNull(),
});

export const organization = pgTable(
  "organization",
  {
    id: text("id").primaryKey(),
    name: text("name").notNull(),
    slug: text("slug").notNull().unique(),
    logo: text("logo"),
    createdAt: timestamp("created_at").notNull(),
    metadata: text("metadata"),
  },
  (t) => [uniqueIndex("organization_slug_uidx").on(t.slug)],
);

export const member = pgTable(
  "member",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id").notNull().references(() => organization.id, { onDelete: "cascade" }),
    userId: text("user_id").notNull().references(() => user.id, { onDelete: "cascade" }),
    role: text("role").default("member").notNull(),
    createdAt: timestamp("created_at").notNull(),
  },
  (t) => [index("member_organizationId_idx").on(t.organizationId), index("member_userId_idx").on(t.userId)],
);

export const invitation = pgTable(
  "invitation",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id").notNull().references(() => organization.id, { onDelete: "cascade" }),
    email: text("email").notNull(),
    role: text("role"),
    status: text("status").default("pending").notNull(),
    expiresAt: timestamp("expires_at").notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    inviterId: text("inviter_id").notNull().references(() => user.id, { onDelete: "cascade" }),
  },
  (t) => [index("invitation_organizationId_idx").on(t.organizationId), index("invitation_email_idx").on(t.email)],
);
```

- [ ] **Step 4: Write `src/schema/domain.ts`**

```typescript
import { index, integer, pgTable, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";
import { organization, user } from "./auth";

export const projects = pgTable(
  "projects",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id").notNull().references(() => organization.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    slug: text("slug").notNull(),
    key: text("key").notNull().unique(),
    publicKey: text("public_key").notNull().unique(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (t) => [
    index("projects_organizationId_idx").on(t.organizationId),
    uniqueIndex("projects_org_slug_uidx").on(t.organizationId, t.slug),
  ],
);

export const projectEnvironments = pgTable(
  "project_environments",
  {
    id: text("id").primaryKey(),
    projectId: text("project_id").notNull().references(() => projects.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    key: text("key").notNull(),
    baseUrl: text("base_url"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (t) => [
    index("project_environments_projectId_idx").on(t.projectId),
    uniqueIndex("project_environments_project_key_uidx").on(t.projectId, t.key),
  ],
);

export const projectOrigins = pgTable(
  "project_origins",
  {
    id: text("id").primaryKey(),
    projectId: text("project_id").notNull().references(() => projects.id, { onDelete: "cascade" }),
    origin: text("origin").notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (t) => [
    index("project_origins_projectId_idx").on(t.projectId),
    uniqueIndex("project_origins_project_origin_uidx").on(t.projectId, t.origin),
  ],
);

export const captureSessions = pgTable(
  "capture_sessions",
  {
    id: text("id").primaryKey(),
    projectId: text("project_id").notNull().references(() => projects.id, { onDelete: "cascade" }),
    environmentId: text("environment_id").references(() => projectEnvironments.id, { onDelete: "set null" }),
    startedAt: timestamp("started_at").defaultNow().notNull(),
    endedAt: timestamp("ended_at"),
    status: text("status").default("recording").notNull(),
    // status: recording | stopped | submitted | discarded
  },
  (t) => [index("capture_sessions_projectId_idx").on(t.projectId)],
);

export const reports = pgTable(
  "reports",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id").notNull().references(() => organization.id, { onDelete: "cascade" }),
    projectId: text("project_id").notNull().references(() => projects.id, { onDelete: "cascade" }),
    environmentId: text("environment_id").references(() => projectEnvironments.id, { onDelete: "set null" }),
    title: text("title").notNull(),
    description: text("description"),
    status: text("status").default("open").notNull(),
    // status: open | in_progress | resolved | closed | ignored
    priority: text("priority").default("normal").notNull(),
    // priority: low | normal | high | urgent
    createdBy: text("created_by").notNull().references(() => user.id, { onDelete: "cascade" }),
    assignedTo: text("assigned_to").references(() => user.id, { onDelete: "set null" }),
    captureMode: text("capture_mode"),
    startedAt: timestamp("started_at"),
    endedAt: timestamp("ended_at"),
    appVersion: text("app_version"),
    gitSha: text("git_sha"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (t) => [
    index("reports_organizationId_idx").on(t.organizationId),
    index("reports_projectId_idx").on(t.projectId),
    index("reports_status_idx").on(t.status),
  ],
);

export const reportArtifacts = pgTable(
  "report_artifacts",
  {
    id: text("id").primaryKey(),
    reportId: text("report_id").notNull().references(() => reports.id, { onDelete: "cascade" }),
    type: text("type").notNull(),
    // type: replay | screenshot | audio | video | report_bundle | attachment
    storageProvider: text("storage_provider").notNull(),
    storageKey: text("storage_key").notNull(),
    contentType: text("content_type").notNull(),
    sizeBytes: integer("size_bytes").notNull(),
    sha256: text("sha256").notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (t) => [index("report_artifacts_reportId_idx").on(t.reportId)],
);

export const reportShares = pgTable(
  "report_shares",
  {
    id: text("id").primaryKey(),
    reportId: text("report_id").notNull().references(() => reports.id, { onDelete: "cascade" }),
    tokenHash: text("token_hash").notNull().unique(),
    visibility: text("visibility").default("link").notNull(),
    expiresAt: timestamp("expires_at"),
    createdBy: text("created_by").notNull().references(() => user.id, { onDelete: "cascade" }),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    revokedAt: timestamp("revoked_at"),
  },
  (t) => [index("report_shares_reportId_idx").on(t.reportId)],
);

export const externalLinks = pgTable(
  "external_links",
  {
    id: text("id").primaryKey(),
    reportId: text("report_id").notNull().references(() => reports.id, { onDelete: "cascade" }),
    provider: text("provider").notNull(),
    externalId: text("external_id").notNull(),
    url: text("url").notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (t) => [index("external_links_reportId_idx").on(t.reportId)],
);
```

- [ ] **Step 5: Write `src/schema/index.ts`**

```typescript
export * from "./auth";
export * from "./domain";
```

- [ ] **Step 6: Write `src/client.ts` + `src/migrate.ts` + `src/index.ts`**

`src/client.ts`:

```typescript
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "./schema";

export type Db = ReturnType<typeof createDb>;

export function createDb(url: string) {
  const sql = postgres(url, { max: 10 });
  return drizzle(sql, { schema });
}
```

`src/migrate.ts`:

```typescript
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate as runMigrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";

export async function migrate(url: string) {
  const sql = postgres(url, { max: 1 });
  try {
    await runMigrate(drizzle(sql), { migrationsFolder: new URL("./migrations", import.meta.url).pathname });
  } finally {
    await sql.end();
  }
}
```

`src/index.ts`:

```typescript
export * as schema from "./schema";
export { createDb, type Db } from "./client";
export { migrate } from "./migrate";
```

- [ ] **Step 7: Write `drizzle.config.ts` + generate migration**

```typescript
import { defineConfig } from "drizzle-kit";

export default defineConfig({
  dialect: "postgresql",
  schema: "./src/schema/index.ts",
  out: "./src/migrations",
});
```

```bash
cd packages/db && bun install && bunx drizzle-kit generate
```

Expected: `src/migrations/0000_*.sql` + meta files emitted; commit them.

- [ ] **Step 8: Write the migration test**

`packages/db/test/migrate.test.ts`:

```typescript
import { PostgreSqlContainer } from "@testcontainers/postgresql";
import { describe, expect, it } from "bun:test";
import { migrate } from "../src/migrate";
import postgres from "postgres";

process.env.TESTCONTAINERS_RYUK_DISABLED ??= "true";
process.env.DOCKER_HOST ??= `unix:///run/user/${process.getuid()}/podman/podman.sock`;

describe("migrate", () => {
  it("applies schema to a fresh postgres", async () => {
    const container = await new PostgreSqlContainer("postgres:16-alpine").start();
    try {
      await migrate(container.getConnectionUri());
      const sql = postgres(container.getConnectionUri());
      const rows = await sql`
        select table_name from information_schema.tables
        where table_schema = 'public' order by 1`;
      const names = rows.map((r) => r.table_name);
      for (const t of [
        "user", "session", "account", "verification", "rate_limit",
        "organization", "member", "invitation",
        "projects", "project_environments", "project_origins",
        "capture_sessions", "reports", "report_artifacts", "report_shares", "external_links",
      ]) {
        expect(names).toContain(t);
      }
      await sql.end();
    } finally {
      await container.stop();
    }
  }, 120_000);
});
```

- [ ] **Step 9: Run it**

```bash
bun test packages/db/
```

Expected: PASS — container starts, 16 tables + drizzle migrations table exist.

- [ ] **Step 10: Commit**

```bash
git add packages/db && git commit -m "feat(db): drizzle schema (auth + domain), migrations, testcontainers migrate test"
```

---

### Task 2: `apps/api` — app skeleton + auth + session middleware

**Files:**
- Create: `apps/api/package.json`, `apps/api/tsconfig.json`, `apps/api/src/index.ts`, `apps/api/src/env.ts`, `apps/api/src/lib/auth.ts`, `apps/api/src/lib/session.ts`, `apps/api/src/app.ts`
- Test: `apps/api/test/helpers.ts`, `apps/api/test/auth.test.ts`

**Interfaces:**
- Produces (consumed by Tasks 3–5): `buildApp({ db, auth })` → Hono app; `requireAuth` middleware setting `c.var.user` + `c.var.orgId` (from `session.activeOrganizationId`); `auth` instance (better-auth) for route mounting + test use; `env` loader; test helpers `withTestDb(fn)` (container + migrate + fresh app) and `signUp(app, {email,password,name})` returning `{ headers: {cookie}, user }`.

- [ ] **Step 1: Write `apps/api/package.json`**

```json
{
  "name": "@bugcapture/api",
  "version": "0.1.0",
  "type": "module",
  "scripts": {
    "dev": "bun run --hot src/index.ts",
    "check-types": "tsc --noEmit -p tsconfig.json"
  },
  "dependencies": {
    "@bugcapture/db": "workspace:*",
    "@hono/zod-validator": "0.9.1",
    "better-auth": "1.7.7",
    "hono": "4.13.13",
    "zod": "4.6.5"
  },
  "devDependencies": {
    "@testcontainers/postgresql": "12.2.0"
  }
}
```

- [ ] **Step 2: `tsconfig.json`** — same shape as sibling packages (`extends ../../tsconfig.base.json`, rootDir src, types bun-types, include src).

- [ ] **Step 3: Write `src/env.ts`**

```typescript
export const env = {
  databaseUrl: process.env.DATABASE_URL ?? "postgres://bugcapture:dev@localhost:5432/bugcapture",
  betterAuthSecret: process.env.BETTER_AUTH_SECRET ?? "dev-only-secret-change-me",
  betterAuthUrl: process.env.BETTER_AUTH_URL ?? "http://localhost:3000",
  port: Number(process.env.PORT ?? 3000),
};
```

- [ ] **Step 4: Write `src/lib/auth.ts`**

```typescript
import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { organization } from "better-auth/plugins";
import type { Db } from "@bugcapture/db";

export function createAuth(db: Db, secret: string, baseURL: string) {
  return betterAuth({
    database: drizzleAdapter(db, { provider: "pg" }),
    secret,
    baseURL,
    emailAndPassword: { enabled: true, requireEmailVerification: false },
    plugins: [
      organization({
        sendInvitationEmail: async (data) => {
          // Dev stub: email transport lands in Phase 7 (Resend).
          console.log(`[invite] ${data.email} → org ${data.organization.name}: ${data.invitation.id}`);
        },
      }),
    ],
    trustedOrigins: [baseURL],
  });
}

export type Auth = ReturnType<typeof createAuth>;
```

- [ ] **Step 5: Write `src/lib/session.ts`**

```typescript
import { createMiddleware } from "hono/factory";
import type { Auth } from "./auth";

export type SessionUser = { id: string; email: string; name: string };

declare module "hono" {
  interface ContextVariableMap {
    user: SessionUser;
    orgId: string;
  }
}

export function requireAuth(auth: Auth) {
  return createMiddleware(async (c, next) => {
    const session = await auth.api.getSession({ headers: c.req.raw.headers });
    if (!session) return c.json({ error: "unauthorized" }, 401);
    const orgId = session.session.activeOrganizationId;
    if (!orgId) return c.json({ error: "no active organization" }, 400);
    c.set("user", { id: session.user.id, email: session.user.email, name: session.user.name });
    c.set("orgId", orgId);
    await next();
  });
}
```

- [ ] **Step 6: Write `src/app.ts` + `src/index.ts`**

`src/app.ts`:

```typescript
import { Hono } from "hono";
import type { Auth } from "./lib/auth";

export function buildApp(auth: Auth) {
  const app = new Hono();
  app.on(["GET", "POST"], "/api/auth/*", (c) => auth.handler(c.req.raw));
  app.get("/healthz", (c) => c.json({ ok: true }));
  return app;
}
```

`src/index.ts`:

```typescript
import { createDb } from "@bugcapture/db";
import { buildApp } from "./app";
import { env } from "./env";
import { createAuth } from "./lib/auth";

const db = createDb(env.databaseUrl);
const auth = createAuth(db, env.betterAuthSecret, env.betterAuthUrl);
const app = buildApp(auth);

export default { port: env.port, fetch: app.fetch };
```

- [ ] **Step 7: Write test helpers + failing test**

`test/helpers.ts`:

```typescript
import { PostgreSqlContainer } from "@testcontainers/postgresql";
import { createDb, migrate, type Db } from "@bugcapture/db";
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

export async function signUpAndOrg(app: ReturnType<typeof buildApp>, email = "a@t.dev", password = "password123!") {
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
    body: JSON.stringify({ name: "Acme", slug: `acme-${Math.random().toString(36).slice(2, 8)}` }),
  });
  const orgBody = (await org.json()) as { id: string };
  const setActive = await app.request("/api/auth/organization/set-active", {
    method: "POST",
    headers: { "content-type": "application/json", cookie },
    body: JSON.stringify({ organizationId: orgBody.id }),
  });
  return { cookie: setActive.headers.get("set-cookie")?.split(";")[0] ?? cookie, orgId: orgBody.id };
}
```

`test/auth.test.ts`:

```typescript
import { describe, expect, it } from "bun:test";
import { signUpAndOrg, withTestDb } from "./helpers";

describe("auth + org lifecycle", () => {
  it("sign-up → create org → set active → session has org", async () => {
    const ctx = await withTestDb();
    try {
      const { cookie, orgId } = await signUpAndOrg(ctx.app);
      const res = await ctx.app.request("/api/auth/get-session", { headers: { cookie } });
      const body = (await res.json()) as { session: { activeOrganizationId?: string } };
      expect(res.status).toBe(200);
      expect(body.session.activeOrganizationId).toBe(orgId);
    } finally {
      await ctx.stop();
    }
  }, 120_000);

  it("healthz works without auth", async () => {
    const ctx = await withTestDb();
    try {
      const res = await ctx.app.request("/healthz");
      expect(res.status).toBe(200);
    } finally {
      await ctx.stop();
    }
  }, 120_000);
});
```

- [ ] **Step 8: Run + fix to green**

```bash
bun install
bun test apps/api/test/
cd apps/api && bunx tsc --noEmit -p tsconfig.json
```

Expected: both tests pass. If Better Auth's org endpoints differ (`organization/create` vs `create-organization`), adjust the helper — verify against `apps/api` runtime, not docs.

- [ ] **Step 9: Commit**

```bash
git add apps/api && git commit -m "feat(api): hono app + better-auth (org plugin) + requireAuth middleware"
```

---

### Task 3: Policy layer + projects/environments/origins routes

**Files:**
- Create: `apps/api/src/lib/policy.ts`, `apps/api/src/routes/projects.ts`
- Modify: `apps/api/src/app.ts` (mount routes), `apps/api/src/lib/auth.ts` may need role read (no change expected — role comes from `member` table)
- Test: `apps/api/test/projects.test.ts`

**Interfaces:**
- Consumes: `buildApp`, `requireAuth`, `signUpAndOrg`, `withTestDb` from Task 2.
- Produces: `requireRole(db)` helper returning membership role for `user` in `orgId`; route pattern (zod-validated body → policy check → drizzle insert/select → `c.json`) that Tasks 4–5 mirror.

- [ ] **Step 1: Write the failing test first**

`apps/api/test/projects.test.ts`:

```typescript
import { describe, expect, it } from "bun:test";
import { signUpAndOrg, withTestDb } from "./helpers";

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
      const project = (await create.json()) as { id: string; publicKey: string; key: string };
      expect(project.publicKey).toMatch(/^oj_pk_/);

      const list = await ctx.app.request("/api/v1/projects", { headers: { cookie } });
      expect((await list.json() as unknown[]).length).toBe(1);

      const get = await ctx.app.request(`/api/v1/projects/${project.id}`, { headers: { cookie } });
      expect(get.status).toBe(200);

      const patch = await ctx.app.request(`/api/v1/projects/${project.id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json", cookie },
        body: JSON.stringify({ name: "Portal v2" }),
      });
      expect(patch.status).toBe(200);
      expect(((await patch.json()) as { name: string }).name).toBe("Portal v2");

      const del = await ctx.app.request(`/api/v1/projects/${project.id}`, { method: "DELETE", headers: { cookie } });
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
      const { id } = (await created.json()) as { id: string };
      const res = await ctx.app.request(`/api/v1/projects/${id}`, { headers: { cookie: b.cookie } });
      expect(res.status).toBe(404);
    } finally {
      await ctx.stop();
    }
  }, 120_000);
});
```

Run `bun test apps/api/test/projects.test.ts` → confirm 404 route-not-found (RED).

- [ ] **Step 2: Write `src/lib/policy.ts`**

```typescript
import { eq, and } from "drizzle-orm";
import type { Db } from "@bugcapture/db";
import { member, projects } from "@bugcapture/db/schema";

export type Role = "owner" | "admin" | "member";

export async function getRole(db: Db, userId: string, orgId: string): Promise<Role | null> {
  const [m] = await db
    .select({ role: member.role })
    .from(member)
    .where(and(eq(member.userId, userId), eq(member.organizationId, orgId)));
  return (m?.role as Role) ?? null;
}

export async function isMember(db: Db, userId: string, orgId: string): Promise<boolean> {
  return (await getRole(db, userId, orgId)) !== null;
}

export async function isAdmin(db: Db, userId: string, orgId: string): Promise<boolean> {
  const r = await getRole(db, userId, orgId);
  return r === "owner" || r === "admin";
}

/** Project lookup scoped to org — returns null if not found OR not in org (404 semantics). */
export async function projectInOrg(db: Db, orgId: string, projectId: string) {
  const [p] = await db
    .select()
    .from(projects)
    .where(and(eq(projects.id, projectId), eq(projects.organizationId, orgId)));
  return p ?? null;
}
```

- [ ] **Step 3: Write `src/routes/projects.ts`**

```typescript
import { zValidator } from "@hono/zod-validator";
import { and, eq } from "drizzle-orm";
import { Hono } from "hono";
import { z } from "zod";
import type { Db } from "@bugcapture/db";
import { projectEnvironments, projectOrigins, projects } from "@bugcapture/db/schema";
import type { Auth } from "../lib/auth";
import { isAdmin, projectInOrg } from "../lib/policy";
import { requireAuth } from "../lib/session";

function ojId(prefix: string) {
  return `${prefix}_${crypto.randomUUID().replaceAll("-", "")}`;
}

function urlsafe(n: number) {
  return Buffer.from(crypto.getRandomValues(new Uint8Array(n))).toString("base64url");
}

const createProject = z.object({ name: z.string().min(1).max(120), slug: z.string().min(1).max(60).regex(/^[a-z0-9-]+$/) });
const patchProject = z.object({ name: z.string().min(1).max(120).optional(), slug: z.string().min(1).max(60).regex(/^[a-z0-9-]+$/).optional() });
const createEnv = z.object({ name: z.string().min(1).max(80), key: z.string().min(1).max(40).regex(/^[a-z0-9-]+$/), baseUrl: z.string().url().optional() });
const createOrigin = z.object({ origin: z.string().url() });

export function projectsRoutes(db: Db, auth: Auth) {
  const r = new Hono();
  r.use("*", requireAuth(auth));

  r.post("/", zValidator("json", createProject), async (c) => {
    const { name, slug } = c.req.valid("json");
    const orgId = c.var.orgId;
    const id = crypto.randomUUID();
    const [row] = await db.insert(projects).values({
      id, organizationId: orgId, name, slug,
      key: ojId("oj"), publicKey: `oj_pk_${urlsafe(24)}`,
    }).returning();
    return c.json(row, 201);
  });

  r.get("/", async (c) => {
    const rows = await db.select().from(projects).where(eq(projects.organizationId, c.var.orgId));
    return c.json(rows);
  });

  r.get("/:id", async (c) => {
    const p = await projectInOrg(db, c.var.orgId, c.req.param("id"));
    if (!p) return c.json({ error: "not found" }, 404);
    return c.json(p);
  });

  r.patch("/:id", zValidator("json", patchProject), async (c) => {
    if (!(await isAdmin(db, c.var.user.id, c.var.orgId))) return c.json({ error: "forbidden" }, 403);
    const p = await projectInOrg(db, c.var.orgId, c.req.param("id"));
    if (!p) return c.json({ error: "not found" }, 404);
    const [row] = await db.update(projects).set(c.req.valid("json")).where(eq(projects.id, p.id)).returning();
    return c.json(row);
  });

  r.delete("/:id", async (c) => {
    if (!(await isAdmin(db, c.var.user.id, c.var.orgId))) return c.json({ error: "forbidden" }, 403);
    const p = await projectInOrg(db, c.var.orgId, c.req.param("id"));
    if (!p) return c.json({ error: "not found" }, 404);
    await db.delete(projects).where(eq(projects.id, p.id));
    return c.body(null, 204);
  });

  r.post("/:id/environments", zValidator("json", createEnv), async (c) => {
    const p = await projectInOrg(db, c.var.orgId, c.req.param("id"));
    if (!p) return c.json({ error: "not found" }, 404);
    const body = c.req.valid("json");
    const [row] = await db.insert(projectEnvironments).values({ id: crypto.randomUUID(), projectId: p.id, ...body }).returning();
    return c.json(row, 201);
  });

  r.get("/:id/environments", async (c) => {
    const p = await projectInOrg(db, c.var.orgId, c.req.param("id"));
    if (!p) return c.json({ error: "not found" }, 404);
    const rows = await db.select().from(projectEnvironments).where(eq(projectEnvironments.projectId, p.id));
    return c.json(rows);
  });

  r.post("/:id/origins", zValidator("json", createOrigin), async (c) => {
    if (!(await isAdmin(db, c.var.user.id, c.var.orgId))) return c.json({ error: "forbidden" }, 403);
    const p = await projectInOrg(db, c.var.orgId, c.req.param("id"));
    if (!p) return c.json({ error: "not found" }, 404);
    const [row] = await db.insert(projectOrigins).values({ id: crypto.randomUUID(), projectId: p.id, origin: c.req.valid("json").origin }).returning();
    return c.json(row, 201);
  });

  r.get("/:id/origins", async (c) => {
    const p = await projectInOrg(db, c.var.orgId, c.req.param("id"));
    if (!p) return c.json({ error: "not found" }, 404);
    const rows = await db.select().from(projectOrigins).where(eq(projectOrigins.projectId, p.id));
    return c.json(rows);
  });

  return r;
}
```

- [ ] **Step 4: Mount in `src/app.ts`**

```typescript
import { Hono } from "hono";
import type { Db } from "@bugcapture/db";
import type { Auth } from "./lib/auth";
import { projectsRoutes } from "./routes/projects";

export function buildApp(db: Db, auth: Auth) {
  const app = new Hono();
  app.on(["GET", "POST"], "/api/auth/*", (c) => auth.handler(c.req.raw));
  app.get("/healthz", (c) => c.json({ ok: true }));
  app.route("/api/v1/projects", projectsRoutes(db, auth));
  return app;
}
```

(Note the signature change: `buildApp(db, auth)`. Update Task 2's `test/helpers.ts` call and `src/index.ts` to match — `buildApp` now needs `db`.)

- [ ] **Step 5: Update callers** — `src/index.ts` passes `db`; `test/helpers.ts` passes `db`. Then run:

```bash
bun test apps/api/test/ && cd apps/api && bunx tsc --noEmit -p tsconfig.json
```

Expected: green.

- [ ] **Step 6: Commit**

```bash
git add apps/api && git commit -m "feat(api): policy layer + projects/environments/origins routes"
```

---

### Task 4: Reports routes

**Files:**
- Create: `apps/api/src/routes/reports.ts`
- Modify: `apps/api/src/app.ts` (mount), `apps/api/src/lib/policy.ts` (add report-scoped functions)
- Test: `apps/api/test/reports.test.ts`

**Interfaces:**
- Consumes: `projectsRoutes` pattern, `requireAuth`, `getRole`/`isAdmin`/`projectInOrg`, test helpers.
- Produces: `reportInOrg(db, orgId, reportId)` — reused by Task 5 (shares/sessions live under reports' org scope).

- [ ] **Step 1: Write failing test** — `test/reports.test.ts` covering: create (with projectId + envId), list w/ `?projectId=` + `?status=` filters, get detail (includes `artifacts: []`, `shares: []` metadata arrays — no token field), patch status transition `open→in_progress`, patch assignee, delete (admin or creator), cross-org 404, invalid status value → 400. Write the full file covering each; mirror projects.test.ts request style.

Skeleton (expand to cover every behavior below — one `it` per behavior):

```typescript
import { describe, expect, it } from "bun:test";
import { signUpAndOrg, withTestDb } from "./helpers";

async function createProject(app: ReturnType<typeof import("../src/app").buildApp>, cookie: string) {
  const r = await app.request("/api/v1/projects", {
    method: "POST",
    headers: { "content-type": "application/json", cookie },
    body: JSON.stringify({ name: "P", slug: "p" }),
  });
  return (await r.json()) as { id: string };
}

describe("reports", () => {
  it("creates a report under an org project", async () => {
    const ctx = await withTestDb();
    try {
      const { cookie } = await signUpAndOrg(ctx.app);
      const p = await createProject(ctx.app, cookie);
      const res = await ctx.app.request("/api/v1/reports", {
        method: "POST",
        headers: { "content-type": "application/json", cookie },
        body: JSON.stringify({ projectId: p.id, title: "Save button 500s" }),
      });
      expect(res.status).toBe(201);
      const r = (await res.json()) as { status: string };
      expect(r.status).toBe("open");
    } finally {
      await ctx.stop();
    }
  }, 120_000);
});
```

Required behaviors (test assertions):
- `POST /api/v1/reports` body `{projectId, environmentId?, title, description?, captureMode?}` → 201; project must belong to org (else 404).
- `GET /api/v1/reports?projectId=&status=&assignedTo=` → filtered list in active org only.
- `GET /api/v1/reports/:id` → report + `artifacts` + `shares` (shares entries: id, visibility, expiresAt, createdAt, revokedAt — NEVER tokenHash).
- `PATCH /api/v1/reports/:id` `{title?, description?, status?, priority?, assignedTo?}` → member+; status must be one of `open|in_progress|resolved|closed|ignored` (zod enum).
- `DELETE /api/v1/reports/:id` → admin+ OR creator.
- All `?`/`404` per the org-scope rule.

- [ ] **Step 2: RED** — `bun test apps/api/test/reports.test.ts` → route-not-found failures.

- [ ] **Step 3: Add `reportInOrg` to policy.ts**

```typescript
export async function reportInOrg(db: Db, orgId: string, reportId: string) {
  const [r] = await db
    .select()
    .from(reports)
    .where(and(eq(reports.id, reportId), eq(reports.organizationId, orgId)));
  return r ?? null;
}
```

(import `reports` alongside `projects`.)

- [ ] **Step 4: Write `src/routes/reports.ts`** — same shape as projects.ts. Detail route joins `report_artifacts` + `report_shares` and selects non-token share columns explicitly (`id, visibility, expiresAt, createdAt, revokedAt`). `updatedAt` set to `new Date()` on patch.

- [ ] **Step 5: Mount** — `app.route("/api/v1/reports", reportsRoutes(db, auth))`.

- [ ] **Step 6: Run green + tsc + biome, commit**

```bash
bun test apps/api/test/ && cd apps/api && bunx tsc --noEmit -p tsconfig.json && bunx biome check apps/api
git add apps/api && git commit -m "feat(api): reports CRUD with org-scoped policy + artifact/share metadata"
```

---

### Task 5: Shares + capture-sessions + public share lookup

**Files:**
- Create: `apps/api/src/routes/shares.ts`, `apps/api/src/routes/capture-sessions.ts`
- Modify: `apps/api/src/app.ts`
- Test: `apps/api/test/shares.test.ts`, `apps/api/test/sessions.test.ts`

**Interfaces:**
- Consumes: `reportInOrg`, `isMember`, `requireAuth`, helpers.
- Produces: nothing downstream — terminal routes. Share minting contract: response `{ id, shareUrl }` where `shareUrl = "${betterAuthUrl}/r/${token}"`; token is `oj_` + 24 random bytes base64url; `tokenHash = sha256hex(token)` in DB.

- [ ] **Step 1: Write failing tests**

`test/shares.test.ts` must cover:
- `POST /api/v1/reports/:id/shares` `{expiresAt?}` → 201 `{id, shareUrl}`; `shareUrl` ends in `/r/oj_…`.
- DB stores ONLY hash: query `report_shares.tokenHash` directly via `ctx.db` — assert it's 64 hex chars and ≠ token.
- `GET /r/:token` → 200 with report metadata (`{title, status, createdAt}` — no org internals beyond report fields).
- Revoke: `DELETE /api/v1/shares/:id` → then `GET /r/:token` → 404.
- Expired share → 404 (create with past `expiresAt`).
- Cross-org share creation → 404.

`test/sessions.test.ts` must cover:
- `POST /api/v1/capture-sessions` `{projectId, environmentId?}` → 201 status `recording`.
- `PATCH` transitions: `recording→stopped` ok (sets `endedAt`), `stopped→submitted` ok, `stopped→discarded` ok; `stopped→recording` → 400; `discarded→*` → 400.
- `GET /api/v1/capture-sessions?projectId=` → list.
- Invalid `environmentId` (not in project) → 404.

- [ ] **Step 2: RED** → run both files, confirm failures.

- [ ] **Step 3: Implement `src/routes/shares.ts`**

```typescript
import { createHash, getRandomValues } from "node:crypto";
import { zValidator } from "@hono/zod-validator";
import { and, eq, isNull, or, gt } from "drizzle-orm";
import { Hono } from "hono";
import { z } from "zod";
import type { Db } from "@bugcapture/db";
import { reportShares, reports } from "@bugcapture/db/schema";
import type { Auth } from "../lib/auth";
import { reportInOrg } from "../lib/policy";
import { requireAuth } from "../lib/session";

function mintToken() {
  return `oj_${Buffer.from(getRandomValues(new Uint8Array(24))).toString("base64url")}`;
}
function hashToken(t: string) {
  return createHash("sha256").update(t).digest("hex");
}

export function sharesRoutes(db: Db, auth: Auth, baseUrl: string) {
  const authed = new Hono();
  authed.use("*", requireAuth(auth));

  authed.post("/reports/:reportId/shares", zValidator("json", z.object({ expiresAt: z.string().datetime().optional() })), async (c) => {
    const r = await reportInOrg(db, c.var.orgId, c.req.param("reportId"));
    if (!r) return c.json({ error: "not found" }, 404);
    const token = mintToken();
    const { expiresAt } = c.req.valid("json");
    const [row] = await db.insert(reportShares).values({
      id: crypto.randomUUID(),
      reportId: r.id,
      tokenHash: hashToken(token),
      expiresAt: expiresAt ? new Date(expiresAt) : null,
      createdBy: c.var.user.id,
    }).returning();
    // Raw token shown exactly once:
    return c.json({ id: row.id, shareUrl: `${baseUrl}/r/${token}` }, 201);
  });

  authed.delete("/shares/:id", async (c) => {
    // share → report → org check, then revoke
    const [s] = await db.select().from(reportShares).where(eq(reportShares.id, c.req.param("id")));
    if (!s) return c.json({ error: "not found" }, 404);
    const r = await reportInOrg(db, c.var.orgId, s.reportId);
    if (!r) return c.json({ error: "not found" }, 404);
    await db.update(reportShares).set({ revokedAt: new Date() }).where(eq(reportShares.id, s.id));
    return c.body(null, 204);
  });

  // public lookup — separate router, no auth
  const pub = new Hono();
  pub.get("/r/:token", async (c) => {
    const h = hashToken(c.req.param("token"));
    const [s] = await db.select().from(reportShares).where(
      and(
        eq(reportShares.tokenHash, h),
        isNull(reportShares.revokedAt),
        or(isNull(reportShares.expiresAt), gt(reportShares.expiresAt, new Date())),
      ),
    );
    if (!s) return c.json({ error: "not found" }, 404);
    const [r] = await db.select().from(reports).where(eq(reports.id, s.reportId));
    if (!r) return c.json({ error: "not found" }, 404);
    return c.json({ id: r.id, title: r.title, status: r.status, createdAt: r.createdAt });
  });

  return { authed, pub };
}
```

- [ ] **Step 4: Implement `src/routes/capture-sessions.ts`**

Transition table as the single source:

```typescript
const TRANSITIONS: Record<string, string[]> = {
  recording: ["stopped", "discarded"],
  stopped: ["submitted", "discarded"],
  submitted: [],
  discarded: [],
};
```

`PATCH` body `{status: z.enum(["recording","stopped","submitted","discarded"])}`; reject if `!TRANSITIONS[current].includes(next)` → 400 `{error: "invalid transition", from, to}`. `stopped`/`discarded`/`submitted` set `endedAt` if unset. Validate `environmentId` belongs to the project on create (`project_environments.projectId`).

- [ ] **Step 5: Mount in `app.ts`**

```typescript
const shares = sharesRoutes(db, auth, env.betterAuthUrl);
app.route("/api/v1", shares.authed);
app.route("/", shares.pub);
app.route("/api/v1/capture-sessions", captureSessionsRoutes(db, auth));
```

(`buildApp` needs `baseUrl` — extend its signature: `buildApp(db, auth, baseUrl)`.)

- [ ] **Step 6: Green + commit**

```bash
bun test apps/api/test/ && cd apps/api && bunx tsc --noEmit -p tsconfig.json
git add apps/api && git commit -m "feat(api): share mint/revoke + public lookup + capture-session transitions"
```

---

### Task 6: Compose, Makefile, env docs, full verify

**Files:**
- Create: `docker-compose.yml`, `.env.example`
- Modify: `Makefile`, `README.md` (dev section), `docs/architecture.md` (add api/db to layer map)

- [ ] **Step 1: Write `docker-compose.yml`**

```yaml
services:
  postgres:
    image: postgres:16-alpine
    environment:
      POSTGRES_DB: bugcapture
      POSTGRES_USER: bugcapture
      POSTGRES_PASSWORD: dev
    ports:
      - "5432:5432"
    volumes:
      - pgdata:/var/lib/postgresql/data
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U bugcapture -d bugcapture"]
      interval: 5s
      timeout: 3s
      retries: 10

volumes:
  pgdata:
```

- [ ] **Step 2: Write `.env.example`**

```bash
# apps/api
DATABASE_URL=postgres://bugcapture:dev@localhost:5432/bugcapture
BETTER_AUTH_SECRET=dev-only-secret-change-me
BETTER_AUTH_URL=http://localhost:3000
PORT=3000

# testcontainers on podman (required for `bun test` suites that boot postgres)
# DOCKER_HOST=unix:///run/user/$UID/podman/podman.sock
# TESTCONTAINERS_RYUK_DISABLED=true
```

- [ ] **Step 3: Update `Makefile`** — append:

```makefile
.PHONY: db-up db-down db-migrate db-generate dev-api

db-up:
	podman compose up -d postgres 2>/dev/null || docker compose up -d postgres

db-down:
	podman compose down 2>/dev/null || docker compose down

db-migrate:
	cd packages/db && bun run --bun -e "import('./src/migrate.ts').then(m=>m.migrate(process.env.DATABASE_URL ?? 'postgres://bugcapture:dev@localhost:5432/bugcapture'))"

db-generate:
	cd packages/db && bunx drizzle-kit generate

dev-api:
	cd apps/api && bun run dev
```

And extend `test-unit:` to include `bun test apps/api/test/` — BUT keep it optional: api tests need podman. Split instead: `test-api: bun test apps/api/test/` (own target, documented as container-required). Leave `test-unit` unchanged (extension + packages) so `make test` stays green without a container runtime.

- [ ] **Step 4: README dev section** — append:

```markdown
## Backend (Phase 3)

    make db-up          # postgres:16 via podman/docker compose
    make db-migrate     # apply drizzle migrations
    make dev-api        # hono api on :3000  (/api/auth/*, /api/v1/*)
    make test-api       # api tests — needs podman socket + testcontainers env from .env.example
```

- [ ] **Step 5: `docs/architecture.md`** — add under "Boundaries": `apps/api` (Hono) → `packages/db` (Drizzle→Postgres); auth tables owned by Better Auth; policy layer enforces org scope, 404-not-403 for cross-org.

- [ ] **Step 6: Full verify**

```bash
podman compose up -d 2>/dev/null || docker compose up -d
sleep 3
cd packages/db && bunx drizzle-kit check   # no drift
cd ../.. && make test && make test-api && make lint && make typecheck
```

Expected: all green. `drizzle-kit check` exits 0 (schema matches committed migrations).

- [ ] **Step 7: Commit**

```bash
git add docker-compose.yml .env.example Makefile README.md docs/architecture.md
git commit -m "chore: postgres compose, db make targets, api dev docs"
```
