# Phase 9 — Backlog Polish Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** rate-limit `/capture/*`, Resend email channel, dashboard integrations settings UI, `ai-context` `?from`/`?to` windows + version/environment release matching.

**Architecture:** `lib/rate-limit.ts` in-memory sliding window on `/api/v1/capture`; `email` provider + drain case in outbox; settings block in `public/app/report.html`; ai-context event-window + release match heuristic upgrade.

**Spec:** `docs/superpowers/specs/2026-10-05-phase9-polish-design.md`.

## Global Constraints

- Existing 86 api + 10 mcp + all unit tests stay green.
- `provider` column is `text` — `email` needs only a zod union update, NO migration.
- Rate-limit: OPTIONS exempt; `RATE_LIMIT_DISABLED=1` bypasses.
- Email: `RESEND_API_KEY` env; missing → `skipped` (same as integrations-without-key).
- Dashboard UI is a section inside the existing `report.html` — match its style/patterns, no framework.

---

### Task 1: `lib/rate-limit.ts` + mount on `/api/v1/capture`

**Files:**
- Create: `apps/api/src/lib/rate-limit.ts`, `apps/api/test/rate-limit.test.ts`
- Modify: `apps/api/src/routes/capture.ts` (mount)

**Interfaces:**
- `rateLimiter({ windowMs=60_000, limits: {PUT:30, POST:60} })` → Hono middleware; factory arg for tests (limit:2 for cheap test).
- Key: `x-openjam-key` header else `clientIp`; OPTIONS short-circuits allow.
- `RATE_LIMIT_DISABLED` env → passthrough (read env at request time or module init — request-time is test-friendly).

- [ ] **Step 1: failing tests** — `rate-limit.test.ts`: mount on a stub route, 3 hits with limit:2 → third 429 + `Retry-After` + `{error:"rate_limited"}`; OPTIONS → 200; `RATE_LIMIT_DISABLED=1` → all pass.
- [ ] **Step 2: rate-limit.ts** — `Map<string,number[]>`; `now=Date.now()`; prune entries `> windowMs`; `arr.length >= limit` → 429 w/ `Retry-After: Math.ceil((arr[0]+windowMs-now)/1000)`; else push+allow.
- [ ] **Step 3:** mount in capture.ts `r.use("/api/v1/capture/*", rateLimiter())` BEFORE the rate-checked handlers but AFTER preflight skip — actually OPTIONS is exempt inside the limiter, so mount order is `r.use("*", ...)` on the capture router or app.route level; confirm capture router's path so the middleware catches `/api/v1/capture`+`/uploads`.
- [ ] **Step 4:** tests green; tsc+biome; commit `feat(api): in-memory rate limiting on /capture/*`.

---

### Task 2: `email` provider + drain case

**Files:**
- Modify: `apps/api/src/routes/integrations.ts` (provider union +`"email"`), `apps/api/src/lib/outbox.ts` (email case), `apps/api/src/env.ts` (`RESEND_API_KEY` optional), `.env.example`, `apps/api/test/integrations.test.ts` or `outbox.test.ts`

- [ ] **Step 1: failing tests** — `email` provider POST → 201; drain `email` event → `fetch https://api.resend.com/emails` with `Bearer $RESEND_API_KEY` + `{from,to,subject,html}` body (stub `globalThis.fetch`); missing `RESEND_API_KEY` → `skipped`.
- [ ] **Step 2: integrations.ts** — provider union `z.enum(["github","slack","webhook","email"])`; config schema for email `{from: z.string().email(), to: z.array(z.string().email()).min(1)}` — discriminated union on provider (existing pattern).
- [ ] **Step 3: outbox.ts** — `switch (provider)` email case: env check → skipped; `POST https://api.resend.com/emails` `{from,to,subject:"[<status>] <title>",html:'<a href="<reportUrl>">view report</a>'}`; non-2xx → throw.
- [ ] **Step 4:** env.ts + `.env.example` (+`RESEND_API_KEY=`); tests green; tsc+biome; commit `feat(api): email channel via Resend`.

---

### Task 3: `ai-context` `?from`/`?to` + release-match upgrade

**Files:**
- Modify: `apps/api/src/lib/ai-context.ts` (signature `buildAiContext(db, storage, rep, artifacts, {from?,to?})`), `apps/api/src/routes/reports.ts` (parse query), `apps/api/test/ai-context.test.ts`

- [ ] **Step 1: failing tests** — `?from=1000&to=5000` filters events so a failure at rel=8000 is excluded and reproduction window reflects the bound; `meta.version`/`environment` exact-match picks the matching release's map over the newest-release fallback.
- [ ] **Step 2: ai-context.ts** — at entry: `events = events.filter(e => (from==null || e.rel >= from) && (to==null || e.rel <= to))` before all downstream computation (failures/network/console/reproduction). Release lookup: if `rep.data.meta.version && rep.data.meta.environment` → `db.select(releases).where(and(projectId eq, version eq, environment eq)).limit(1)`; hit → use it; miss → existing newest-of-project fallback.
- [ ] **Step 3: reports.ts** — `z.query({from: z.coerce.number().nonnegative().optional(), to: z.coerce.number().nonnegative().optional()})` → pass through; non-numeric/negative → 400.
- [ ] **Step 4:** tests green; tsc+biome; commit `feat(api): ai-context event windows + exact release matching`.

---

### Task 4: Dashboard settings section + docs + verify

**Files:**
- Modify: `apps/api/public/app/report.html` (settings block), `README.md`, `docs/architecture.md`, `.env.example` (`RATE_LIMIT_DISABLED` if not done in T1)

- [ ] **Step 1: read report.html** — find where the report renders + which token/auth it uses; add a `<section id="integrations">` below the report area, hidden until a report loads.
- [ ] **Step 2: fetch + render** — on report load, `GET /api/v1/projects/${report.projectId}/integrations` → table (`type`/`provider`/`enabled` checkbox→PATCH/`config` keys shown masked (server masks)/`delete` button→DELETE→re-list). Add form: type/provider selects + config JSON textarea → POST→re-list. Errors → inline text matching the viewer's error style.
- [ ] **Step 3: docs** — README (phase 9 items), architecture.md (rate-limit + email + ai-context window + settings section), .env.example parity.
- [ ] **Step 4:** `make test` + `make lint` + all tsc green; commit `feat(dashboard): integrations settings section + phase 9 docs`.
- [ ] **Step 5: manual browser verify** (controller does this — not the implementer): run api, load a report, exercise the settings section.

## Self-review notes (controller)

- Rate limiting is per-key/IP in-memory — instance-local, not distributed; flagged.
- Dashboard UI is minimal by design — no framework, no new routes; surface for later rework.
- Email provider validated as email-shaped config only; Resend failure path is the shared outbox retry.
- `report.html` changes are additive (one section) — AGENTS.md "no rewrite" preserved.
