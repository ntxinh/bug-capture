# Security

Spec §8.

## Redaction boundary

    Capture → RawReport → RedactionPipeline (CLIENT) → SafeReport → Upload
    Server-side redaction = defense-in-depth only.

`@bugcapture/redaction` masks: authorization, proxy-authorization, cookie,
set-cookie, x-api-key, password, token, access_token, refresh_token, secret,
client_secret, api_key, apikey — across headers, URL query params, JSON and
urlencoded bodies. DOM/screenshot redaction rules exist in the model
(`target: "dom"`) pending Phase 4 wiring.

## Upload flow (Phase 4)

    POST /api/v1/reports           → reportId + signed artifact URLs
    PUT  <signed R2 URL>           → direct to storage, bypasses API
    POST /api/v1/reports/{id}/finalize → verify checksums, mark READY

## Share links

Token shown once in URL (`/r/oj_…`); DB stores SHA-256(token) only.
Revocable (`revoked_at`), expirable (`expires_at`).

## SDK auth

Project `public_key` (`oj_pk_…`) + `project_origins` origin whitelist.
No secrets ship to browsers.

## Privacy tests

Automated fixture (password input, Authorization header, cookie, API key,
email, phone) asserting uploaded artifacts contain no secrets — required
before Phase 4 ships.
