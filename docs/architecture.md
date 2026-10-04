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
