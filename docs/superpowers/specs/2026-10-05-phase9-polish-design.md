# Phase 9 — Backlog Polish

Date: 2026-10-05. Parent: `2026-10-04-bug-capture-design.md`. Closes the
deferred items carried by Phases 4–8.

## Scope

Rate limiting on `/capture/*`, Resend email channel, dashboard integrations
UI, `ai-context` `?from`/`?to` event windows, release-matching refinement
(`meta.version`/`meta.environment`).

Skipped: Jira tracker (no credentials — interface stays open), `manifest`
field on ai-context (no report surface), replay-window trimming of the
rrweb stream itself (agents get the event-filtered context; the artifact
is still the full replay).

## 1. Rate limiting on `/capture/*`

`lib/rate-limit.ts` — in-memory sliding-window limiter mounted as a
`/api/v1/capture` middleware:

- Key: `x-openjam-key` when present (PUT + preflight) else `clientIp`.
- Limits (fixed, not configurable for MVP — per-project limits deferred):
  PUT 30/min; POST 60/min; OPTIONS exempt (CORS preflights must never
  429 — that would break every uncached cross-origin request).
- `429 {error:"rate_limited"}` + `Retry-After` seconds.
- Bucket map: `Map<key, number[]>` timestamps; prune-on-touch (entries
  older than 60s dropped); no background sweep — memory bounded by active
  keys (a stopped key stops growing the map; stale-key cleanup: keys
  with all-expired entries deleted on touch).
- `RATE_LIMIT_DISABLED=1` → middleware passthrough (test hook).

## 2. Resend email channel

- `integrations.provider` zod union gains `"email"`.
- Drain `switch (provider)` gains `email`: config `{from: string,
  to: string[]}`; env `RESEND_API_KEY` (env-only — per-integration keys
  deferred). Missing env → row marked `skipped`.
- `POST https://api.resend.com/emails` with
  `Authorization: Bearer $RESEND_API_KEY`, body `{from, to, subject:
  "[<status>] <title>", html: "<a href=\"<reportUrl>\">view report</a>"}`
  (status = payload.status when present else `report.created` style;
  subject mirrors the slack/webhook shape).
- Non-2xx → throw → existing retry/backoff path.

## 3. Dashboard integrations UI

`apps/api/public/app/report.html` gains a **Settings** section (below the
current report content, same page — not a new route):

- Read current structure first — follow its styling/fetch patterns.
- Data: `GET /api/v1/projects/:projectId/integrations` — `projectId`
  from `report.projectId` on the loaded report (the dashboard viewer
  already has it).
- Render a table: `type`, `provider`, `enabled` checkbox (PATCH
  `{enabled}`), masked config preview (`{url:"***",...}` — show keys,
  values masked), delete button (DELETE).
- Add form: `type` select (integration/notification),
  `provider` select (github/slack/webhook/email), config textarea
  (JSON) → POST. No client-side secret masking needed — server masks on
  GET.
- Auth: same mechanism the viewer already uses (session cookie; check
  what `auth.js`/`report.html` do today — reuse it).
- Errors → inline `status`-style text (match existing viewer error
  surface).
- This is UI-only on an existing surface — the spec's "dashboard settings
  later" lands here, minimal.

## 4. `ai-context` `?from`/`?to` event window

- `GET /reports/:id/ai-context?from=<ms>&to=<ms>` — `rel` numeric bounds
  (ms); events filtered BEFORE `failures`/`network`/`console`/
  `reproduction` are computed. Both optional; either alone works.
- `artifacts.replay` stays the full downloadUrl — a windowed replay
  artifact is a separate feature.
- `summary.durationMs` unaffected (report-scope, not window).

## 5. Release-matching refinement

- `lib/ai-context.ts` release lookup: if `rep.data.meta.version` AND
  `rep.data.meta.environment` exist → prefer `releases` row matching
  `(projectId, version, environment)`; else newest-of-project heuristic.
- Comment documents the fallback chain; tests cover exact-match and
  fallback paths.

## 6. Errors

- 429 as §1; email missing-env → `skipped`; UI surfaces API `{error}`
  verbatim; ai-context invalid `from`/`to` (non-numeric/negative) → 400.

## 7. Testing

- `rate-limit.test.ts`: burst PUTs past 30 → 429+Retry-After; OPTIONS
  exempt; disabled env → passthrough.
- `integrations.test.ts`/`outbox.test.ts`: `email` provider accepted in
  POST; drain emits `fetch https://api.resend.com/emails` with Bearer +
  body (fetch stubbed); missing `RESEND_API_KEY` → `skipped`.
- `ai-context.test.ts`: `?from`/`?to` filters event set; exact
  version+environment map match beats newest fallback.
- Dashboard settings UI: manual browser verify (list/create/toggle/delete
  against running api) — no new playwright suite for one section.

## 8. Files

New: `apps/api/src/lib/rate-limit.ts`, `apps/api/test/rate-limit.test.ts`.
Changed: `apps/api/src/lib/outbox.ts` (email case), `apps/api/src/
routes/integrations.ts` (provider union), `apps/api/src/lib/ai-context.ts`
(window + matching), `apps/api/src/routes/capture.ts` (rate-limit mount),
`apps/api/public/app/report.html` (settings section),
`apps/api/src/env.ts` + `.env.example` (`RESEND_API_KEY`,
`RATE_LIMIT_DISABLED`), `docs/architecture.md`, `README.md`.
