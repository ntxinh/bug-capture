# Phase 5 — Dashboard

Date: 2026-10-05. Parent: `2026-10-04-bug-capture-design.md` (§5 dashboard,
§8 report viewer), `2026-10-05-phase4-remote-upload-design.md`.

## Scope

Static `apps/web` SPA served by `apps/api` — no bundler, no second process.
Pages: login/sign-up, project list + create, report list, report viewer
reusing the extension's `renderer.js` verbatim. Also lands the Phase-4
deferrals now needed: artifact GET route, report-delete sweep, list
projection.

Out of scope: org/member management UI beyond create-org-on-first-login,
comments, share-link minting UI (routes exist), settings, i18n. Phase 6 SDK
+ Phase 7 integrations unchanged.

## 1. Serving

`apps/api` mounts two read-only static trees (Hono `serveStatic`):

- `/app/*` → `apps/web/` (the SPA)
- `/ext/*` → `apps/extension/` (renderer.js, manifest-independent assets, and
  `dist/rrweb-player.js` + `dist/player-assets` produced by `make build`)

`/app` and `/` → `apps/web/index.html`. Auth is cookie-only for the SPA:
a 401 from any `/api/v1` call renders the login view client-side.
CSRF: better-auth's same-origin defaults cover the POSTs; flagged residual —
revisit only if the API is ever served cross-origin.

`make build` already builds `apps/extension/dist`; the web app needs no
build. README gains the `/app` URL.

## 2. Pages (`apps/web/`)

Plain HTML + `<script type="module">`, no framework:

- **`index.html` / `index.js`** — one page, three sections swapped by state:
  1. *Auth* — email+password; `POST /api/auth/sign-in/email`, fallback
     `sign-up/email`; then `organization/create` + `set-active` if the user
     has no org (same calls test/helpers.ts makes).
  2. *Projects* — `GET /api/v1/projects` list + create form
     (`POST /api/v1/projects` {name, slug, key?}) — required because today a
     project can only be made via curl. Selecting a project filters the
     report list (`?projectId=`).
  3. *Reports* — `GET /api/v1/reports?projectId=` slim list → links to
     `report.html?id=…`.

- **`report.html` / `report.js`** — viewer: `GET /api/v1/reports/:id`
  (session cookie) → returns `{…report row, artifacts:[{id,kind,
  downloadUrl}]}`. Reconstruct the extension `report` shape:
  `data.meta`+`data.device`→`meta`/`device`; `data.events`→`events`;
  artifacts lazily: replay → `fetch(downloadUrl).text()` → `rrwebEvents`
  (renderer already normalizes string→array); audio → blob→dataURL →
  `report.audio`; screenshots stay inline in events.
  Then `import renderReport, mountReplay, mountAudio, REPORT_CSS, REPLAY_CSS
  from "/ext/renderer.js"` + classic `<script src="/ext/dist/rrweb-player.js">`
  — identical mount sequence to `viewer.js`. Export button MAY reuse
  `buildReportHTML` from `/ext/report-builder.js` + the same replay-assets
  script (cheap; ship it if ≤40 lines, else drop).

## 3. API additions

All under `requireAuth`, org-scoped, `{error}` shape, `isUniqueViolation`
where inserts happen:

- **`GET /api/v1/uploads/:reportId/:key`** — same SAFE_SEGMENT regex +
  artifact→report→org check as PUT. LocalFs: stream file (`new Response(
  Bun.file(path).stream())` or `createReadStream`), `content-type` from
  `report_artifacts.contentType`, `content-disposition: inline`. S3:
  `302` redirect to `storage.getDownloadUrl`.
- **`GET /api/v1/reports`** — column projection: omit `data` (full envelope
  per row is megabytes); keep all scalar columns; add `?projectId=` filter.
- **`GET /api/v1/reports/:id`** — full row + `artifacts: [{id, kind,
  sizeBytes, sha256, status, downloadUrl}]` where
  `downloadUrl = storage.getDownloadUrl(reportId, storageKey)` (LocalFs →
  `/api/v1/uploads/…`; S3 → presigned GET).
- **`DELETE /api/v1/reports/:id`** — after row delete (existing cascade
  drops `report_artifacts` rows), best-effort `storage.delete(reportId, key)`
  per artifact; failures logged via `console.warn`, never fatal, response
  unchanged (204).

`storage.getDownloadUrl` stays the single place URLs are minted — no
inline URL construction in routes.

## 4. Error handling

- 401s → SPA shows auth section (client-side, on fetch failure).
- Report not found / cross-org → 404 → viewer shows "not found".
- Missing artifact bytes on GET → 404 `{error}` (same as PUT path's lookup).
- org with zero reports → empty list, not an error state.

## 5. Testing

`apps/api/test/` additions:

- `uploads-get.test.ts` — ingest → PUT → GET round-trip: bytes equal,
  `content-type` matches stored column; cross-org GET → 404; traversal
  (`..`, `/`) key → 404.
- `reports.test.ts` extension — list response rows lack `data`; `?projectId=`
  filters; `GET /:id` includes `artifacts[]` with `downloadUrl`.
- delete-sweep — DELETE report → artifact files absent from tmpdir
  (`storage.head` null), row gone.

Web UI: no Playwright this phase (dashboard e2e lands with Phase 8 suite).
Verification = api tests above + one manual pass: `make db-up && make
db-migrate && make dev-api`, open `/app`, sign up → org → project → upload
via extension viewer → open report in `/app/report.html`, screenshot through
the browser tool.

## 6. Files

New: `apps/web/index.html`, `apps/web/index.js`, `apps/web/report.html`,
`apps/web/report.js`, `apps/web/style.css`, `apps/api/test/uploads-get.test.ts`.

Changed: `apps/api/src/app.ts` (static mounts), `apps/api/src/routes/ingest.ts`
(+GET handler in same file — it owns the uploads path),
`apps/api/src/routes/reports.ts` (projection + artifacts in detail + delete
sweep), `Makefile` (`web` smoke target optional — static, skip),
`README.md`, `docs/architecture.md` (+`/app` mount line).
