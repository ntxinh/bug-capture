# bug-capture — Design Spec

**Date:** 2026-10-04
**Status:** Approved for implementation planning
**Sources:** `../openjam` @ `2642808` (v0.7.2, GPL-3.0-or-later) — capture base; `../crikket` (AGPL-3.0) — architectural reference only.

> **Canonical principle:** Copy the ideas and contracts from Crikket, not its implementation. Keep OpenJam's capture model intact. The server is an optional destination, never a dependency of the capture engine.

---

## 1. Product definition

Open-source engineering bug-context platform. The core object is a **Bug Context**:

```text
Bug Context
├── Human Context      (title, description, reproduction, comments)
├── Browser Context    (replay, screenshots, console, network)
├── Application Context (environment, version, git SHA, source maps)
├── Team Context       (project, reporter, assignee, status)
└── Agent Context      (AI manifest, relevant events, fingerprint, MCP)
```

Three operation modes, all coexisting:

| Mode | Account | Backend | Output |
|---|---|---|---|
| `OPENJAM_LOCAL` | none | none | HTML export, `.ojreport` |
| `OPENJAM_TEAM` | yes | OpenJam server | remote upload, share URL, dashboard |
| `OPENJAM_SDK` | project key | OpenJam server | embedded "report a bug" → remote |

## 2. Target architecture

```text
┌──────────────────────┐
│  OpenJam Extension   │  CDP / rrweb / console / network / errors / screenshot / audio
└──────────┬───────────┘
           │ BugReportEnvelope
     ┌─────┴──────┐
     ▼            ▼
 Local Mode   Team Mode
     │            │
 HTML export  Upload API ──► OpenJam Server
                  │          (auth, orgs, projects, reports, comments, shares, integrations)
                  │               │
                  │         PostgreSQL   R2 (artifacts)   Resend (email)
                  │               │
                  ▼          Web Dashboard
```

**Non-negotiable boundaries:**

- OpenJam extension works fully offline. Capture engine (`background.js` CDP attach/routing, `rrweb` recorder, `report-builder.js`, `renderer.js`, `viewer.js`, AI manifest) is **not rewritten**.
- Crikket is architectural reference for: auth, orgs, membership, project, report lifecycle, share links, dashboard, API, storage, SDK, self-hosting. Its source is never copied (AGPL-3.0 vs GPL-3.0 provenance risk).

## 3. Core abstractions (build these first)

### 3.1 `BugReportEnvelope` — canonical domain object

```typescript
export interface BugReportEnvelope {
  schemaVersion: number;
  report: BugReportMetadata;
  environment: EnvironmentSnapshot;
  events: TimelineEvent[];
  replay?: ReplayArtifact;
  screenshots: ScreenshotArtifact[];
  audio?: AudioArtifact;
  aiManifest: AIManifest;
  capture: CaptureMetadata;
}

interface BugReportMetadata {
  id: string;
  title?: string;
  startedAt: string;
  endedAt: string;
  source: "extension" | "sdk";
  project?: { id: string; key: string };
}
```

The envelope is canonical storage. Everything else is derived:

```text
             BugReportEnvelope
        ┌──────────┼──────────┬──────────┐
        ▼          ▼          ▼          ▼
    HTML export  .ojreport  API JSON   AI Context
    (offline)    (archive)  (upload)   (agent)
```

### 3.2 `ReportSink` — capture-to-destination decoupling

```typescript
interface ReportSink {
  submit(report: BugReportEnvelope): Promise<SubmitResult>;
}
```

Implementations: `LocalReportSink` (HTML), `FileReportSink` (`.ojreport`), `RemoteReportSink` (API). Extension calls `reportSink.submit(report)` regardless of mode.

### 3.3 `ArtifactStorage` — storage-provider decoupling

```typescript
interface ArtifactStorage {
  createUpload(...): Promise<UploadTarget>;
  getDownloadUrl(...): Promise<string>;
  delete(...): Promise<void>;
}
```

Implementations: `LocalStorage`, `SupabaseStorage`, `R2Storage`, `S3Storage`. Database stores artifact metadata only — never replay blobs in `reports`.

### 3.4 AI Context — agent-facing view

Extend OpenJam's existing AI manifest into a served endpoint (`GET /api/v1/reports/{id}/ai-context`): schema version, summary, failure index, network/console failures, environment, reproduction, artifact references. Agents get failure index + relevant event windows — never raw replay by default (`GET /reports/{id}/replay?from=` for windows).

### 3.5 `CaptureSession` — distinct from Report

```text
capture_session (id, project_id, environment_id, started_at, ended_at, status)
      │
      ▼
    report
```

Enables capture → discard, capture → report, capture → AI-analyze → report. Shared model across extension and SDK.

## 4. Repository layout

```text
bug-capture/
├── apps/
│   ├── extension/        # OpenJam subtree (GPL-3.0), imported verbatim @ 2642808
│   ├── api/              # Hono API            — deferred to Phase 3
│   └── web/              # Next.js dashboard  — deferred to Phase 5
├── packages/
│   ├── report-schema/    # BugReportEnvelope + all artifact/event types (built now)
│   ├── report-core/      # ReportSink, ArtifactStorage, CaptureSession interfaces (built now)
│   └── redaction/        # RedactionRule + RedactionPipeline + DEFAULT_RULES (built now)
│   └── (future: ai-context, storage, auth, integrations, sdk)
├── database/             # Drizzle schema + migrations — deferred
├── docs/
│   ├── architecture.md   # layering + flows
│   ├── data-model.md     # entity schema below
│   ├── provenance.md     # openjam commit, license notes
│   └── security.md       # redaction boundary, upload flow, token hashing
├── .omp/lsp.json         # LSP servers for coding agents (version 1 format)
├── mise.toml             # bun@1.3.x, node@22
├── AGENTS.md             # agent guardrails (§9)
├── README.md
├── DESIGN.md             # full product design (attached design doc, verbatim)
├── Makefile              # install/build/test/lint/format/typecheck/clean
├── .editorconfig
├── .gitignore
├── biome.json            # lint/format across JS+TS
├── package.json          # bun workspaces: apps/*, packages/*
├── tsconfig.base.json
└── LICENSE               # GPL-3.0 (inherited)
```

**Scaffold scope (this delivery):** `apps/extension` import + the three domain packages + all root files + `docs/`. No `apps/api`, `apps/web`, `database/`, `sdk` stubs — those are built in their phases.

## 5. Toolchain (decided)

| Concern | Choice | Rationale |
|---|---|---|
| Runtime/PM | Bun workspaces | crikket-aligned, `bun test` already used by extension suite |
| Node | 22 (via mise) | Next.js runtime later |
| Lint/format | Biome | single tool, covers JS+TS, extension stays vanilla JS |
| Orchestration | Makefile, no turbo | fewer moving parts; per-package scripts via `bun --filter` |
| API | Hono (`apps/api`) | public SDK/API boundary, own deploy |
| Web | Next.js (`apps/web`) | dashboard only |
| ORM | Drizzle + drizzle-kit | crikket-aligned, Better Auth's documented adapter |
| Auth | Better Auth | self-hostable, org/session plugins, no external dependency |
| DB | PostgreSQL (Supabase-hosted ok, no RLS reliance) | app-layer authorization (§7) |
| Artifacts | Cloudflare R2 (abstraction permits alternatives) | large objects, egress economics |
| Email | Resend | transactional only |
| CI | GitHub Actions | build/test/deploy + release metadata publish |

Explicitly not used: Clerk, Firebase, Firestore, Neon, Pinecone (pgvector later suffices), Supabase RLS as auth model.

## 6. Data model

```text
User ── Membership ──► Organization ──┬── Project ──► ProjectEnvironment ──► CaptureSession ──► Report
                                      └── Members                              │
                                                                               ├── ReportArtifact
                                                                               ├── ReportShare
                                                                               └── external_links (Jira/GitHub)
```

Auth tables (Better Auth: `user`, `session`, `account`, `verification`) stay **separate from domain tables**.

```sql
organizations        (id, name, slug, created_at)
organization_members (id, organization_id, user_id, role, created_at)
                     -- role: owner | admin | member | viewer
projects             (id, organization_id, name, slug, key, public_key, created_at)
project_environments (id, project_id, name, key, base_url)
project_origins      (id, project_id, origin)            -- SDK allowed origins
reports              (id, organization_id, project_id, environment_id, title, description,
                      status, priority, created_by, assigned_to, capture_mode,
                      started_at, ended_at, app_version, git_sha, created_at, updated_at)
                     -- status: open | in_progress | resolved | closed | ignored
report_artifacts     (id, report_id, type, storage_provider, storage_key,
                      content_type, size_bytes, sha256, created_at)
                     -- type: replay | screenshot | audio | video | report_bundle | attachment
report_shares        (id, report_id, token_hash, visibility, expires_at,
                      created_by, created_at, revoked_at)   -- SHA256(token), never raw
external_links       (id, report_id, provider, external_id, url)
outbox_events        (id, type, payload, created_at, processed_at)  -- later
```

Environment is a first-class entity (`project_environments`), not a report column — one project spans QA/staging/prod.

**SDK auth:** project `public_key` (`oj_pk_...`) identifies org+project; `project_origins` whitelists embed origins. No secrets in SDK.

## 7. Authorization

Policy layer, not scattered checks:

```typescript
canViewReport / canEditReport / canDeleteReport(user, report)
canManageProject(user, project)
canManageOrganization(user, organization)
```

Every query enforces `User → Org membership → Project access → Report`. No Supabase RLS (API-mediated access); authorization lives in application layer.

## 8. Remote capture flow — two-phase upload

```text
Start → Capture → Stop → Build Report → Redaction (client) → Create report
      → Upload artifacts (direct to R2 via signed URLs) → Finalize → Share URL
```

```http
POST /api/v1/reports                        → { reportId, uploads: [{artifactId, uploadUrl}] }
PUT  <signed R2 URL>                        (extension → R2 direct, bypasses API)
POST /api/v1/reports/{id}/finalize          → server verifies artifacts + checksums, marks READY
```

**Security boundary:** redaction happens client-side before upload. Server-side redaction is defense-in-depth, never the only layer.

```text
Capture → RawReport → RedactionPipeline → SafeReport → Upload
                        ├── headers / cookies / query params
                        ├── request + response bodies
                        ├── DOM / screenshots
                        └── DEFAULT_RULES: authorization, cookie, set-cookie,
                            x-api-key, password, token, secret, client_secret
```

```typescript
interface RedactionRule {
  id: string;
  target: "header" | "body" | "dom" | "url";
  pattern: RegExp;
  action: "mask" | "remove";
}
```

**Share links:** `https://host/r/oj_<token>`; DB stores `SHA256(token)` only. DB leak ≠ link leak.

## 9. Agent guardrails (AGENTS.md contract)

```text
FORBIDDEN without explicit approval:
  ✗ rewrite OpenJam capture engine (CDP, rrweb recorder, renderer)
  ✗ replace rrweb / migrate extension to a framework
  ✗ copy Crikket implementation code (reference only)
  ✗ add backend dependencies to the local capture path
  ✗ add AI features before data model stabilizes

REQUIRED:
  ✓ local mode stays fully functional offline at all times
  ✓ client-side redaction precedes any upload
  ✓ envelope is canonical — no schema drift between sinks
  ✓ provenance.md updated when upstream syncs happen
```

## 10. Downstream features (phased, not scaffolded)

| Feature | Notes |
|---|---|
| `.ojreport` format | ZIP: `manifest.json`, `report.json`, `replay.json.gz`, `screenshots/`, `audio/`, `attachments/` — portable report format |
| Source maps | per project+version+git_sha upload, private; resolves raw stacks to originals |
| Build context | `window.__OPENJAM_BUILD__ = {version, gitSha, environment}` — SDK reads it |
| Release API | `POST /api/v1/releases` from CI; reports link to release metadata |
| `@bugcapture/capture` SDK | `initOpenJam({projectKey, endpoint})` — browser-API capture (weaker than CDP, embedded UX) |
| MCP server | tools: `list_projects`, `list_reports`, `get_report`, `get_ai_context`, `get_timeline`, `get_network_failure`, `get_screenshots`, `search_reports`, `find_similar_reports` |
| Duplicate detection | Postgres FTS first, pgvector later |
| Integrations | `IssueTracker` interface (createIssue/addComment) → GitHub, Jira; `external_links` on report |
| Notifications | domain events (`ReportCreated` etc.) → NotificationService → Email/Slack/webhook; outbox when volume demands |
| Slack | incoming webhook first, native app later |

## 11. Test strategy

```text
        Extension          API            Web
        Playwright         Vitest         Playwright
              └────── Integration ──────┘
                    (Testcontainers)
```

- Keep OpenJam's existing unit + Playwright E2E suite green — that's the regression floor.
- **Golden path E2E:** user clicks Save → app 500s → extension captures → uploads → developer opens URL → timeline shows `POST /save 500` → replay works.
- **Privacy test (automated):** fixture with password input, Authorization header, cookie, API key, email, phone → assert uploaded artifacts contain no secrets.
- Extension scripts preserved under `apps/extension` (`bun test`, `playwright test`); root Makefile delegates.

## 12. Performance budget

- Default capture duration 5 min, warning at 10 min (rrweb events uncompressed in memory — known OpenJam ceiling; ring buffer/IndexedDB is roadmap).
- Max report 50 MB; response bodies capped at 100 KB (configurable).
- Replay compressed after stop.

## 13. Licensing

- `apps/extension` + repo root: GPL-3.0-or-later (inherited from OpenJam).
- Crikket (AGPL-3.0): reference only — behavior, API shapes, UX, data model studied; code not copied.
- If commercialization becomes a goal: provenance review with legal before anything ships. `docs/provenance.md` tracks upstream commits.

## 14. Roadmap

| Phase | Deliverable | Effort |
|---|---|---|
| 0 — Research | Architecture/feature/data-model docs (done — this spec + docs/) | — |
| 1 — Domain extraction | `report-schema`, `report-core`, `redaction` packages | this scaffold |
| 2 — Local regression | extension suite green inside monorepo | with scaffold |
| 3 — Backend MVP | auth, orgs, membership, projects, reports, artifacts, shares | 3–7d |
| 4 — Remote upload | extension → API → R2 → finalize | 2–4d |
| 5 — Dashboard | login, orgs, projects, reports, viewer (reuse OpenJam renderer) | 3–7d |
| 6 — SDK | `@bugcapture/capture` | 3–5d |
| 7 — Integrations | GitHub/Jira/release API/source maps/Slack | 3–7d |
| 8 — AI/MCP | ai-context endpoint, MCP server, similar bugs | after core stable |

## 15. Coding-agent strategy

Milestone-scoped agents, never "build the platform":

1. **Audit** — analyze both repos, produce ARCHITECTURE-AUDIT / FEATURE-MATRIX / DATA-FLOW / SECURITY-AUDIT / MIGRATION-PLAN (no code changes)
2. **Domain model** — implement BugReportEnvelope, no capture changes
3. **Remote sink** — RemoteReportSink, local mode untouched
4. **Backend** — orgs/projects/reports
5. **Storage** — ArtifactStorage abstraction
6. **Dashboard** — viewer reusing OpenJam renderer
7. **SDK** — `@bugcapture/capture`
8. **Integrations** — GitHub/Jira/Slack
9. **AI** — ai-context + MCP

Pin both upstreams; don't chase Crikket (moving fast — 314+ commits).
