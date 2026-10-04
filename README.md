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
    make test           # extension build + unit tests + package tests
    make test-e2e       # playwright extension e2e (needs browsers)
    make lint           # biome check

## Docs

- `DESIGN.md` — product design (working spec)
- `docs/superpowers/specs/2026-10-04-bug-capture-design.md` — normalized spec
- `docs/architecture.md`, `docs/data-model.md`, `docs/security.md`, `docs/provenance.md`
- `AGENTS.md` — guardrails for coding agents

## License

GPL-3.0-or-later (inherited from OpenJam). See `LICENSE`.
