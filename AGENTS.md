# AGENTS.md — rules for coding agents working in this repo

## Hard boundaries

1. **Do not rewrite the capture engine.** `apps/extension` (CDP attach,
   rrweb recorder, report-builder, renderer, viewer) is canonical. Changes
   inside it need explicit approval and must keep `make test` green.
2. **Crikket is reference, not source.** Its license (AGPL-3.0) is
   incompatible for copying into this GPL-3.0 tree. Study its behavior,
   API shapes and data model; write original code. Record what you
   referenced in commit messages.
3. **Offline is invariant.** Local capture → HTML export must work with
   zero network. Nothing in `packages/` may add a runtime dependency to
   the extension's capture path.
4. **Canonical model:** `BugReportEnvelope` (packages/report-schema) is the
   single report shape. New outputs are new `ReportSink` implementations
   (packages/report-core), never new schemas.
5. **Redaction precedes upload.** Any remote path must pass the envelope
   through `@bugcapture/redaction` client-side before transmission.

## Conventions

- Bun workspaces, `bun test`, Biome (`make lint`), Makefile targets — no turbo.
- TypeScript only inside `packages/`; the extension stays vanilla JS.
- New package? Ask first — the package list is deliberately short.
- Update `docs/provenance.md` when syncing from an upstream repo.

## Current phase

Phase 1–2 done (scaffold + domain extraction + extension regression).
Next: Phase 3 backend MVP (Hono API in `apps/api`, Drizzle, Better Auth)
— do NOT scaffold it without an approved plan.
