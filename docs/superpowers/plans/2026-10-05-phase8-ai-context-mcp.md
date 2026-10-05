# Phase 8 — AI Context + MCP Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `GET /reports/:id/ai-context` (failure index + symbolication) + releases/source-map upload + `packages/mcp` stdio server.

**Architecture:** `releases` + `sourcemaps` tables (migration 0006); `routes/releases.ts` (CRUD + raw-PUT sourcemap); `lib/ai-context.ts` (envelope→context shape + `@jridgewell/trace-mapping` frame resolution, release-scoped maps read via `storage.read("releases/"+id, filename)`); `packages/mcp` stdio server (4 tools, Bearer via `OPENJAM_TOKEN`).

**Tech Stack:** `@jridgewell/trace-mapping`, `@modelcontextprotocol/sdk`, node:crypto sha256, testcontainers.

**Spec:** `docs/superpowers/specs/2026-10-05-phase8-ai-context-mcp-design.md`.

## Global Constraints

- `{error}` shapes, `zjson`, `isUniqueViolation`, org-scope via policy helpers, cross-org→404, `isAdmin` on writes.
- Source maps reuse `ArtifactStorage` under `releases/<releaseId>/` namespace — NOT `report_artifacts` (release-scoped).
- Map filename SAFE_SEGMENT-gated (`^[A-Za-z0-9_.-]+$` — dots allowed, `..` rejected by the regex since it allows no `/`; also reject `..` explicitly for clarity).
- `sourceMapsResolved` is honest: true only when ≥1 frame resolved; never error on missing maps.
- `OPENJAM_URL`/`OPENJAM_TOKEN` env-driven MCP; no secrets committed.
- Existing 74 api tests must stay green.

---

### Task 1: releases + sourcemaps schema + `routes/releases.ts`

**Files:**
- Modify: `packages/db/src/schema/domain.ts` (+2 tables), `apps/api/src/app.ts` (mount)
- Create: `apps/api/src/routes/releases.ts`, `apps/api/test/releases.test.ts`
- Migration: `drizzle-kit generate` → `0006_*`

**Interfaces:**
- Produces: `releases`, `sourcemaps` tables; `releasesRoutes(db, auth, storage)`; `POST /api/v1/releases`, `GET /api/v1/releases?projectId=`, `PUT /api/v1/releases/:id/sourcemaps/:filename`, `GET /api/v1/releases/:id/sourcemaps/:filename`.

- [ ] **Step 1: schema + migration** — spec §1 verbatim; `boolean`/`integer`/`index`/`uniqueIndex` imports already exist in domain.ts; generate `0006_*`; `bun test packages/db/test/` green.

- [ ] **Step 2: failing tests** — `releases.test.ts`:
```ts
it("POST release upserts on (projectId,version,environment)", …);         // 201, same id on repeat
it("PUT sourcemap stores bytes + sha; GET round-trips", …);                // PUT raw .map text → storage.read back equal; GET returns bytes
it("PUT >5MB → 413 via content-length pre-check", …);                      // header only, no body
it("PUT wrong sha256 header → 409", …);                                     // x-sha256 header vs computed
it("cross-org release PUT → 404", …);                                       // second org's releaseId
it("bad filename (.., /) → 404", …);
it("member-not-admin write → 403", …);
```

- [ ] **Step 3: routes/releases.ts** —
```ts
export function releasesRoutes(db: Db, auth: Auth, storage: ArtifactStorage) {
  const r = new Hono();
  r.use("*", requireAuth(auth, db));
  r.post("/releases", zjson("json", z.object({ projectId: z.string().min(1), version: z.string().min(1).max(120), environment: z.string().min(1).max(60), commitSha: z.string().max(64).optional() })), …);
  // projectInOrg→404; isMember; upsert onConflictDoUpdate({target:[projectId,version,environment]}) → 201 {id}
  r.get("/releases", …);   // ?projectId= → filtered; org-scoped always
  r.put("/releases/:id/sourcemaps/:filename", …);
  // release → projectInOrg(release.projectId) → 404; SAFE filename /^[A-Za-z0-9_.-]+$/ && !includes("..");
  // content-length >5*1024*1024 → 413; body=await c.req.arrayBuffer(); sha256 → compare x-sha256 if present → 409;
  // storage.write(`releases/${releaseId}`, filename, body); sourcemaps upsert {releaseId, filename, storageKey:filename, sizeBytes, sha256} → 201 {id}
  r.get("/releases/:id/sourcemaps/:filename", …); // org-scoped; storage.read → bytes; 404 missing
  return r;
}
```
- [ ] **Step 4:** mount `app.route("/api/v1", releasesRoutes(db, auth, storage))` in app.ts; tests green; tsc+biome; commit `feat(api,db): releases + sourcemaps schema, routes`.

---

### Task 2: `lib/ai-context.ts` + `GET /reports/:id/ai-context`

**Files:**
- Create: `apps/api/src/lib/ai-context.ts`, `apps/api/test/ai-context.test.ts`
- Modify: `apps/api/package.json` (+`@jridgewell/trace-mapping`), `apps/api/src/routes/reports.ts` (`GET /:id/ai-context` before `/:id` route order matters — Hono matches first; add it BEFORE the `/:id` GET if hono treats `/ai-context` as an id — verify), `bun.lock`

**Interfaces:**
- Consumes: `reports.data` envelope; `reportArtifacts` (downloadUrls via storage.getDownloadUrl); `releases`+`sourcemaps` (Task 1); `storage.read("releases/"+releaseId, filename)`.
- Produces: `GET /api/v1/reports/:id/ai-context` → spec §2 shape.

- [ ] **Step 1: failing tests** — `ai-context.test.ts`:
```ts
it("returns §2 shape for a report with envelope data", …);   // seed via real ingest or direct insert
it("failures[] resolves stacks when a matching map exists", …); // PUT a real .map fixture first (generate inline via @jridgewell/gen-mapping? simplest: a tiny hand-written .map for app.js — a 3-line valid sourcemap for one frame is small; OR skip symbolication assertion and assert sourceMapsResolved=false path + passthrough; do BOTH: with map → resolved:true, without → false)
it("no artifacts → null urls, sourceMapsResolved:false", …);
it("reproduction = last ≤15 events before first error", …);
```

- [ ] **Step 2: lib/ai-context.ts** —
```ts
export async function buildAiContext(db, storage, rep /*report row*/, artifacts /*rows*/): Promise<object>
```
- Parse `rep.data` envelope (events, meta, summary).
- `failures`: events `kind==="error"` → `{kind, message: detail.message ?? title, stack: resolved, firstSeen: rel}` — symbolication: for each stack frame `/\((https?:\/\/[^)]+):(\d+):(\d+)\)/` → basename filename → find release (newest for rep's projectId — `ORDER BY createdAt DESC LIMIT 1`) → `sourcemaps` row by filename → `storage.read` → `new TraceMap(map)` → `originalPositionFor({line,column})` → replace with `source:line:col`; any match → `sourceMapsResolved:true`.
- `network.failures`: `kind==="network"` AND `status>=400` or `detail.failed`; `slowest`: top 5 by durationMs.
- `console`: counts of `kind==="console"` by `level` (top-level level field — SDK normalized `warn`→`warning` already).
- `environment`: `meta.device` + `meta.userAgent`/`viewport`/`url`.
- `reproduction`: events before first `kind==="error"` (rel sort), last 15, `[{rel,kind,title}]`; no error → last 15 overall.
- `artifacts`: `{replay: downloadUrl|null, screenshots: count, audio: downloadUrl|null}` from artifact rows (status uploaded only).
- [ ] **Step 3: route** — `reports.ts` `r.get("/:id/ai-context", …)` placed BEFORE `r.get("/:id")` (verify hono route precedence — literal segment beats param in hono 4.x; if uncertain, register first anyway); `reportInOrg` → 404; `buildAiContext` → `c.json(ctx)`.
- [ ] **Step 4:** tests green; tsc+biome; commit `feat(api): GET /reports/:id/ai-context + stack symbolication`.

---

### Task 3: `packages/mcp` — stdio server

**Files:**
- Create: `packages/mcp/{package.json,tsconfig.json,src/{index.ts,client.ts,tools.ts},test/tools.test.ts}`
- Modify: `Makefile` test-unit glob, `bun.lock` via `bun install`

**Interfaces:**
- `new OpenJamClient({baseUrl, token})` — `listReports(params)`, `getReport(id)`, `getAiContext(id)`, `getReplay(id)` → `{path,sizeBytes}` (writes to `tmpdir()`).
- MCP tools per spec §4 names `openjam_*`.
- Env: `OPENJAM_URL`, `OPENJAM_TOKEN`; missing → stderr + exit 1.

- [ ] **Step 1: skeleton** — package.json `{name:"@bugcapture/mcp", bin:{"bugcapture-mcp":"./src/index.ts"}, deps:{"@modelcontextprotocol/sdk":"latest"}}`; tsconfig copy; `bun install`.
- [ ] **Step 2: client.ts** — fetch wrapper (`Authorization: Bearer`, `{error}`-aware throw); `getReplay` writes `join(tmpdir(), `oj-replay-${reportId}.json`)`.
- [ ] **Step 3: tools.ts + index.ts** — `McpServer` + `registerTool` (check sdk's API in node_modules — `server.tool(name, schema, handler)` or `registerTool` depending on version); 4 tools per §4; `main()` stdio transport.
- [ ] **Step 4: tests** — `tools.test.ts`: stub `globalThis.fetch` → each tool hits the right URL + Bearer header; getReplay writes file + returns path (assert exists + byte count); missing env → throws/exit path (spawn check or export a `resolveConfig` fn that throws — test that).
- [ ] **Step 5:** `bun test packages/mcp/` green; tsc+biome; commit `feat(mcp): @bugcapture/mcp stdio server (list/get/context/replay tools)`.

---

### Task 4: Docs + full verify + closeout

- [ ] README (Phase 8: ai-context route + MCP run `bun packages/mcp/src/index.ts` with env), `docs/architecture.md` (+ai-context + mcp pkg), `docs/provenance.md` (no new upstream refs — assert), `.env.example` (+`OPENJAM_URL`, `OPENJAM_TOKEN` commented).
- [ ] `make test` + `make test-api` + `make lint` + all tsc green; commit `docs: phase 8 AI context + MCP docs`.

## Self-review notes (controller)

- `ai-context` route ordering vs `GET /:id` — hono 4.x prefers literal segments, but registering the literal route FIRST is belt-and-braces; the step instructs either.
- Symbolication needs a REAL .map fixture — generating inline is the test author's job (trace-mapping's own test fixtures are the reference); if hand-writing is fiddly, a one-source `gen-mapping` fixture is fine (add `@jridgewell/gen-mapping` as a devDep if needed).
- Release matching heuristic: newest release of the report's project — documented; refinement (match by version/environment tags) is Phase 9+.
