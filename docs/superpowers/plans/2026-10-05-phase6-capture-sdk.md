# Phase 6 — Capture SDK Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `packages/capture-sdk` (`@bugcapture/capture`) — browser recorder producing the same envelope → shared ingest→PUT→finalize pipeline, authed by `public_key` + `Origin`. Public `/api/v1/capture/*` routes + scoped CORS.

**Architecture:** The three ingest handler bodies extract into functions taking resolved `{orgId, projectId, createdBy}` so `captureRoutes` (key-resolved, no session) and `ingestRoutes` (session/PAT) share one implementation. `reports.created_by` goes nullable (additive migration). SDK = rrweb + console/fetch/XHR/onerror wraps → `events[]` → envelope v2 → capture routes.

**Tech Stack:** TS package (`rrweb` dep + `@bugcapture/redaction`); Hono cors middleware (hono 4.13.13 ships `hono/cors`); testcontainers for api tests.

**Spec:** `docs/superpowers/specs/2026-10-05-phase6-capture-sdk-design.md`.

## Global Constraints

- Repo rules: `packages/` TS-only; `@bugcapture/capture` may dep on `@bugcapture/redaction` (pure TS) + `rrweb`; no DOM/node APIs beyond what a browser page has.
- `zjson` validators, `isUniqueViolation`, `{error}` shapes, SAFE_SEGMENT on storage-key params — same as Phase 4/5.
- `reports.created_by` NOT NULL today → additive migration making it nullable; existing code paths keep populating it.
- Public routes resolve identity from `x-openjam-key` → `projects.public_key`; `projectId` NEVER comes from the request body on capture routes.
- Origin check: `project_origins` rows exist → request `Origin` (normalized, no trailing `/`) must equal one; zero rows → allow any. Documented.
- Tests: `bun test apps/api/test/` (podman); `bun test packages/capture-sdk/` must be container-free.

---

### Task 1: `reports.created_by` nullable + ingest handler extraction

**Files:**
- Modify: `packages/db/src/schema/domain.ts` (createdBy → nullable), `apps/api/src/routes/ingest.ts` (extract shared handlers), `apps/api/src/app.ts` (unchanged signature still)
- New migration via `drizzle-kit generate` (0004_*)
- Test: existing `apps/api/test/` must stay green — no new tests this task (Task 2 exercises the extracted paths)

**Interfaces:**
- Produces (Task 2 consumes): exported from a new `apps/api/src/lib/ingest-shared.ts`:
  ```ts
  export interface IngestIdentity { orgId: string; projectId: string; createdBy: string | null; source: string; }
  export async function handleIngest(db, storage, id: IngestIdentity, body: {environmentId?, captureSessionId?, envelope}): Promise<RouteResponse> // {status, json}
  export async function handleUploadPut(db, storage, id, reportId, key, body: ArrayBuffer): Promise<RouteResponse>
  export async function handleFinalize(db, storage, id, reportId): Promise<RouteResponse>
  export const envelopeSchema: ZodType;           // shared zod
  export async function findArtifact(db, reportId, key): Promise<artifact+report join | null>
  ```
  RouteResponse = `{status: number; json: unknown}` — routes convert to `c.json(json, status)`; keeps handlers router-agnostic. (If a cleaner shape emerges — e.g. handlers taking `c` + identity — use it; the point is ONE implementation. State the chosen shape in the report.)

- [ ] **Step 1: nullable created_by** — `domain.ts`: remove `.notNull()` on `createdBy`; `drizzle-kit generate` → migration; `bun test packages/db/test/` green.

- [ ] **Step 2: extract handlers** — lift the bodies of `POST /reports/ingest`, `PUT /uploads/:reportId/:key`, `POST /reports/:id/finalize` into `lib/ingest-shared.ts` as the functions above. `ingestRoutes` becomes thin: requireAuth + zjson + resolve `{orgId, projectId: body.projectId, createdBy: c.var.user.id, source: "extension"}` → call shared handler → `c.json`. All existing ingest/PUT/finalize tests must pass unchanged — that's the regression bar.

- [ ] **Step 3: verify + commit** — `bun test apps/api/test/` (44 existing green — extraction is behavior-neutral); tsc+biome; commit `refactor(api): extract ingest handlers + nullable created_by for SDK ingest`.

---

### Task 2: `routes/capture.ts` — public-key ingest/upload/finalize + CORS

**Files:**
- Create: `apps/api/src/routes/capture.ts`, `apps/api/test/capture.test.ts`
- Modify: `apps/api/src/app.ts` (mount `app.route("/api/v1/capture", captureRoutes(db, storage))`)

**Interfaces:**
- Consumes: Task 1's shared handlers + `envelopeSchema`; `projects.publicKey`; `projectOrigins`; `LocalFsStorage`/`S3Storage` instanceof branch for PUT/GET.
- Produces: `POST /api/v1/capture/ingest`, `PUT /api/v1/capture/uploads/:reportId/:key`, `POST /api/v1/capture/reports/:id/finalize`; `X-OpenJam-Key` header contract for the SDK.

- [ ] **Step 1: failing tests** — `apps/api/test/capture.test.ts` per spec §4:
```ts
const keyOf = async (ctx, projectId) => (await ctx.db.select().from(projects).where(eq(projects.id, projectId)))[0].publicKey;
it("happy path: key+origin → ingest → PUT → finalize → report source=sdk", …);
it("missing/bad key → 401", …);
it("origins configured + wrong Origin → 403; right → 201", …);
it("no origins → any Origin → 201", …);
it("OPTIONS preflight echoes allowed origin only for configured origin", …);
it("environmentId from another project → 404", …);
it("body projectId ignored (cannot write to foreign project)", …); // send other project's id in body — must still land on key's project
```

- [ ] **Step 2: routes/capture.ts**
```ts
import { cors } from "hono/cors";
const resolveKey = async (db, c) => {
  const key = c.req.header("x-openjam-key");
  if (!key) return null;
  const [p] = await db.select().from(projects).where(eq(projects.publicKey, key));
  return p ?? null;   // {id, organizationId, publicKey, …}
};
const originAllowed = async (db, projectId, origin) => {
  const rows = await db.select().from(projectOrigins).where(eq(projectOrigins.projectId, projectId));
  if (rows.length === 0) return true;                 // no configured origins → allow any (spec)
  const norm = (o) => o?.replace(/\/+$/, "");
  return rows.some(r => norm(r.origin) === norm(origin));
};

export function captureRoutes(db: Db, storage: ArtifactStorage) {
  const r = new Hono();
  // CORS first — preflight needs it before auth resolves
  r.use("*", cors({
    origin: async (origin, c) => {
      const p = await resolveKey(db, c);
      if (!p) return null;                            // browser hides response → effectively denied
      return (await originAllowed(db, p.id, origin)) ? origin : null;
    },
    allowMethods: ["POST", "PUT", "OPTIONS"],
    allowHeaders: ["content-type", "x-openjam-key"],
    maxAge: 600,
  }));
  r.use("*", async (c, next) => {                     // key+origin gate for real requests
    const p = await resolveKey(db, c);
    if (!p) return c.json({ error: "unauthorized" }, 401);
    if (!(await originAllowed(db, p.id, c.req.header("origin"))))
      return c.json({ error: "forbidden origin" }, 403);
    c.set("capture", p);                            // project row
    await next();
  });

  const body = z.object({ environmentId: z.string().min(1).optional(), captureSessionId: z.string().min(1).optional(), envelope: envelopeSchema.shape.envelope });
  r.post("/ingest", zjson("json", body), async (c) => {
    const p = c.var.capture;
    const res = await handleIngest(db, storage,
      { orgId: p.organizationId, projectId: p.id, createdBy: null, source: "sdk" },
      c.req.valid("json"));
    return c.json(res.json, res.status);
  });
  r.put("/uploads/:reportId/:key", async (c) => { /* SAFE_SEGMENT; handleUploadPut with key-project check — artifact→report→project_id=p.id */ });
  r.post("/reports/:id/finalize", async (c) => { /* handleFinalize — report.project_id=p.id */ });
  return r;
}
```
For PUT/finalize the shared handlers must check ownership against `id.projectId` (not orgId) — the extracted `IngestIdentity` carries both; handlers compare `report.projectId === id.projectId` (and orgId for defense-in-depth). If that's awkward, pass a `scope: {type:"org",orgId}|{type:"project",projectId}` — pick the cleaner shape and state it in the report.

- [ ] **Step 3:** `bun test apps/api/test/` green; tsc+biome; commit `feat(api): public capture routes (key+origin auth) + scoped CORS`.

---

### Task 3: `packages/capture-sdk` — recorder + envelope + upload

**Files:**
- Create: `packages/capture-sdk/{package.json,tsconfig.json,src/index.ts,src/recorder.ts,src/envelope.ts,src/upload.ts,test/envelope.test.ts,test/recorder.test.ts}`
- Modify: `Makefile` (test-unit glob), `bun.lock` via `bun install`

**Interfaces (from spec §1 — verbatim):** `initOpenJam(cfg) → {submit(opts), discard()}`; cfg `{projectKey, apiUrl, environmentId?, maxEvents?=5000, maxBodyBytes?=64*1024}`.

- [ ] **Step 1: package skeleton** — package.json `{name:"@bugcapture/capture", version:"0.1.0", type:"module", exports:{".":"./src/index.ts"}, dependencies:{rrweb:"^2.0.0","@bugcapture/redaction":"workspace:*"}, scripts:{check-types:"tsc --noEmit -p tsconfig.json"}}`; tsconfig = copy of packages/db's. `bun install`.

- [ ] **Step 2: `src/envelope.ts`** — pure, fully unit-tested:
```ts
export function buildEnvelope(args: {
  events: OjEvent[]; replayBytes: Uint8Array; title?: string; description?: string;
  meta: { url: string; title: string; userAgent: string; viewport: string; referrer?: string };
  capturedAt: number; durationMs: number;
}): { envelope: EnvelopeV2; artifacts: {kind:"replay"; bytes:Uint8Array; sha256:string; sizeBytes:number}[] }
```
Test (`test/envelope.test.ts`): shape/keys; title fallback `opts.title > document.title > location.href`; artifact descriptor sha256 = hex of bytes, sizeBytes = length; `schemaVersion === 2`; `summary.url = location.href`.

- [ ] **Step 3: `src/recorder.ts`** — capture wraps:
```ts
export class Recorder {
  events: OjEvent[] = [];                     // ring buffer at cfg.maxEvents
  start(): void                             // rrweb.record + console patch + fetch/XHR wrap + error listeners
  stop(): { events: OjEvent[]; replay: unknown[] }   // returns buffers, restores originals
}
```
- rrweb `record({emit:(e)=>this.replay.push(e), checkoutEveryNms:30000})`.
- console patch: each level → push `{t:Date.now(),rel:t-startWall,kind:"console",title:level,detail:{level,args:safeStringify(args,8192)}}`; call original.
- fetch wrap: time it, capture req headers (redacted) + json/text req body ≤maxBodyBytes, clone res → status + res headers (redacted) + res body ≤cap (only when content-type text/json/xml — read via `res.clone().text()`); push network event `{kind:"network",title:`${method} ${url}`,detail:{method,url,status,durationMs,requestHeaders,responseHeaders,requestBody?,responseBody?}}`. XHR same via prototype open/send wrap.
- `window.onerror`/`unhandledrejection` → `{kind:"error",title:msg,detail:{stack,source,lineno,colno}}`.
- Redaction: `createRedactionPipeline(DEFAULT_RULES)` applied to `{headers,url,body}` fields before push — reuse the package's `redactHeaders/redactUrl/redactBody` exports directly.
- Test (`test/recorder.test.ts`): mock `globalThis.fetch` + minimal `window`/`document` stubs (bun can define them); assert network event pushed with redacted `authorization` header + redacted `?token=` param; console.error pushed; passthrough works (wrapped fetch returns real response). rrweb `record` is stubbed via dep-injection or a `recordFn` param so no DOM needed in tests.

- [ ] **Step 4: `src/upload.ts` + `src/index.ts`**
```ts
export function initOpenJam(cfg: OpenJamConfig): OpenJamSession {
  const rec = new Recorder(cfg); rec.start();
  const startWall = Date.now();
  return {
    discard() { rec.stop(); },
    async submit(opts = {}) {
      const { events, replay } = rec.stop();
      const replayBytes = new TextEncoder().encode(JSON.stringify(replay));
      const { envelope, artifacts } = buildEnvelope({ events, replayBytes, title: opts.title, description: opts.description,
        meta: pageMeta(), capturedAt: startWall, durationMs: Date.now() - startWall });
      const res = await fetch(`${cfg.apiUrl}/api/v1/capture/ingest`, { method: "POST",
        headers: { "content-type": "application/json", "x-openjam-key": cfg.projectKey },
        body: JSON.stringify({ environmentId: cfg.environmentId, envelope }) });
      if (!res.ok) throw uploadError("ingest", res);
      const { reportId, uploads } = await res.json();
      await Promise.all(uploads.map((u, i) => fetch(u.url, { method: "PUT", headers: u.headers ?? {}, body: artifacts[i].bytes })));
      const fin = await fetch(`${cfg.apiUrl}/api/v1/capture/reports/${reportId}/finalize`, { method: "POST", headers: { "x-openjam-key": cfg.projectKey } });
      if (!fin.ok) throw uploadError("finalize", fin);
      return { reportId };
    },
  };
}
```
- `pageMeta()` reads `document.title`, `location.href`, `navigator.userAgent`, `innerWidth×innerHeight`, `document.referrer` — stub-able in tests.

- [ ] **Step 5: verify + commit** — `bun test packages/capture-sdk/` green; `bunx tsc -p packages/capture-sdk`; biome; commit `feat(sdk): @bugcapture/capture — rrweb+console+network+error recorder → ingest pipeline`.

---

### Task 4: Browser smoke + docs + closeout

**Files:** `README.md` (SDK section: script-tag vs npm usage — `import { initOpenJam } from "@bugcapture/capture"`; project public key + origins setup), `docs/architecture.md` (+capture routes + SDK pkg line), `docs/provenance.md` (crikket SDK referenced as behavior reference), `Makefile` (ensure capture-sdk in test-unit — if Task 3 didn't).

- [ ] **Step 1: browser smoke** — throwaway: `make db-up db-migrate dev-api`; fixture `smoke.html` served by a one-line `python3 -m http.server` (or bun) that imports `initOpenJam` via a file URL/importmap → `initOpenJam({projectKey, apiUrl:"http://localhost:3000"})`; `browser` tool opens the page, `evaluate` calls `submit({title:"smoke"})`, assert `{reportId}`; open `http://localhost:3000/app/report.html?id=<id>` → screenshot → timeline + replay mount. Delete fixture; kill dev-api. Note: SDK import from file:// may hit CORS/module-resolution friction — a `bun build` bundle of the SDK is an acceptable shortcut (evidence in report).
- [ ] **Step 2: full verify** — `make test` + `make test-api` + `make lint` + `check-types` all green.
- [ ] **Step 3: Commit** `docs: phase 6 SDK docs + smoke`.

## Self-review notes (controller)

- `reports.created_by` nullable is the minimal schema change for key-auth ingest; alternative (synthetic SDK user) rejected as invented complexity.
- CORS OPTIONS: browsers DO send custom request headers on preflight (`access-control-request-headers` echoes `x-openjam-key`); the cors origin fn resolves the project from the request's OWN `x-openjam-key` header — verify a real preflight actually carries it (test asserts).
- The `projectId-in-body` test exists specifically to catch scope bugs — a leaked key must not write to other projects.
