# Phase 8 — AI Context + MCP

Date: 2026-10-05. Parent: `2026-10-04-bug-capture-design.md` (§28 AI-context
shape, §29 agent anti-patterns, §30 MCP tools, §27 release metadata, §36
optional AI). Phase 4 spec (ingest — reports.data carries the envelope);
Phase 5 spec (viewer + artifact downloadUrls).

## Scope

`GET /api/v1/reports/:id/ai-context` (failure index + relevant events +
environment + symbolicated stacks), release + source-map upload, and
`packages/mcp` — a stdio MCP server exposing list/get/context/replay tools
to agent clients (Claude Code, Cursor).

Out of scope: AI summarization/severity scoring (§6 AI gate — no LLM calls),
recommendations engine, remote MCP transport (stdio only), replay-window
trimming (§29 `?from=` is a follow-up — full envelope indices suffice for
MVP).

## 1. Schema (one additive migration)

```ts
releases: {
  id text pk,
  projectId text not null → projects.id cascade,
  version text not null,
  environment text not null,              // e.g. staging|production
  commitSha text,
  createdAt timestamptz default now(),
  uniqueIndex (projectId, version, environment),
}

sourcemaps: {
  id text pk,
  releaseId text not null → releases.id cascade,
  filename text not null,                 // e.g. "app.a1b2c3.js"
  storageKey text not null,               // under releases/<releaseId>/ ns
  sizeBytes int not null, sha256 text not null,
  createdAt timestamptz default now(),
  uniqueIndex (releaseId, filename),
}
```

Source maps are NOT `report_artifacts` (they're release-scoped, not
report-scoped) — `storage.write("releases/"+releaseId, filename, body)`
reuses `ArtifactStorage` unchanged (the reportId arg is just a namespace).

## 2. Endpoints (authed, `/api/v1`)

- `POST /releases` `{version, environment, commitSha?}` — `requireAuth` +
  `isMember`; `projectInOrg` on body projectId; upsert on
  (projectId,version,environment) → 201 `{id}`.
- `PUT /releases/:id/sourcemaps/:filename` — release→project→org check
  (404 cross-org); raw body ≤5MB (`content-length` early check); sha256
  verified if `x-sha256` header sent; `storage.write` +
  `sourcemaps` upsert → 201 `{id}`.
- `GET /releases` — `?projectId=` filtered list (columns all — small rows).
- `GET /reports/:id/ai-context` — `reportInOrg` → 404; builds the §28
  shape from `report.data` envelope + `report_artifacts` + best-effort
  symbolication (§3). Response `{...}` per the shape below.

```jsonc
{
  "schemaVersion": 2,
  "summary": { "title", "status", "url", "capturedAt", "durationMs" },
  "failures": [{ "kind": "error", "message", "stack": ["file:line …"], "firstSeen": <rel ms> }],
  "network": { "failures": [{ "method","url","status","durationMs" }],
               "slowest":  [{ "url","durationMs" }] },
  "console": { "errors": <n>, "warnings": <n> },
  "environment": { "userAgent","viewport","url","language","platform" },
  "reproduction": [{ "rel","kind","title" }],        // last ≤15 events before first error
  "artifacts": { "replay": "<downloadUrl|null>",
                 "screenshots": <n>,
                 "audio": "<downloadUrl|null>" },
  "sourceMapsResolved": <bool>,
  "manifest": <report_manifest row if Phase-2 manifest lands — else omitted>
}
```

`reproduction` = events before the first `kind:"error"` event (last 15);
no error → last 15 events overall.

## 3. Symbolication

`@jridgewell/trace-mapping` dep on `apps/api`. For each error event's
`detail.stack` (string[] of `"fn (https://host/app.abc.js:LINE:COL)"`
frames): extract `filename` → match `sourcemaps` row by filename basename
→ `storage.read("releases/"+releaseId, filename)` → `TraceMap` →
`originalPositionFor({line,column})` → replace frame text with
`origFile:origLine` (fall back to the raw frame when unresolvable).
`sourceMapsResolved: true` when ≥1 frame resolved; false otherwise (and
when no map exists — honest signal, never an error).

Release matching: `report.environmentId` → project → releases of that
project matching the report's `meta.version`/environment when present;
fallback = newest release of the project (maps churn slower than
releases). Simple heuristic documented; wrong-map risk is acceptable
(symbolication output marks resolved frames clearly).

## 4. `packages/mcp` (`@bugcapture/mcp`)

`@modelcontextprotocol/sdk` stdio server:

```ts
// env: OPENJAM_URL, OPENJAM_TOKEN (PAT)
tools:
  openjam_list_reports({ projectId?, status?, limit?=20 }) → GET /api/v1/reports?…
  openjam_get_report({ reportId })                          → GET /api/v1/reports/:id
  openjam_get_ai_context({ reportId })                      → GET /api/v1/reports/:id/ai-context
  openjam_get_replay({ reportId })                          → GET :id → find replay artifact → fetch downloadUrl → write tmp file → return { path, sizeBytes }  // §29: agent never pulls raw replay into context
```

~150 lines total: `server.ts` + `client.ts` (fetch wrapper w/ Bearer).
`package.json` bin: `bugcapture-mcp`. Tests stub `fetch` and assert
URL/headers/body per tool + env-missing error.

## 5. Error handling

- Unknown release → 404; cross-org → 404.
- Map body >5MB → 413; sha mismatch → 409 (same contract as artifact PUT).
- ai-context: missing artifacts → nulls in `artifacts`, never an error;
  unreadable map → frame passthrough.
- MCP: env vars missing → server exits with a clear stderr message.

## 6. Testing

`apps/api/test/releases.test.ts`: POST release (upsert), PUT map round-trip
(bytes+sha stored; `storage.read` matches), GET list filtered, 404/413/409
paths.
`apps/api/test/ai-context.test.ts`: fixture report (envelope w/
console+network+error events + replay artifact descriptor) → assert all
shape fields; stack symbolicated when a real `.map` fixture exists
(generate one fixture map inline — `trace-mapping` test conventions);
`sourceMapsResolved:false` without map.
`packages/mcp/test/tools.test.ts`: stubbed fetch → correct URL + Bearer +
body per tool; env missing → error.

## 7. Files

New: `apps/api/src/routes/releases.ts`, `apps/api/src/lib/ai-context.ts`,
`apps/api/test/{releases,ai-context}.test.ts`,
`packages/mcp/{package.json,tsconfig.json,src/{index.ts,client.ts,tools.ts},
test/tools.test.ts}`, `packages/db` migration `0006_*`.

Changed: `packages/db/src/schema/domain.ts` (+2 tables),
`apps/api/src/app.ts` (mount releases + ai-context read in reports.ts or
its own route), `apps/api/package.json` (+trace-mapping),
`apps/api/src/lib/session.ts` (nothing), `.env.example` (`OPENJAM_URL`,
`OPENJAM_TOKEN` examples for MCP), `Makefile` (capture-sdk+mcp in
test-unit), `README.md`, `docs/architecture.md`, `docs/provenance.md`.
