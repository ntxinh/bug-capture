Cách này hợp lý hơn việc chọn hẳn Crikket: **OpenJam là capture/replay engine canonical; Crikket là reference implementation cho product/platform layer.**

> **Copy the ideas and contracts from Crikket, not its implementation. Keep OpenJam's capture model intact.**

OpenJam hiện có CDP capture, reduced injection mode, rrweb replay, correlated timeline, offline HTML và AI manifest; Crikket có web dashboard, Hono API, team/report/share workflow, self-hosting và capture SDK.

---

# 1. Architecture mục tiêu

Chrome Extension → Capture → Local Report → HTML

thành:

    OpenJam Chrome Extension (CDP, rrweb, console, network, errors, screenshot, audio)
        │ BugReportEnvelope
        ├─ Local Mode → HTML export
        └─ Team Mode → Upload API → OpenJam Server
                          (Auth, Organizations, Projects, Reports, Comments, Shares, Integrations)
                              │ PostgreSQL (metadata), R2 (large artifacts), Email (Resend)
                              └─ Web Dashboard

**OpenJam Extension vẫn phải hoạt động hoàn toàn offline.** Server là optional destination, không trở thành dependency của capture engine.

# 2. Đừng biến OpenJam thành Crikket clone

OpenJam giữ nguyên: background.js, src/rrweb-recorder.js, renderer.js, report-builder.js, event-kinds.js, viewer.js, CDP capture, rrweb, AI manifest, offline export.

Crikket chỉ làm reference cho: Auth, Organization, Membership, Project, Report lifecycle, Share link, Dashboard, API, Storage, SDK, Integration, Self-host.

# 3. Layering

    src/capture/   (cdp, rrweb, screenshots, audio, environment)
    src/report/    (model, manifest, normalize, redact, export)
    src/transport/ (local, remote)
    src/extension/ (popup, background, viewer, content)

# 4. Canonical domain object — BugReportEnvelope

    interface BugReportEnvelope {
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

# 5. ReportSink — abstraction chống lock-in

    interface ReportSink { submit(report: BugReportEnvelope): Promise<SubmitResult>; }

    OpenJam capture → BugReportEnvelope → LocalReportSink (HTML)
                                       → RemoteReportSink (API)
                                       → FileReportSink (.ojreport)

# 6. .ojreport format

ZIP: manifest.json, report.json, replay.json.gz, screenshots/, audio/, attachments/.
Portable bug report format — opens locally AND uploads to server.

# 7. Canonical vs derived

Canonical: BugReportEnvelope. Derived: .ojreport, HTML, API JSON, AI Context.
HTML tốt để share nhưng KHÔNG phải canonical storage format.

# 8–37. Backend design (condensed in spec §5–§10)

- Monorepo: apps/extension, apps/api (Hono), apps/web (Next.js), packages/*
- PostgreSQL + Drizzle + Better Auth (self-host, no Clerk); auth tables ≠ domain tables
- Data model: org → membership → project → environments → reports → artifacts → shares
- Two-phase upload: POST /reports → signed R2 URLs → direct upload → finalize + checksums
- Share links: SHA256(token) in DB, never raw
- Policy layer: canViewReport/canEditReport/... — không rải checks
- Redaction CLIENT-side trước upload; server-side chỉ defense-in-depth
- project public_key + project_origins cho SDK
- Source maps per project+version+git_sha (private, resolve stacks)
- window.__OPENJAM_BUILD__ = {version, gitSha, environment}
- Release API cho CI/CD publish metadata
- AI context endpoint: failure index + event windows, không raw replay
- MCP server: list/get reports, ai_context, timeline, screenshots, search, similar
- Duplicate detection: Postgres FTS → pgvector later
- IssueTracker interface → GitHub/Jira; external_links per report
- Notifications: domain events → NotificationService → Email/Slack/webhook; outbox later
- Free stack: Vercel + Supabase Postgres + R2 + Resend + GitHub Actions (+Sentry optional)
- Không Supabase RLS khi API-mediated; không Pinecone, Clerk, Firebase, Neon

# 45. Modes

OPENJAM_LOCAL (no account/backend), OPENJAM_TEAM (account+upload+share+dashboard), OPENJAM_SDK (embedded, project key).

# 46. Roadmap

Phase 0 research → 1 domain extraction → 2 local regression → 3 backend MVP → 4 remote upload → 5 dashboard → 6 SDK → 7 integrations → 8 AI/MCP.

# 49. License

OpenJam GPL-3.0-or-later, Crikket AGPL-3.0 → không copy Crikket implementation; license/provenance review trước khi commercialize.
