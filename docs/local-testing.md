# Local testing guide

Run the whole stack on localhost: api + dashboard, capture SDK, browser
extension, MCP server.

## 1. Boot the stack

```bash
# db
make db-up                                  # postgres:16 on :5432
make db-migrate                             # runs drizzle migrations

# api (one terminal)
cd apps/api
DATABASE_URL=postgres://bugcapture:dev@localhost:5432/bugcapture \
BETTER_AUTH_SECRET=dev-only-secret-change-me \
BETTER_AUTH_URL=http://localhost:3000 \
INTEGRATIONS_KEY=$(openssl rand -hex 32) \
bun run dev                                 # → http://localhost:3000
```

`INTEGRATIONS_KEY` is only needed if you write integrations with secrets
(slack/webhook `url`, github `token`) — without it those POSTs return 503;
non-secret writes (email provider, `enabled` toggles) still work.
`RATE_LIMIT_DISABLED=1` if you're going to hammer `/capture/*` for testing.

## 2. Dashboard + first project

Open `http://localhost:3000/app/` → sign in (any email+password auto-signs-up)
→ org is auto-created → create a project → copy the `publicKey` (`oj_pk_…`).

Under a project's reports view is the **Integrations** section — try the
`slack` provider with `{"url":"https://hooks.slack.com/services/T/B/X"}`;
it lists, toggles, deletes, and stores sealed.

## 3. Capture a real report (SDK — fastest)

```bash
mkdir /tmp/ojdemo && cd /tmp/ojdemo && bun init -y
echo '{"dependencies":{"@bugcapture/capture":"file:/home/exodia/GitRepos/MyGits/bug-capture/packages/capture-sdk"}}' > package.json
bun install
cat > demo.js <<'EOF'
import { initBugCapture } from "@bugcapture/capture";
initBugCapture({ projectKey: "oj_pk_YOUR_KEY", endpoint: "http://localhost:3000" });
console.log("hello"); console.error(new Error("boom"));
fetch("https://jsonplaceholder.typicode.com/posts/1").catch(() => {});
await new Promise(r => setTimeout(r, 1500));
EOF
bun demo.js
```

Console/error/fetch events are captured; the report lands under the project
in the dashboard.

## 4. Extension path (full fidelity: replay + audio + screenshots)

```bash
cd apps/extension && bun run build   # builds dist/ + vendor/rrweb
# chrome://extensions → Load unpacked → apps/extension
# open any page, click the toolbar icon → capture → submit → "OpenJam" server
#   URL: http://localhost:3000   Public key: oj_pk_...
# report appears in dashboard; replay/audio/screenshots on the report page
```

## 5. ai-context + MCP

```bash
REPORT=<id from dashboard>
curl -b cookies.txt "http://localhost:3000/api/v1/reports/$REPORT/ai-context" \
  | python3 -m json.tool

# MCP in Claude Code / Cursor config:
{
  "mcpServers": {
    "openjam": {
      "command": "bun",
      "args": ["/absolute/path/to/bug-capture/packages/mcp/src/index.ts"],
      "env": {
        "OPENJAM_URL": "http://localhost:3000",
        "OPENJAM_TOKEN": "oj_pat_..."
      }
    }
  }
}
```

## 6. Integrations live-fire (optional)

- **GitHub:** dashboard → add `github` provider
  `{"repo":"owner/name","token":"ghp_..."}` →
  `POST /api/v1/reports/:id/issues` → issue created + `external_links` row.
- **Slack/webhook/email:** configured `url`/`from,to` fire on
  `report.created` via the outbox worker (~15s tick; `OUTBOX_DISABLED=1`
  disables the worker).

## Gotchas

- `BETTER_AUTH_URL` must match the origin you browse to — cookie+origin
  checks are strict (`MISSING_OR_NULL_ORIGIN` / `INVALID_ORIGIN` otherwise).
- `bun test` suites that boot postgres need
  `DOCKER_HOST=unix:///run/user/$UID/podman/podman.sock` on podman boxes.
- `.env` is not auto-loaded — prefix vars inline or `export` them.
