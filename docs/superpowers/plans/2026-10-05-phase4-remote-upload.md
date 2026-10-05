# Phase 4 — Remote Upload Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Extension uploads a captured report to the API: PAT auth, artifact storage, two-phase ingest→upload→finalize, extension uploader + in-extension redaction port.

**Architecture:** `packages/storage` (ArtifactStorage: LocalFsStorage + S3Storage) is pure and app-agnostic. `apps/api` gains `personal_access_tokens` + Bearer auth in `requireAuth` (same context vars — no route changes), token CRUD routes, and ingest routes (`POST /api/v1/reports/ingest`, `PUT /api/v1/uploads/:key`, `POST /api/v1/reports/:id/finalize`). The extension gains `uploader.js` (maps report → envelope, POSTs, PUTs, finalizes) and `redact.js` (port of `packages/redaction` default rules — vanilla JS, no bundler). `buildApp` signature extends to `(db, auth, baseUrl, storage)`.

**Tech Stack:** Bun + Hono + Drizzle + Better Auth + zod + postgres.js; vanilla JS extension; testcontainers+podman for api tests.

**Spec:** `docs/superpowers/specs/2026-10-05-phase4-remote-upload-design.md` (read it — the plan argues from it).

## Global Constraints

- Repo rules (AGENTS.md): extension stays vanilla JS; `apps/extension` capture path untouched; `packages/` adds no runtime dep to extension capture; `BugReportEnvelope` is canonical.
- Biome rule `ts-no-return-type` is active: no inline `ReturnType<typeof …>` outside a named type alias in the owning module. `Auth` alias stays `ReturnType<typeof createAuth>` in `lib/auth.ts` — reuse it, don't retype.
- All org-scoped reads/writes go through `getRole`/`isMember`/`isAdmin`/`projectInOrg`/`reportInOrg` (apps/api/src/lib/policy.ts). Cross-org → 404 `{error:"not found"}`, never 403.
- Token format `oj_pat_<base64url(24 bytes)>`; sha256-hex at rest; raw token shown exactly once at mint.
- Errors shape `{error: string, …}` — use `zjson` from `apps/api/src/lib/validate.ts` for every validator; wrap inserts with `isUniqueViolation` (23505→409).
- 23505 in postgres.js lands on `err.cause.code` (DrizzleQueryError wraps) — reuse `isUniqueViolation` from `apps/api/src/routes/projects.ts`; export it from `lib/` and update projects.ts to import it (no duplication).
- Tests: `bun test apps/api/test/` needs podman socket + `TESTCONTAINERS_RYUK_DISABLED=1` (helpers.ts already sets both). `bun test packages/storage/` must NOT need containers.
- Commits: `feat(api): …` / `feat(db): …` / `feat(ext): …` / `feat(storage): …` style. Don't push.

---

### Task 1: `packages/storage` + `personal_access_tokens` schema + PAT Bearer auth in `requireAuth`

**Files:**
- Create: `packages/storage/package.json`, `packages/storage/tsconfig.json`, `packages/storage/src/index.ts`, `packages/storage/src/local.ts`, `packages/storage/src/s3.ts`, `packages/storage/test/local.test.ts`
- Modify: `packages/db/src/schema/domain.ts` (+`personalAccessTokens`), `packages/db/src/schema/index.ts` (export), `apps/api/src/lib/session.ts` (Bearer PAT path + `authKind` var), `apps/api/src/routes/projects.ts` (export `isUniqueViolation` → move to `apps/api/src/lib/errors.ts`, update import), `bun.lock` (via `bun install`)
- Test: `packages/storage/test/local.test.ts`, `apps/api/test/tokens-auth.test.ts`

**Interfaces:**
- Produces (used by Tasks 2–4):
  ```ts
  // packages/storage/src/index.ts
  export type ArtifactKind = "replay" | "screenshot" | "audio" | "attachment";
  export interface UploadTarget { key: string; url: string; headers?: Record<string,string>; }
  export interface ArtifactStorage {
    createUpload(reportId: string, artifactId: string, kind: ArtifactKind, sizeBytes: number, sha256: string): Promise<UploadTarget>;
    getDownloadUrl(reportId: string, key: string): Promise<string>;
    head(reportId: string, key: string): Promise<{ sizeBytes: number } | null>;
    write(reportId: string, key: string, body: ArrayBuffer): Promise<void>;
    delete(reportId: string, key: string): Promise<void>;
  }
  // local.ts: new LocalFsStorage(rootDir: string, baseUrl: string)
  // s3.ts:    new S3Storage(cfg: { endpoint, bucket, accessKeyId, secretAccessKey, urlTtlSeconds })
  ```
- `authKind: "session" | "pat"` added to hono ContextVariableMap in session.ts.
- `isUniqueViolation(err: unknown): boolean` in `apps/api/src/lib/errors.ts`.

- [ ] **Step 1: packages/storage skeleton**

`packages/storage/package.json`:
```json
{
  "name": "@bugcapture/storage",
  "version": "0.1.0",
  "type": "module",
  "exports": { ".": "./src/index.ts" },
  "scripts": { "check-types": "tsc --noEmit -p tsconfig.json" },
  "dependencies": { "aws4fetch": "^1.0.20" }
}
```
`packages/storage/tsconfig.json` = copy of `packages/db/tsconfig.json`.
Add `"packages/storage"` isn't needed — workspaces already glob `packages/*`; run `bun install` to link.

`src/index.ts` = the interface + `ArtifactKind` type + `export { LocalFsStorage } from "./local"; export { S3Storage } from "./s3";`

`src/local.ts`:
```ts
import { mkdir, stat, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { ArtifactKind, ArtifactStorage, UploadTarget } from "./index";

export class LocalFsStorage implements ArtifactStorage {
  constructor(private root: string, private baseUrl: string) {}

  private path(reportId: string, key: string) {
    return join(this.root, reportId, key);
  }

  async createUpload(reportId: string, artifactId: string, kind: ArtifactKind): Promise<UploadTarget> {
    const key = `${artifactId}-${kind}`;
    return { key, url: `${this.baseUrl}/api/v1/uploads/${reportId}/${encodeURIComponent(key)}` };
  }

  async getDownloadUrl(reportId: string, key: string): Promise<string> {
    return `${this.baseUrl}/api/v1/uploads/${reportId}/${encodeURIComponent(key)}`;
  }

  async head(reportId: string, key: string) {
    try { return { sizeBytes: (await stat(this.path(reportId, key))).size }; }
    catch { return null; }
  }

  async write(reportId: string, key: string, body: ArrayBuffer) {
    const p = this.path(reportId, key);
    await mkdir(join(this.root, reportId), { recursive: true });
    await writeFile(p, Buffer.from(body));
  }

  async delete(reportId: string, key: string) {
    await unlink(this.path(reportId, key)).catch(() => {});
  }
}
```

`src/s3.ts` — aws4fetch `AwsClient`; `createUpload` returns `{key, url: presigned PUT, headers:{ "content-type":"application/octet-stream", "x-amz-content-sha256": sha256 }}`; `head` → signed HEAD request, parse `content-length`; `write`/`getDownloadUrl`/`delete` per S3 semantics. Keep under 60 lines; no SDK — aws4fetch only.

- [ ] **Step 2: LocalFsStorage unit test (no containers)**

`packages/storage/test/local.test.ts` — bun:test, `tmpdir()`:
```ts
it("createUpload→write→head→delete round-trip", async () => {
  const s = new LocalFsStorage(root, "http://x");
  const t = await s.createUpload("r1", "a1", "replay", 4, "0".repeat(64));
  await s.write("r1", t.key, new TextEncoder().encode("abcd").buffer);
  expect(await s.head("r1", t.key)).toEqual({ sizeBytes: 4 });
  expect(t.url).toBe("http://x/api/v1/uploads/r1/a1-replay");
  await s.delete("r1", t.key);
  expect(await s.head("r1", t.key)).toBeNull();
});
```
Run: `bun test packages/storage/test/` → PASS.

- [ ] **Step 3: schema — personal_access_tokens**

`domain.ts` append (same import block already has `index,text,timestamp,uniqueIndex`):
```ts
export const personalAccessTokens = pgTable(
  "personal_access_tokens",
  {
    id: text("id").primaryKey(),
    userId: text("user_id").notNull().references(() => user.id, { onDelete: "cascade" }),
    organizationId: text("organization_id").notNull().references(() => organization.id, { onDelete: "cascade" }),
    label: text("label").notNull(),
    tokenHash: text("token_hash").notNull().unique(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    lastUsedAt: timestamp("last_used_at"),
    revokedAt: timestamp("revoked_at"),
  },
  (t) => [
    index("personal_access_tokens_org_idx").on(t.organizationId),
    index("personal_access_tokens_user_idx").on(t.userId),
  ],
);
```
Export from `schema/index.ts`. `cd packages/db && bunx drizzle-kit generate` → new migration `0002_*`; `bun test packages/db/test/` still green.

- [ ] **Step 4: `isUniqueViolation` hoist**

Create `apps/api/src/lib/errors.ts`:
```ts
export function isUniqueViolation(err: unknown): boolean {
  let e: any = err;
  while (e) { if (e.code === "23505") return true; e = e.cause; }
  return false;
}
```
In `projects.ts`: delete the local copy, `import { isUniqueViolation } from "../lib/errors"`.

- [ ] **Step 5: `requireAuth` Bearer path**

`apps/api/src/lib/session.ts` — add PAT branch before session lookup:
```ts
import { createHash } from "node:crypto";
import { and, eq, isNull } from "drizzle-orm";
import { personalAccessTokens, user } from "@bugcapture/db/schema";
import type { Db } from "@bugcapture/db";

declare module "hono" {
  interface ContextVariableMap {
    user: SessionUser; orgId: string; authKind: "session" | "pat";
  }
}

export function requireAuth(auth: Auth, db: Db) {
  return createMiddleware(async (c, next) => {
    const bearer = c.req.header("authorization");
    if (bearer?.startsWith("Bearer oj_pat_")) {
      const hash = createHash("sha256").update(bearer.slice(7)).digest("hex");
      const [row] = await db
        .select({ t: personalAccessTokens, u: { id: user.id, email: user.email, name: user.name } })
        .from(personalAccessTokens)
        .innerJoin(user, eq(user.id, personalAccessTokens.userId))
        .where(and(eq(personalAccessTokens.tokenHash, hash), isNull(personalAccessTokens.revokedAt)));
      if (!row) return c.json({ error: "unauthorized" }, 401);
      c.set("user", row.u); c.set("orgId", row.t.organizationId); c.set("authKind", "pat");
      db.update(personalAccessTokens).set({ lastUsedAt: new Date() })
        .where(eq(personalAccessTokens.id, row.t.id)).execute().catch(() => {});
      await next(); return;
    }
    const session = await auth.api.getSession({ headers: c.req.raw.headers });
    if (!session) return c.json({ error: "unauthorized" }, 401);
    const orgId = session.session.activeOrganizationId;
    if (!orgId) return c.json({ error: "no active organization" }, 400);
    c.set("user", { id: session.user.id, email: session.user.email, name: session.user.name });
    c.set("orgId", orgId); c.set("authKind", "session");
    await next();
  });
}
```
**Call-site churn:** `requireAuth(auth)` → `requireAuth(auth, db)` in all four route files (`projects`, `reports`, `shares`, `capture-sessions`) — one-line edit each (`r.use("*", requireAuth(auth, db))`).

- [ ] **Step 6: auth test + typecheck + commit**

`apps/api/test/tokens-auth.test.ts` — mint a PAT via the Task-2 route OR directly insert (route lands in Task 2; simplest correct: insert via `ctx.db` + `createHash` so this file doesn't depend on Task 2):
```ts
it("Bearer PAT authenticates and sets org", async () => {
  const ctx = await withTestDb(); const { cookie, orgId } = await signUpAndOrg(ctx.app);
  const raw = "oj_pat_" + Buffer.from(crypto.getRandomValues(new Uint8Array(24))).toString("base64url");
  const hash = createHash("sha256").update(raw).digest("hex");
  const [me] = await ctx.db.select().from(user);           // the signed-up user
  await ctx.db.insert(personalAccessTokens).values({ id: crypto.randomUUID(), userId: me.id, organizationId: orgId, label: "t", tokenHash: hash });
  const res = await ctx.app.request("/api/v1/projects", { headers: { authorization: `Bearer ${raw}` } });
  expect(res.status).toBe(200);
});
it("revoked PAT → 401", async () => { /* same but revoked_at set; expect 401 */ });
```
Run `bun test apps/api/test/` → all green (old tests pass — session path unchanged). `bunx tsc --noEmit -p apps/api/tsconfig.json`, `bunx biome check apps/api packages/storage packages/db` → clean.

- [ ] **Step 7: Commit**

```bash
git add packages/storage packages/db/src/schema apps/api/src apps/api/test bun.lock
git commit -m "feat(storage,db,api): ArtifactStorage pkg + personal_access_tokens + PAT Bearer auth"
```

---

### Task 2: Token CRUD routes (`POST/GET/DELETE /api/v1/tokens`, session-only)

**Files:**
- Create: `apps/api/src/routes/tokens.ts`, `apps/api/test/tokens.test.ts`
- Modify: `apps/api/src/app.ts` (mount)

**Interfaces:**
- Consumes: `requireAuth` (authKind), `personalAccessTokens`, `isUniqueViolation`, `zjson`.
- Produces: `GET /api/v1/tokens` `[{id,label,createdAt,lastUsedAt,revokedAt}]`; `POST` `{label}`→`201 {id,label,token}`; `DELETE /:id`→`204`.

- [ ] **Step 1: failing tests**

`apps/api/test/tokens.test.ts` (helpers: `withTestDb`, `signUpAndOrg`):
```ts
const mint = (app, cookie) => app.request("/api/v1/tokens", { method:"POST", headers:{"content-type":"application/json", cookie}, body: JSON.stringify({ label:"ci" }) });

it("mint returns raw oj_pat_ token once; hash at rest", async () => { /* 201; body.token startsWith oj_pat_; db row tokenHash === sha256(token); body has no hash field */ });
it("list omits hash + shows created", async () => { /* GET → [ {id,label,createdAt} ], no tokenHash key */ });
it("revoked token no longer authenticates", async () => { /* mint → DELETE /:id → Bearer request → 401 */ });
it("PAT cannot mint PAT (403)", async () => { /* mint PAT via session → POST /tokens with Bearer pat → 403 */ });
it("cross-org DELETE → 404", async () => { /* second signup+org; DELETE first org's token id → 404; token still valid */ });
```

- [ ] **Step 2: routes/tokens.ts**

```ts
import { createHash, getRandomValues } from "node:crypto";
import { and, eq, isNull } from "drizzle-orm";
import { Hono } from "hono";
import { z } from "zod";
import type { Db } from "@bugcapture/db";
import { personalAccessTokens } from "@bugcapture/db/schema";
import { isUniqueViolation } from "../lib/errors";
import type { Auth } from "../lib/auth";
import { requireAuth } from "../lib/session";
import { zjson } from "../lib/validate";

const mintToken = () => "oj_pat_" + Buffer.from(getRandomValues(new Uint8Array(24))).toString("base64url");

export function tokensRoutes(db: Db, auth: Auth) {
  const r = new Hono();
  r.use("*", requireAuth(auth, db));
  // session-only: PAT must not mint/inspect tokens
  r.use("*", async (c, next) => c.var.authKind === "pat" ? c.json({ error: "forbidden" }, 403) : next());

  r.get("/", async (c) => c.json(await db
    .select({ id: personalAccessTokens.id, label: personalAccessTokens.label,
              createdAt: personalAccessTokens.createdAt, lastUsedAt: personalAccessTokens.lastUsedAt,
              revokedAt: personalAccessTokens.revokedAt })
    .from(personalAccessTokens).where(eq(personalAccessTokens.organizationId, c.var.orgId))));

  r.post("/", zjson("json", z.object({ label: z.string().min(1).max(80) })), async (c) => {
    const token = mintToken();
    const row = { id: crypto.randomUUID(), userId: c.var.user.id, organizationId: c.var.orgId,
                  label: c.req.valid("json").label, tokenHash: createHash("sha256").update(token).digest("hex") };
    await db.insert(personalAccessTokens).values(row).catch((e) => { if (isUniqueViolation(e)) throw e; throw e; });
    return c.json({ id: row.id, label: row.label, token }, 201);
  });

  r.delete("/:id", async (c) => {
    const [row] = await db.update(personalAccessTokens).set({ revokedAt: new Date() })
      .where(and(eq(personalAccessTokens.id, c.req.param("id")),
                 eq(personalAccessTokens.organizationId, c.var.orgId),
                 isNull(personalAccessTokens.revokedAt)))
      .returning();
    if (!row) return c.json({ error: "not found" }, 404);
    return c.body(null, 204);
  });
  return r;
}
```
(`tokenHash` unique → race-safe; a 23505 retry once then propagate — keep the `.catch` minimal: regenerate token on 23505, else rethrow.)

- [ ] **Step 3: mount**

`app.ts`: `import { tokensRoutes } from "./routes/tokens";` + `app.route("/api/v1/tokens", tokensRoutes(db, auth));`

- [ ] **Step 4:** `bun test apps/api/test/` green; tsc + biome clean.

- [ ] **Step 5: Commit** `git add apps/api && git commit -m "feat(api): PAT mint/list/revoke (session-only)"`.

---

### Task 3: Ingest + upload + finalize routes

**Files:**
- Create: `apps/api/src/routes/ingest.ts`, `apps/api/test/ingest.test.ts`
- Modify: `apps/api/src/app.ts` (mount + storage param), `apps/api/src/index.ts` (storage selection), `apps/api/test/helpers.ts` (LocalFsStorage in buildApp)

**Interfaces:**
- Consumes: `ArtifactStorage`, `requireAuth`, `projectInOrg`, `reports`/`reportArtifacts`/`captureSessions`/`projectEnvironments` schema, `isUniqueViolation`, `zjson`.
- `buildApp(db, auth, baseUrl, storage: ArtifactStorage)`; `index.ts` picks `S3Storage` when `S3_ENDPOINT`+`S3_BUCKET`+`S3_ACCESS_KEY_ID`+`S3_SECRET_ACCESS_KEY` all set, else `LocalFsStorage(process.env.ARTIFACT_DIR ?? "data/artifacts", baseUrl)`.

- [ ] **Step 1: failing tests** — `apps/api/test/ingest.test.ts`, helpers updated to pass `new LocalFsStorage(await mkdtemp(join(tmpdir(),"art-")), "http://localhost:3000")`:

```ts
const envelope = { schemaVersion: 2, summary: { title: "t", url: "https://x" }, meta: {},
  events: [], artifacts: [{ kind: "replay", sha256: "0".repeat(64), sizeBytes: 4 }] };

it("ingest → PUT → finalize happy path", async () => {
  // create project via POST /projects; ingest → 201 {reportId, uploads:[{artifactId,key,url}]}
  // PUT url with body "abcd"?? — no: sha must match. Declare sha256 of actual bytes.
  // → POST /reports/:id/finalize → 200; report row exists; artifact status uploaded
});
it("wrong project org → 404", …);         // second org's projectId
it("bad envelope → 400 invalid request", …);
it("PUT wrong bytes → 409 checksum", …);   // sha declared ≠ body sha
it("PUT wrong size → 413", …);
it("finalize with missing artifact → 409 {missing}", …);
it("captureSessionId: stopped session → submitted on finalize", …); // POST /capture-sessions, PATCH stop, ingest+finalize
it("non-local store path 404s PUT (S3 mode skipped in tests)", skip or document);
```

- [ ] **Step 2: routes/ingest.ts**

```ts
const envelopeSchema = z.object({
  projectId: z.string().min(1),
  environmentId: z.string().min(1).optional(),
  captureSessionId: z.string().min(1).optional(),
  envelope: z.object({
    schemaVersion: z.literal(2),
    summary: z.record(z.string(), z.unknown()).default({}),
    meta: z.record(z.string(), z.unknown()).default({}),
    events: z.array(z.unknown()).max(20000).default([]),
    artifacts: z.array(z.object({
      kind: z.enum(["replay","screenshot","audio","attachment"]),
      sha256: z.string().regex(/^[0-9a-f]{64}$/),
      sizeBytes: z.number().int().positive(),
    })).max(64).default([]),
  }),
});

export function ingestRoutes(db: Db, auth: Auth, storage: ArtifactStorage) {
  const r = new Hono();
  r.use("*", requireAuth(auth, db));

  r.post("/reports/ingest", zjson("json", envelopeSchema), async (c) => {
    const { projectId, environmentId, captureSessionId, envelope } = c.req.valid("json");
    if (!(await projectInOrg(db, c.var.orgId, projectId))) return c.json({ error: "not found" }, 404);
    if (environmentId) { /* select env where id + projectId → 404 */ }
    if (captureSessionId) { /* select session where id + projectId → 404 */ }
    const reportId = crypto.randomUUID();
    const uploads = await db.transaction(async (tx) => {
      const [rep] = await tx.insert(reports).values({
        id: reportId, organizationId: c.var.orgId, projectId,
        environmentId: environmentId ?? null,
        captureSessionId: captureSessionId ?? null,
        title: String(envelope.summary.title ?? envelope.meta.pageTitle ?? "Untitled"),
        description: String(envelope.summary.description ?? envelope.meta.url ?? ""),
        source: "extension",
        data: { envelope },                    // reports.data jsonb already exists
      }).returning();
      const targets = [];
      for (const a of envelope.artifacts) {
        const artifactId = crypto.randomUUID();
        const t = await storage.createUpload(reportId, artifactId, a.kind, a.sizeBytes, a.sha256);
        await tx.insert(reportArtifacts).values({
          id: artifactId, reportId, kind: a.kind, storageKey: t.key,
          sizeBytes: a.sizeBytes, sha256: a.sha256, status: "pending",
        });
        targets.push({ artifactId, key: t.key, url: t.url, headers: t.headers });
      }
      return targets;
    }).catch((e) => { if (isUniqueViolation(e)) return null; throw e; });
    if (!uploads) return c.json({ error: "conflict" }, 409);
    return c.json({ reportId, uploads }, 201);
  });

  // Local store upload sink — S3 mode: clients PUT to presigned url; this 404s naturally
  r.put("/uploads/:reportId/:key", async (c) => {
    const { reportId, key } = c.req.param();
    const [art] = await db.select().from(reportArtifacts)
      .innerJoin(reports, eq(reports.id, reportArtifacts.reportId))
      .where(and(eq(reportArtifacts.reportId, reportId), eq(reportArtifacts.storageKey, key)));
    if (!art || art.reports.organizationId !== c.var.orgId) return c.json({ error: "not found" }, 404);
    const body = await c.req.arrayBuffer();
    if (body.byteLength !== art.report_artifacts.sizeBytes) return c.json({ error: "size mismatch" }, 413);
    const sha = createHash("sha256").update(Buffer.from(body)).digest("hex");
    if (sha !== art.report_artifacts.sha256) return c.json({ error: "checksum mismatch" }, 409);
    await storage.write(reportId, key, body);
    return c.json({ ok: true });
  });

  r.post("/reports/:id/finalize", async (c) => {
    const rep = await reportInOrg(db, c.var.orgId, c.req.param("id"));
    if (!rep) return c.json({ error: "not found" }, 404);
    const arts = await db.select().from(reportArtifacts).where(eq(reportArtifacts.reportId, rep.id));
    const missing = [];
    for (const a of arts) {
      const h = await storage.head(rep.id, a.storageKey);
      if (!h || h.sizeBytes !== a.sizeBytes) missing.push(a.id);
    }
    if (missing.length) return c.json({ error: "incomplete", missing }, 409);
    await db.update(reportArtifacts).set({ status: "uploaded" }).where(eq(reportArtifacts.reportId, rep.id));
    if (rep.captureSessionId) {
      await db.update(captureSessions).set({ status: "submitted" })
        .where(and(eq(captureSessions.id, rep.captureSessionId), eq(captureSessions.status, "stopped")));
    }
    return c.json(rep);
  });
  return r;
}
```
Check actual column names against `domain.ts` before writing (e.g. `storageKey`, `data` jsonb — adapt, don't invent).

- [ ] **Step 3: wire `buildApp` + `index.ts`** — signature `(db, auth, baseUrl, storage)`; mount `app.route("/api/v1", ingestRoutes(db, auth, storage))` (paths inside already carry `/reports/…`, `/uploads/…`). `helpers.ts`: `new LocalFsStorage(await mkdtemp(join(tmpdir(), "oj-art-")), "http://localhost:3000")`.

- [ ] **Step 4:** `bun test apps/api/test/` green; tsc/biome clean.

- [ ] **Step 5: Commit** `feat(api): ingest + upload + finalize (two-phase artifact upload)`.

---

### Task 4: Extension uploader + redact port + viewer UI

**Files:**
- Create: `apps/extension/uploader.js`, `apps/extension/redact.js`
- Modify: `apps/extension/viewer.html` (+upload section), `apps/extension/viewer.js` (wire button), `docs/provenance.md` (redact.js port note)

**Interfaces:**
- Produces: `uploadReport(report, {apiUrl, token, projectId, environmentId?}) → {reportId}`; on failure throws `Error` with `.status` + `.body`.

- [ ] **Step 1: `redact.js`** — port `packages/redaction/src/rules.ts` DEFAULT_RULES + a `redactReport(report)` applying them to `events` (url/headers/body fields): mask `authorization`, `cookie`, `set-cookie` headers; `password|token|secret|api[-_]?key` query params + body keys; drop bodies >256KB. Pure JS, no imports. (~80 lines; read `packages/redaction/src/` and mirror semantics — write original code, note the reference in commit message + `docs/provenance.md`.)

- [ ] **Step 2: `uploader.js`**

```js
export async function uploadReport(report, { apiUrl, token, projectId, environmentId }) {
  const r = redactReport(report);
  const artifacts = [];
  const put = (kind, bytes) => artifacts.push({ kind, bytes, sha256: sha256hex(bytes), sizeBytes: bytes.byteLength });
  if (r.rrwebEvents) put("replay", encode(typeof r.rrwebEvents === "string" ? r.rrwebEvents : JSON.stringify(r.rrwebEvents)));
  if (r.audio?.dataUrl) put("audio", dataUrlToBytes(r.audio.dataUrl));
  for (const e of r.events) if (e.kind === "screenshot" && e.detail?.image?.startsWith?.("data:")) put("screenshot", dataUrlToBytes(e.detail.image));
  const envelope = { schemaVersion: 2,
    summary: { title: r.meta?.pageTitle || r.meta?.pageUrl || "capture", url: r.meta?.pageUrl },
    meta: { ...r.meta, device: r.device }, events: r.events,
    artifacts: artifacts.map(({bytes, ...d}) => d) };
  const res = await fetch(`${apiUrl}/api/v1/reports/ingest`, { method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: JSON.stringify({ projectId, environmentId, envelope }) });
  if (!res.ok) throw Object.assign(new Error("ingest failed"), { status: res.status, body: await res.json().catch(()=>({}) ) });
  const { reportId, uploads } = await res.json();
  await Promise.all(uploads.map((u, i) => fetch(u.url, { method: "PUT",
    headers: { authorization: `Bearer ${token}` }, body: artifacts[i].bytes })));
  const fin = await fetch(`${apiUrl}/api/v1/reports/${reportId}/finalize`, { method: "POST",
    headers: { authorization: `Bearer ${token}` } });
  if (!fin.ok) throw Object.assign(new Error("finalize failed"), { status: fin.status, body: await fin.json().catch(()=>({})) });
  return { reportId };
}
```
Helpers `sha256hex` (SubtleCrypto), `dataUrlToBytes`, `encode` (TextEncoder) — top-level in uploader.js, ≤30 lines total.

- [ ] **Step 3: viewer UI** — `viewer.html`: `<section id="upload">` with inputs `api-url`,`token`,`project-id` + `<button id="upload-btn">` + `<span id="upload-status">`; `viewer.js`: load/save `oj_upload_config` via `chrome.storage.local`, on click `uploadReport(report, cfg)` → status line `Uploaded → <reportId>` or error text. Keep under 60 lines total additions. `manifest.json` needs `host_permissions` for user-supplied apiUrl — pattern `"host_permissions": ["http://*/*", "https://*/*"]` (extension already needs broad access for capture; verify current manifest and only add if absent).

- [ ] **Step 4: smoke** — throwaway script: `bun run` a node/bun script that calls `uploadReport` (import the ES module directly) against the local test app to prove the wire shape; delete script, note output in task report. Extension unit tests don't exist for viewer; `make test` must stay green.

- [ ] **Step 5: Commit** `feat(ext): server upload (uploader + redact port + viewer UI)`.

---

### Task 5: Docs + Makefile + full verify

**Files:**
- Modify: `Makefile` (add `packages/storage` to `test-unit` glob — it has no container tests), `README.md` (Phase 4 upload section: PAT mint, config, upload button), `docs/architecture.md` (storage boundary + PAT auth), `docs/provenance.md` (redact.js port + crikket upload-flow reference).

- [ ] Steps: edit each doc; `make test` + `make test-api` + `make lint` + `bun run --filter '*' check-types` all green; `drizzle-kit check` no drift; commit `docs: phase 4 upload docs + storage in test-unit`.

## Self-review notes (controller)

- `reports.data` jsonb column name + `reportArtifacts.storageKey` — implementer verifies against `domain.ts` before writing (Task 3 instructs).
- PAT-mining-PAT 403 is spec'd behavior — test asserts it.
- S3 presign path has no test (no MinIO); covered by local impl + interface contract — flagged deferred.
