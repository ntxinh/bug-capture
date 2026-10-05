# Phase 7 — Integrations Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** GitHub issue creation on a report + Slack/webhook notifications via in-process outbox worker; per-project integration config with encrypted secrets.

**Architecture:** `project_integrations` + `report_outbox_events` tables; `lib/crypto.ts` (AES-256-GCM seal/unseal under `INTEGRATIONS_KEY`); `lib/trackers.ts` (`IssueTracker` + `GitHubIssueTracker`); `lib/outbox.ts` (`emitReportEvent` in tx / `drainOutbox` / `startOutboxWorker`); `routes/integrations.ts` (config CRUD) + `routes/issues.ts` (`POST /reports/:id/issues`); emit sites in `handleIngest` (tx) + reports PATCH (resolved) + issues route (issue.linked).

**Tech Stack:** node:crypto AES-GCM, global fetch for tracker+deliveries, drizzle schema+1 migration, testcontainers.

**Spec:** `docs/superpowers/specs/2026-10-05-phase7-integrations-design.md`.

## Global Constraints

- `{error}` shapes, `zjson`, `isUniqueViolation`, org-scope via policy helpers, cross-org→404, `isAdmin` on writes.
- Secrets (`token`, `url`) AES-256-GCM encrypted at rest in `config` jsonb; masked `"•••"` on read. `INTEGRATIONS_KEY` = 64-hex env (32B). Any write with a secret field + missing key → 503.
- Outbox row for `report.created` inserted inside the ingest tx (same tx — never visible pre-commit).
- Payload dashboard link: `IngestIdentity` gains `reportUrl` (each route passes `${baseUrl}/app/report.html?id=${reportId}` — the reportId isn't known at identity-build time, so pass a TEMPLATE `${baseUrl}/app/report.html?id=` and append in the handler; OR simpler: emit payload uses `/app/report.html?id=<reportId>` with baseUrl — pick the cleaner one, state it in the report).
- No `OUTBOX_DISABLED=1` → worker only runs in `index.ts` (never in tests — tests call `drainOutbox` directly).
- Migrations: `drizzle-kit generate` → `0005_*`; `bun test packages/db/test/` green.

---

### Task 1: Schema (project_integrations + report_outbox_events) + lib/crypto.ts

**Files:**
- Modify: `packages/db/src/schema/domain.ts` (+2 tables, +`boolean` import if absent), `packages/db/src/schema/index.ts` (auto-export via `export *`?)
- Create: `apps/api/src/lib/crypto.ts` (+test `apps/api/test/crypto.test.ts` — no containers needed but it lives in api test dir; run with api suite)
- Migration: `drizzle-kit generate` → `0005_*`

**Interfaces:**
- Produces: `projectIntegrations`, `reportOutboxEvents` tables; `sealSecret(plaintext, keyHex) → "iv.tag.ct"` hex-packed string; `unsealSecret(packed, keyHex) → plaintext`; `maskConfig(cfg)` helper can live in routes.
- `INTEGRATIONS_KEY` read via `process.env.INTEGRATIONS_KEY` at call time (test-settable).

- [ ] **Step 1: tables** — per spec §1 verbatim (provider/unique index; outbox columns + `(status, nextAttemptAt)` index). `createdBy` NOT NULL on `project_integrations`? No — integration rows aren't per-user; skip it (spec silent → choose simpler, note in report).
- [ ] **Step 2: crypto.ts** — `seal`/`unseal` via `createCipheriv("aes-256-gcm")`: `iv=randomBytes(12)`, tag appended; pack format `iv.tag.ciphertext` (all hex). `getKey()` reads env → `Buffer.from(hex,"hex")`, length must be 32 else throw. Tests: round-trip; wrong key → throws; tampered ct → throws; missing env → throws (so callers translate to 503).
- [ ] **Step 3:** `bunx drizzle-kit generate` in packages/db; `bun test packages/db/test/` green; `bun test apps/api/test/crypto.test.ts` green; tsc+biome; commit `feat(db,api): integrations + outbox schema, aes-gcm secret helpers`.

---

### Task 2: `routes/integrations.ts` — config CRUD

**Files:**
- Create: `apps/api/src/routes/integrations.ts`, `apps/api/test/integrations.test.ts`
- Modify: `apps/api/src/app.ts` (mount under `/api/v1`)

**Interfaces:**
- Consumes: tables + `sealSecret`/`getKey`; `projectInOrg`, `isAdmin`, `zjson`.
- Produces: `GET /projects/:pid/integrations`, `POST` (upsert), `PATCH /integrations/:iid`, `DELETE /integrations/:iid`; masked-config read shape.

- [ ] **Step 1: failing tests** — per spec §7: create github config w/ `INTEGRATIONS_KEY` set (test envs set it in `beforeEach` + restore) → list shows `token:"•••"`; missing key + secret field → 503; member-not-admin POST → 403; cross-org GET → 404; upsert on (projectId,provider); PATCH enabled; DELETE → 204 → GET empty.

- [ ] **Step 2: routes** —
```ts
const providerSchemas = {
  github: z.object({ repo: z.string().regex(/^[\w.-]+\/[\w.-]+$/), token: z.string().min(20), labels: z.array(z.string()).max(10).optional() }),
  slack:  z.object({ url: z.string().url().startsWith("https://") }),
  webhook: z.object({ url: z.string().url() }),
};
const SECRET_KEYS = new Set(["token", "url"]);
// seal each secret field before insert; mask each on read ("•••").
```
- `POST`: `projectInOrg`→404; `isAdmin`→403; zod `provider` enum + config validated by providerSchemas[provider]; missing key + secret → 503; upsert `(projectId,provider)` on conflict → update config.
- `PATCH`: same gates; `enabled` bool or config partial; `DELETE` org-scoped via project→org lookup.
- [ ] **Step 3:** tests green; tsc+biome; commit `feat(api): integrations config CRUD (masked secrets)`.

---

### Task 3: `lib/trackers.ts` + `routes/issues.ts` (`POST /reports/:id/issues`)

**Files:**
- Create: `apps/api/src/lib/trackers.ts`, `apps/api/src/routes/issues.ts`, extend `apps/api/test/integrations.test.ts` or new `issues.test.ts`
- Modify: `apps/api/src/app.ts` (mount)

**Interfaces:**
- Consumes: Task 2's config rows + `unsealSecret`; `reportInOrg`, `isMember`.
- Produces: `IssueTracker`, `GitHubIssueTracker`; `POST /api/v1/reports/:id/issues` → `201 {externalId, url}` + `external_links` row + emits `issue.linked` (emit wired in Task 4 — for now insert the outbox row via a stub call that Task 4 replaces, OR land `emitReportEvent` early: simplest is to write `emitReportEvent` in Task 3's commit inside lib/outbox.ts minimal form (insert only, no worker) and have Task 4 add drain/worker — pick that).

- [ ] **Step 1: failing tests** — stub `globalThis.fetch` (capture args, return `{ok:true,json:async()=>({number:42,html_url:"https://github.com/o/r/issues/42"})}`): POST issues → fetch called with Bearer + repo path + title; `external_links` row `{provider:'github',externalId:'42',url}`; response `201 {externalId:'42',url}`; no github integration → 404; upstream `{ok:false,status:500}` → 502; cross-org → 404; member-not-member → policy result.
- [ ] **Step 2: lib/trackers.ts** per spec §3 verbatim (fetch POST to api.github.com; throws on !ok).
- [ ] **Step 3: lib/outbox.ts minimal** — `emitReportEvent(db, type, reportId, payload)` insert pending row (drain/worker land Task 4 but the insert is needed now for `issue.linked`).
- [ ] **Step 4: routes/issues.ts** — `requireAuth` + `isMember` + `reportInOrg` → project → enabled github integration → `unsealSecret` fields → tracker.createIssue → `external_links` insert + `emitReportEvent(db,"issue.linked",rep.id,{title,url:reportUrl,externalUrl:url})` → `201 {externalId,url}`; errors per spec. `reportUrl` = `${baseUrl}/app/report.html?id=${rep.id}` — needs baseUrl → `issuesRoutes(db, auth, baseUrl)`.
- [ ] **Step 5:** tests green; tsc+biome; commit `feat(api): GitHub issue tracker + POST /reports/:id/issues`.

---

### Task 4: outbox drain/worker + emit sites + docs

**Files:**
- Modify: `apps/api/src/lib/outbox.ts` (+`drainOutbox`, `startOutboxWorker`), `apps/api/src/lib/ingest-shared.ts` (emit inside tx; `id.reportUrl` or reportId-appended url), `apps/api/src/routes/{ingest,capture}.ts` (pass baseUrl/reportUrl), `apps/api/src/routes/reports.ts` (emit `report.resolved` on status→resolved), `apps/api/src/index.ts` (`startOutboxWorker` unless `OUTBOX_DISABLED=1`), `.env.example` (`INTEGRATIONS_KEY=<64-hex>`, `OUTBOX_DISABLED`), `README.md`, `docs/architecture.md`, `docs/provenance.md`
- Test: `apps/api/test/outbox.test.ts`

**Interfaces:**
- Consumes: everything prior.
- Produces: `drainOutbox(db,{limit?,fetchImpl?}) → sentCount`; `startOutboxWorker(db,opts) → stop()`; event types `report.created|report.resolved|issue.linked`.

- [ ] **Step 1: emit sites** —
  - `handleIngest`: `IngestIdentity` gains optional `reportUrl` — actually simplest: payload url = `${baseUrl}/app/report.html?id=${reportId}`; `baseUrl` already param? No — handleIngest doesn't take baseUrl; add `reportUrl` to identity as a TEMPLATE ending `id=` and handler appends `reportId`, OR compute inside handler from a new `id.baseUrl`. Implementer's pick (state in report). Emit `emitReportEvent(tx, "report.created", reportId, {title, status:"open", url})` INSIDE the tx after the report insert.
  - `reports.ts` PATCH: after update, `if (body.status === "resolved") emitReportEvent(db,"report.resolved",rep.id,{title,status:"resolved",url})` — needs baseUrl → `reportsRoutes` already has it? It has `(db, auth, storage)` — check signature; baseUrl must thread (app.ts already has it).
  - issues route already emits `issue.linked`.
- [ ] **Step 2: drainOutbox** — spec §5: `SELECT FOR UPDATE SKIP LOCKED` pending+eligible ≤limit → per row: report→project→enabled slack/webhook integrations → POST per integration (slack `{text:"🐞 <title> — <url>"}`; webhook `{type,report:{id,title,status,url},payload}`); success→`sent`, fail→`attempts+1`,`lastError`,`nextAttemptAt=now()+attempts*60s`; `attempts>=6`→`failed`. `fetchImpl` param defaults `fetch`.
- [ ] **Step 3: failing tests** — `outbox.test.ts`: real ingest creates `report.created` row (assert via ctx.db); `drainOutbox(ctx.db,{fetchImpl:stub})` → slack POST seen → row `sent`; webhook payload shape; failing fetch → `attempts=1`+pending; `attempts=5`+fail→`failed`; PATCH resolved → `report.resolved` row.
- [ ] **Step 4: worker boot** — `index.ts`: `if (env.outboxDisabled !== "1") startOutboxWorker(db,{intervalMs:15_000})` (add env var read; `env.ts` may need the field — check it).
- [ ] **Step 5: docs + verify** — `.env.example`, README integrations section, architecture line, provenance crikket reference; `make test`+`make test-api`+`make lint`+tsc all green; commit `feat(api): outbox worker + report event emissions + integrations docs`.

## Self-review notes (controller)

- `emitReportEvent` signature accepts a `db`-or-`tx` (drizzle tx duck-types — type it `Db` or a union; tx param works if typed loosely — check what other tx-scoped helpers do).
- `boolean` import may already exist in domain.ts imports — verify before adding.
- `integration` row `createdBy` intentionally absent (project-scoped not user-scoped).
- Worker interval in `index.ts` only; helpers/test path never starts it — assert no interval in test env (OUTBOX_DISABLED defaults to whatever env says; test helpers may need `delete process.env.OUTBOX_DISABLED`? No — workers only start in index.ts which tests never import).
