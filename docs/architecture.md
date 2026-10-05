# Architecture

Spec: `docs/superpowers/specs/2026-10-04-bug-capture-design.md` (§2 target
diagram, §3 core abstractions, §8 remote flow).

## Logical layers

    capture/     CDP, rrweb, screenshots, audio, environment   (apps/extension)
    report/      model, manifest, normalize, redact, export    (packages/*)
    transport/   local sink, remote sink                       (packages/report-core)
    extension/   popup, background, viewer, content            (apps/extension)

## Canonical object

`BugReportEnvelope` — everything derives from it:

    Envelope → HTML export (offline) | .ojreport (archive) | API JSON | AI Context

## Boundaries

- Extension imports nothing from `packages/` (Phase 1 constraint; revisit at Phase 4 sink wiring).
- `packages/report-schema` has zero dependencies — consumable everywhere.
- `packages/redaction` is pure functions — runs in extension background AND server.
- Backend (Phase 3+): Hono API → Drizzle → Postgres; artifacts → R2 via
  `ArtifactStorage`; auth → Better Auth (auth tables separate from domain).
- `apps/api` (Hono) → `packages/db` (Drizzle→Postgres); auth tables owned by
  Better Auth; policy layer enforces org scope, 404-not-403 for cross-org.
- `@bugcapture/storage` `ArtifactStorage`: local fs (`ARTIFACT_DIR`) or S3
  presign (`S3_*`); PAT `Bearer` auth in `requireAuth`; uploads two-phase —
  ingest → `PUT` artifact bytes → finalize.
- Static mounts on the API: `/app` → `apps/web` SPA (session cookie),
  `/ext` → `apps/extension` statics (`dist/rrweb-replay.*` for the report
  viewer). PAT `Bearer` is for non-browser clients only.
- `@bugcapture/capture` (`packages/capture-sdk`) is the embeddable site SDK —
  rrweb + console/network/error recorder → `initOpenJam().submit()` → public
  `/api/v1/capture/*` routes (ingest / `PUT` uploads / finalize). Auth is the
  project's `public_key` in `x-openjam-key` + per-project `project_origins`
  CORS/origin allowlist (zero rows → any origin); `projectId` resolves
  server-side from the key, never the body.
- Integrations (Phase 7): per-project `project_integrations` rows (github /
  slack / webhook); secrets AES-256-GCM in `config` under `INTEGRATIONS_KEY`,
  masked on read. Report lifecycle events go through a transactional outbox
  (`report_outbox_events`, emitted in the same tx as the change) drained by an
  interval worker — `FOR UPDATE SKIP LOCKED`, exponential-minute backoff,
  `failed` after 6 attempts.
