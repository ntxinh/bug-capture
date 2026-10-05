# Phase 4 — Remote Upload

Date: 2026-10-05. Parent: `2026-10-04-bug-capture-design.md` (§8 upload flow, §19
storage, §23 redaction) and `2026-10-04-phase3-backend-mvp-design.md`.

## Scope

Extension → API remote upload of a captured report. In scope: artifact
storage abstraction, personal-access-token auth, three ingest endpoints, one
extension uploader module, redaction before upload. Out of scope: dashboard
viewer (Phase 5), capture SDK (Phase 6), integrations (Phase 7), AI context
(Phase 8). The local HTML export path is untouched — upload is additive,
optional, and nothing in `packages/` may add a runtime dependency to the
extension's capture path (AGENTS.md).

## 1. `packages/storage` — ArtifactStorage

Interface (spec §19 verbatim):

```ts
interface ArtifactStorage {
  createUpload(reportId: string, kind: ArtifactKind, sizeBytes: number, sha256: string): Promise<UploadTarget>;
  getDownloadUrl(reportId: string, key: string): Promise<string>;
  head(reportId: string, key: string): Promise<{ sizeBytes: number } | null>;
  delete(reportId: string, key: string): Promise<void>;
}

interface UploadTarget { key: string; url: string; headers?: Record<string, string>; }
```

Implementations:

- **`LocalFsStorage`** — root dir injected (default `./data/artifacts`).
  `createUpload` returns `{key, url: `${baseUrl}/api/v1/uploads/${encodeURIComponent(key)}`}`.
  `head` stats the file. Used in dev and tests. `baseUrl` injected (same
  value already passed to `buildApp` for share URLs).
- **`S3Storage`** — presigned `PUT` via `aws4fetch`; config `{endpoint, bucket,
  accessKeyId, secretAccessKey, urlTtlSeconds}`. `head` → S3 `HEAD` object.
  Constructed only when `S3_*` envs present; otherwise `LocalFsStorage`.

Selection happens once in `apps/api/src/index.ts` (env-driven) and is passed
into `buildApp` — signature becomes `buildApp(db, auth, baseUrl, storage)`.
Both call sites updated.

Key format: `<reportId>/<artifactId>-<kind>` — already unique, no user input.

## 2. Personal access tokens

New table `personal_access_tokens`:

```sql
id              text pk (crypto.randomUUID)
user_id         text not null references users(id) on delete cascade
organization_id text not null references organizations(id) on delete cascade
label           text not null
token_hash      text not null unique          -- sha256 hex
created_at      timestamptz not null default now()
last_used_at    timestamptz
revoked_at      timestamptz
```

Routes (session-auth only — you can't mint a PAT with a PAT):

- `POST /api/v1/tokens` `{label}` → `201 {id, label, token: "oj_pat_<base64url(24B)>"}` (raw shown once)
- `GET /api/v1/tokens` → `[{id, label, createdAt, lastUsedAt, revokedAt}]` for caller's org
- `DELETE /api/v1/tokens/:id` → sets `revoked_at`; org-scoped via `organization_id`; cross-org → 404

`requireAuth` (apps/api/src/lib/session.ts) extended, same middleware name and
context vars so no route changes:

1. `Authorization: Bearer oj_pat_…` → sha256 → lookup active token → set
   `c.var.user` (joined user row), `c.var.orgId` (token's org), `c.var.authKind = "pat"`;
   update `last_used_at` fire-and-forget.
2. Else better-auth `getSession` → `authKind = "session"`.
3. Neither → 401 `{error: "unauthorized"}`.

`authKind` on context so token routes can refuse PAT auth
(`authKind === "pat"` → 403 on `/api/v1/tokens/*`).

## 3. Ingest endpoints

All under `requireAuth`; all org-scoped exactly like Phase 3 routes
(404-not-403 for cross-org).

### `POST /api/v1/reports/ingest`

```json
{
  "projectId": "…",
  "environmentId": "…?",          // must belong to project, else 404
  "captureSessionId": "…?",       // must belong to caller's org project, else 404
  "envelope": { "schemaVersion": 2, "summary": {...}, "meta": {...}, "events": [...],
                "artifacts": [{"kind":"replay","sha256":"…","sizeBytes":123}, …] }
}
```

Semantics: `projectInOrg` check; validate `environmentId`/`captureSessionId`
belong to that project; insert `reports` row (title from
`envelope.summary.title` or meta fallback, `description`, `priority`,
`source:"extension"`, `captureSessionId` when given) plus one
`report_artifacts` row per declared artifact (`status:"pending"`) in a single
transaction. For each artifact call `storage.createUpload` and return:

`201 {reportId, uploads: [{artifactId, key, url, headers?}]}`

Envelope validation: `z.object` — schemaVersion literal 2; `summary`/`meta`
loose passthrough (`z.record`); `artifacts` array of `{kind enum
replay|screenshot|audio|attachment, sha256 64-hex, sizeBytes int>0}`,
`max(64)`; `events` capped `max(20000)` stored verbatim in `reports.data`
(jsonb). Reject → existing `{error:"invalid request"}` shape.

### `PUT /api/v1/uploads/:key`

LocalFsStorage only (S3 mode: client PUTs to presigned URL; this route 404s).
Auth: same `requireAuth`; resolve key → artifact → report → org, 404
cross-org. Body = raw bytes (`await c.req.arrayBuffer()`); enforce declared
`sizeBytes` exactly (mismatch → 413 `{error:"size mismatch"}`); sha256(body)
must equal declared (mismatch → 409 `{error:"checksum mismatch"}` — don't
store bad bytes). Write via storage, `200 {ok:true}`. Idempotent: re-PUT
same bytes → 200.

### `POST /api/v1/reports/:id/finalize`

Verify every `report_artifacts` row: `storage.head` → missing → collect;
size mismatch → collect. Any missing/mismatch → `409 {error:"incomplete",
missing:[artifactIds]}`. All good → `status:"uploaded"`; if
`reports.capture_session_id` set and session status is `stopped` → set
`submitted` (already submitted/discarded → leave; TRANSITIONS unchanged).
Returns the report row.

## 4. Extension uploader

New file `apps/extension/uploader.js` (vanilla JS, dynamic-imported — not on
capture path):

```js
export async function uploadReport(report, { apiUrl, token, projectId, environmentId })
// → {reportId, shareUrl?} | throws {status, body}
```

- Maps extension `report` → envelope v2: `meta`+`device` →
  `summary{title: pageTitle||pageUrl, url, capturedAt}` + `meta{device,
  durationMs, capture}`; `events` → `events`; `rrwebEvents` (string) →
  `{kind:"replay", sha256, sizeBytes}` artifact + bytes;
  `audio.dataUrl` → `{kind:"audio"}` + decoded bytes; screenshot events with
  `detail.dataUrl` → `{kind:"screenshot"}` artifacts (bytes extracted,
  events keep reference by artifactId).
- Redaction: `import("../packages/redaction")` is NOT possible in the
  extension (vanilla JS, no bundler for packages). Phase 4 ships the
  uploader + a `redact.js` port *inside* the extension that applies the same
  default ruleset (auth headers, cookies, secret-looking params) — an
  explicit exception to "don't copy" noted in commit + provenance.md, with
  the alternative (bundling) rejected as heavier.
- POST ingest → PUT each artifact (`url` from response; no presign headers
  needed for local store) → POST finalize → return `reportId`.
- Viewer page (`viewer.html`/`viewer.js`): "Upload to server" section —
  inputs for API URL, token, project ID persisted in `chrome.storage.local`
  (`oj_upload_config`); button + inline status/error line. No popup changes.

## 5. Error handling

- PAT invalid/revoked → 401; PAT on `/api/v1/tokens/*` → 403.
- Duplicate/invalid envelope → 400 via zValidator hook.
- Upload size/checksum mismatch → 413/409, bytes discarded.
- Finalize with pending artifacts → 409 `{missing}`.
- All inserts still wrapped by the `isUniqueViolation` 23505→409 helper.
- Cross-org everywhere → 404.

## 6. Testing

`apps/api/test/` (testcontainers, real Postgres):

- `tokens.test.ts` — mint returns `oj_pat_` raw once; list hides hash;
  Bearer auth works and sets org; revoked → 401; PAT minting PAT → 403;
  cross-org DELETE → 404.
- `ingest.test.ts` — full happy path: ingest → PUT artifact(s) → finalize →
  report row with `status:"open"`, artifacts `uploaded`, session `submitted`.
  Cases: ingest bad project → 404; env from other project → 404; bad
  envelope → 400; PUT wrong bytes → 409 checksum; finalize incomplete → 409
  missing; re-finalize → 200 idempotent.
- Existing 25 tests unchanged — `requireAuth` keeps session path; helpers
  get a `createToken` helper only if needed by new tests (otherwise PATs
  minted via the route).

Extension: no Playwright in Phase 4 (per plan, e2e lands with the dashboard
in Phase 5+). `uploader.js` + `redact.js` verified by a throwaway smoke
script driving a real API via `fetch` (script deleted after; result logged
in task report).

## 7. Files

New: `packages/storage/{package.json,tsconfig.json,src/index.ts,src/local.ts,src/s3.ts}`,
`apps/api/src/routes/tokens.ts`, `apps/api/src/routes/ingest.ts`,
`apps/api/src/lib/validate.ts` extension only if needed,
`apps/extension/uploader.js`, `apps/extension/redact.js`,
`apps/api/test/tokens.test.ts`, `apps/api/test/ingest.test.ts`,
`packages/db/src/schema/domain.ts` (+`personal_access_tokens`), one
drizzle-kit migration.

Changed: `apps/api/src/app.ts` (mounts + storage param),
`apps/api/src/index.ts` (storage selection), `apps/api/src/lib/session.ts`
(Bearer path), `apps/api/test/helpers.ts` (buildApp signature),
`apps/extension/viewer.html`+`viewer.js` (upload UI), `Makefile`
(`packages/storage` in test-unit glob), `README.md`, `docs/provenance.md`
(redact.js port note + crikket reference), `docs/architecture.md`.
