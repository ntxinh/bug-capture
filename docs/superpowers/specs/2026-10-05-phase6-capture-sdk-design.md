# Phase 6 — Capture SDK

Date: 2026-10-05. Parent: `2026-10-04-bug-capture-design.md` (§20 SDK,
§22 public_key + origins), `2026-10-05-phase4-remote-upload-design.md`
(ingest pipeline this reuses), `2026-10-05-phase5-dashboard-design.md`
(dashboard renders SDK reports identically).

## Scope

`packages/capture-sdk` — embeddable browser recorder producing the same
`BugReportEnvelope` → same ingest→PUT→finalize pipeline as the extension,
authenticated by `public_key` + `Origin` instead of PAT/session. Public
ingest/upload/finalize routes + scoped CORS.

Out of scope: screenshots (no CDP/captureVisibleTab in a page context),
audio narration (getUserMedia is extension-UX, not SDK MVP), Angular/React
wrappers, offline queueing, sampling, SDK-side session replay trimming.

## 1. `packages/capture-sdk` (`@bugcapture/capture`)

TS, ESM, browser-only (no node APIs), single runtime dep `rrweb`, plus
`@bugcapture/redaction` (pure TS, allowed — the no-bundler constraint was
extension-specific).

```ts
export interface OpenJamConfig {
  projectKey: string;            // oj_pk_…
  apiUrl: string;                // e.g. https://bugs.company.com
  environmentId?: string;
  maxEvents?: number;            // default 5000, ring buffer
  maxBodyBytes?: number;         // captured req/res body cap, default 64*1024
}
export interface OpenJamSession {
  submit(opts?: { title?: string; description?: string }): Promise<{ reportId: string }>;
  discard(): void;               // stop recording, drop buffers
}
export function initOpenJam(cfg: OpenJamConfig): OpenJamSession;
```

Capture surface (Browser APIs only):

- **rrweb** — `record({ emit })`, buffers events; `checkoutEveryNms: 30000`.
- **console** — patch `log|info|warn|error|debug` → event
  `{t,rel,kind:"console",title:level,detail:{level,args:stringified ≤8KB}}`;
  original called through.
- **network** — wrap `fetch` + `XMLHttpRequest` →
  `{kind:"network",title:"METHOD url",detail:{method,url,status,durationMs,
  requestHeaders,requestBody?,responseHeaders,responseBody?}}`; bodies only
  when `content-type` json/text/xml AND ≤`maxBodyBytes`; headers/bodies run
  through `createRedactionPipeline(DEFAULT_RULES)` BEFORE entering events.
- **errors** — `window.onerror` + `unhandledrejection` →
  `{kind:"error",title:msg,detail:{stack,source,lineno,colno}}`.
- **page** — one `meta` event at init: `{url,title,userAgent,viewport,
  referrer,language,platform}`.

Events use the extension's `{t,rel,kind,title,detail}` shape so
`renderer.js` renders SDK reports unchanged (dashboard already proves this).

`submit()` → envelope v2:
```json
{
  "schemaVersion": 2,
  "summary": { "title": "<opts.title ?? document.title ?? location.href>",
               "description": "<opts.description ?? ''>",
               "url": "<location.href>" },
  "meta": { "capture": "sdk", "userAgent": "…", "viewport": "WxH",
            "url": "…", "capturedAt": <ms>, "durationMs": <ms>,
            "device": { "url","title","userAgent","viewport" } },
  "events": [ … ],
  "artifacts": [{ "kind":"replay", "sha256":"…", "sizeBytes":n }]
}
```
then `POST {apiUrl}/api/v1/capture/ingest` with header
`X-OpenJam-Key: <projectKey>` (browser adds `Origin` automatically) → PUT
replay bytes to each upload URL (no auth header — presigned or public
capture route; SDK treats them opaquely like the extension does for S3) →
`POST {apiUrl}/api/v1/capture/reports/:id/finalize` with the same key
header → `{reportId}`.

## 2. API — capture routes

New `routes/capture.ts`, mounted `app.route("/api/v1/capture", captureRoutes(db, storage))`:

- **Auth**: no session/PAT. Each handler resolves the caller:
  `key = c.req.header("x-openjam-key")` →
  `SELECT … FROM projects WHERE public_key = key` → `{project, orgId}`.
  Missing/unknown key → 401 `{error:"unauthorized"}`.
- **Origin check**: when `project_origins` rows exist for the project,
  request `Origin` must equal one row's `origin` exactly (after
  normalization — strip trailing `/`); else → 403 `{error:"forbidden
  origin"}`. Zero configured origins → allow any (documented default; add
  origins before exposing publicly).
- **CORS**: `hono/cors` on `/api/v1/capture/*` only:
  `origin: (origin) => origin-allowed-for-the-resolved-project ? origin : null`,
  `allowMethods: ["POST","PUT","OPTIONS"]`,
  `allowHeaders: ["content-type","x-openjam-key"]`, `maxAge: 600`.
  Preflight resolves the project from `x-openjam-key` on the OPTIONS
  request headers too (browsers send custom headers on preflight).
- **Endpoints** (same semantics as authed ingest, shared handler bodies):
  - `POST /ingest` — body `{environmentId?, envelope}` — `projectId`
    comes FROM THE KEY, not the body; env must belong to that project;
    creates `reports` row (`source:"sdk"`) + pending artifacts + upload
    targets — same single transaction as `ingestRoutes`.
  - `PUT /uploads/:reportId/:key` — SAFE_SEGMENT + artifact→report→project
    check (project from the API key); same size/sha verification.
  - `POST /reports/:id/finalize` — report must belong to the key's project;
    same head→missing/uploaded→stopped→submitted logic.
- Handler-body extraction: the three route bodies in `ingestRoutes` get
  lifted to local functions taking a resolved `{orgId, projectId}` so both
  routers share one implementation — captureRoutes passes key-resolved
  identity, ingestRoutes passes session/PAT identity (projectId still
  body-supplied there; capture overrides it).

## 3. Error handling

- Missing/unknown `x-openjam-key` → 401.
- Origin configured-but-unmatched → 403 `{error:"forbidden origin"}`.
- Envelope invalid → 400 (same zjson shape).
- `environmentId` from another project → 404.
- Size/sha mismatch on PUT → existing 413/409.
- Rate limiting: NOT in this phase — deferred (flagged; a public ingest
  endpoint will need it before real exposure).

## 4. Testing

`apps/api/test/capture.test.ts` (testcontainers):

- happy path: create project → key from row → `POST /api/v1/capture/ingest`
  `{envelope}` with `Origin: http://ok.dev` → 201 → PUT → finalize →
  report row `source:"sdk"`, session n/a.
- missing key → 401; bad key → 401.
- origins configured + wrong Origin → 403; right Origin → 201; no origins
  → any Origin → 201.
- OPTIONS preflight on `/api/v1/capture/ingest` with `x-openjam-key` +
  `access-control-request-headers` → `access-control-allow-origin` echoes
  the configured origin only.
- `environmentId` from another project → 404.

`packages/capture-sdk/test/` (bun:test, no browser):

- envelope mapper: events→envelope shape, title fallbacks, artifact
  descriptor sha/size correctness, meta fields.
- redaction applied to captured network entries before events.
- fetch/XHR wrappers don't break passthrough (mock both).

Browser smoke (throwaway, end of task): serve a static fixture page that
`initOpenJam`s against the test api, drive it with the `browser` tool,
submit, open `/app/report.html?id=`, screenshot. Script + page deleted
after; evidence in report.

## 5. Files

New: `packages/capture-sdk/{package.json,tsconfig.json,src/index.ts,
src/recorder.ts,src/envelope.ts,src/upload.ts,test/envelope.test.ts}`,
`apps/api/src/routes/capture.ts`, `apps/api/test/capture.test.ts`.

Changed: `apps/api/src/routes/ingest.ts` (extract handler bodies),
`apps/api/src/app.ts` (mount capture router), `Makefile`
(`packages/capture-sdk` in test-unit), `README.md`, `docs/architecture.md`,
`docs/provenance.md` (crikket capture SDK referenced as behavior
reference).
