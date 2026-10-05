# bug-capture

Open-source engineering bug-context platform. A Chrome extension captures
console, network, errors, screenshots, rrweb replay and audio on one timeline;
a canonical `BugReportEnvelope` routes the result to a local HTML export, a
portable `.ojreport` archive, or a team server with dashboard, shares and
integrations.

Built on [OpenJam](https://github.com/SaintPepsi/openjam)'s capture engine
(GPL-3.0, imported at `2642808`) with platform concepts referenced from
[Crikket](https://github.com/redpangilinan/crikket). See `docs/provenance.md`.

## Modes

| Mode | Account | Backend | Output |
|---|---|---|---|
| local | none | none | HTML, `.ojreport` |
| team | yes | OpenJam server | upload, share URL, dashboard |
| sdk | project key | OpenJam server | embedded capture → upload |

The extension works fully offline; the server is an optional destination.

## Layout

    apps/extension      Chrome MV3 extension (OpenJam capture engine, untouched)
    packages/           @bugcapture/* domain packages (schema, core contracts, redaction)
    docs/               architecture, data model, security, provenance

## Develop

    mise install        # bun + node
    make install        # bun install (workspaces)
    make test           # extension build + unit tests (no containers)
    make test-e2e       # playwright extension e2e (needs browsers)
    make lint           # biome check


## Backend (Phase 3)

    make db-up          # postgres:16 via podman/docker compose
    make db-migrate     # apply drizzle migrations
    make dev-api        # hono api on :3000  (/api/auth/*, /api/v1/*)
    make test-api       # api + db tests — needs podman socket + testcontainers env from .env.example


## Remote upload (Phase 4)

Mint a PAT via `POST /api/v1/tokens` under session auth (`{label}` → raw
`oj_pat_…` shown once), then set the viewer's upload config (`apiUrl`,
`token`, `projectId` — persisted to `chrome.storage.local`). Upload is
two-phase: `POST /api/v1/reports/ingest` → `PUT` each artifact's bytes →
`POST /api/v1/reports/:id/finalize`. Artifacts land on local disk
(`ARTIFACT_DIR`) or S3 via presigned URLs (`S3_*` env).

## Dashboard (Phase 5)

`make dev-api` serves the SPA at `http://localhost:3000/app` — sign up →
create org → create project → mint a PAT (`POST /api/v1/tokens`). Set that
PAT in the extension viewer's upload config and upload; open the report at
`/app/report.html?id=…`. `/app` uses the session cookie; PAT `Bearer` is
for non-browser clients only.

## Site SDK (Phase 6)

`@bugcapture/capture` (`packages/capture-sdk`) embeds capture on any site —
rrweb replay + console/network/error recording, no extension needed.

```js
import { initOpenJam } from "@bugcapture/capture";

const oj = initOpenJam({ projectKey: "oj_pk_…", apiUrl: "https://bugs.example.com" });
await oj.submit({ title: "Checkout is broken", description: "…" }); // → { reportId }
```

No bundler? Build once and serve the file — any host works since the SDK only
needs an ES-module import:

    bun build packages/capture-sdk/src/index.ts --format esm --target browser --outfile capture-sdk.js

    <script type="module">
      import { initOpenJam } from "/capture-sdk.js";
      window.oj = initOpenJam({ projectKey, apiUrl });
    </script>

`initOpenJam` starts recording immediately; `submit()` builds the envelope,
then `POST /api/v1/capture/ingest` → `PUT` each artifact → `POST
/api/v1/capture/reports/:id/finalize`, all authenticated by `projectKey`
(`x-openjam-key` header) — `projectId` resolves server-side from the key.

Setup: the project's `publicKey` (`oj_pk_…`) comes from `POST /api/v1/projects`
(or the `projects` table). To restrict which sites may submit, add allowed
origins via `POST /api/v1/projects/:id/origins` (`{origin:
"https://app.example.com"}` — trailing slashes ignored). Zero configured
origins allows any origin — fine for dev, lock it down before exposing
publicly. `oj.discard()` stops recording without submitting.

## Integrations (Phase 7)

Per-project integrations live under `POST/PATCH/DELETE
/api/v1/projects/:id/integrations` — `github` (link reports to upstream
issues via `POST /api/v1/reports/:id/issues`), `slack`, and `webhook`
(outbound notifications). Secrets in `config` (`token`, `url`) are
AES-256-GCM encrypted at rest — set `INTEGRATIONS_KEY` (`openssl rand -hex
32`) before writing any config with a secret field or the API 503s; reads
mask them as `"•••"`.

Report events (`report.created` on ingest, `report.resolved` on status→
resolved, `issue.linked`) are written to `report_outbox_events` inside the
same transaction as the change and delivered by a 15s-interval worker
(`OUTBOX_DISABLED=1` to skip). Slack gets `{text:"🐞 <title> — <url>"}`;
webhooks get `{type, report:{id,title,status,url}, payload}`. Failed
deliveries retry with 60s×attempts backoff and are marked `failed` after 6
attempts.

## AI Context + MCP (Phase 8)

`GET /api/v1/reports/:id/ai-context` returns an AI-oriented failure index
built from the envelope — reproduction steps (events before the first
error), failures with stacks, network summary, environment, artifact
links. If the project has a release with uploaded source maps, stacks are
symbolicated best-effort (`sourceMapsResolved` true only when ≥1 frame
resolved; missing maps never error).

Releases and source maps:

- `POST /api/v1/releases` — `{projectId, version, environment, commitSha?}` (member write)
- `GET /api/v1/releases` — list the org's releases (`?projectId=` to filter)
- `PUT /api/v1/releases/:id/sourcemaps/:filename` — upload a map (≤5 MiB, optional `x-sha256` verified)
- `GET /api/v1/releases/:id/sourcemaps/:filename` — download

`@bugcapture/mcp` (`packages/mcp`) is a stdio MCP server exposing
`openjam_list_reports`, `openjam_get_report`, `openjam_get_ai_context` and
`openjam_get_replay` against a running API:

    OPENJAM_URL=http://localhost:3000 OPENJAM_TOKEN=oj_pat_… bun packages/mcp/src/index.ts

`OPENJAM_TOKEN` is a PAT (`POST /api/v1/tokens`). Wire it into your MCP
client's stdio config as the command above.


## Docs

- `DESIGN.md` — product design (working spec)
- `docs/superpowers/specs/2026-10-04-bug-capture-design.md` — normalized spec
- `docs/architecture.md`, `docs/data-model.md`, `docs/security.md`, `docs/provenance.md`
- `AGENTS.md` — guardrails for coding agents

## License

GPL-3.0-or-later (inherited from OpenJam). See `LICENSE`.
