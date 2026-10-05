// Client-side redaction applied to a COPY of the report before upload.
// Mirrors the default-rule semantics of packages/redaction (header/url/body
// key masking) in dependency-free vanilla JS. Original code for this repo.
export const MASK = "[redacted]";

const MAX_BODY_BYTES = 256 * 1024;
const SENSITIVE = /^(authorization|proxy-authorization|cookie|set-cookie|x-api-key|password|token|access_token|refresh_token|secret|client_secret|api[-_]?key)$/i;
const HEADER_KEY = SENSITIVE;
const PARAM_KEY = SENSITIVE;
const MASK_ENC = encodeURIComponent(MASK); // URLSearchParams encodes the brackets

function maskParams(p, keyRe) {
  const before = p.toString();
  for (const k of [...p.keys()]) if (keyRe.test(k)) p.set(k, MASK);
  const after = p.toString();
  return before === after ? null : after;
}

export function redactUrl(url, keyRe = PARAM_KEY) {
  try {
    const u = new URL(url);
    const q = maskParams(u.searchParams, keyRe);
    if (q != null) u.search = "?" + q;
    const h = u.hash;
    if (h) {
      const qi = h.indexOf("?");
      const qs = qi >= 0 ? h.slice(qi + 1) : h.includes("=") ? h.slice(1) : null;
      const r = qs && maskParams(new URLSearchParams(qs), keyRe);
      if (r) u.hash = qi >= 0 ? h.slice(0, qi + 1) + r : "#" + r;
    }
    return u.toString().replaceAll(MASK_ENC, MASK);
  } catch {
    return url;
  }
}

function redactJson(v) {
  if (Array.isArray(v)) return v.map(redactJson);
  if (v && typeof v === "object") {
    const out = {};
    for (const [k, val] of Object.entries(v))
      out[k] = PARAM_KEY.test(k) ? MASK : redactJson(val);
    return out;
  }
  return v;
}

export function redactBody(body) {
  if (typeof body !== "string") return body;
  if (new TextEncoder().encode(body).byteLength > MAX_BODY_BYTES)
    return `[omitted: body exceeds ${MAX_BODY_BYTES} bytes]`;
  const t = body.trim();
  if (t.startsWith("{") || t.startsWith("[")) {
    try {
      return JSON.stringify(redactJson(JSON.parse(t)));
    } catch {
      return body;
    }
  }
  if (t.includes("=")) {
    const r = maskParams(new URLSearchParams(t), PARAM_KEY);
    if (r != null) return r.replaceAll(MASK_ENC, MASK);
  }
  return body;
}

export function redactHeaders(headers) {
  const out = {};
  for (const [k, v] of Object.entries(headers || {}))
    out[k] = HEADER_KEY.test(k) ? MASK : v;
  return out;
}

// Returns a redacted deep copy; the input report is never mutated.
export function redactReport(report) {
  const r = JSON.parse(JSON.stringify(report));
  for (const e of r.events || []) {
    const d = e && e.detail;
    if (!d) continue;
    if (typeof d.url === "string") {
      d.url = redactUrl(d.url);
      // network/error titles are "<method> <url>" (cdp.js, inject.js) — the
      // URL's params would survive detail.url masking via the title.
      if (typeof e.title === "string") {
        const i = e.title.indexOf(" ");
        if (i >= 0 && /^\S+$/.test(e.title.slice(0, i)))
          e.title = e.title.slice(0, i) + " " + redactUrl(e.title.slice(i + 1));
      }
    }
    if (d.requestHeaders) d.requestHeaders = redactHeaders(d.requestHeaders);
    if (d.responseHeaders) d.responseHeaders = redactHeaders(d.responseHeaders);
    if (d.requestBody != null) d.requestBody = redactBody(d.requestBody);
    if (d.responseBody != null) d.responseBody = redactBody(d.responseBody);
  }
  for (const k of ["pageUrl", "url", "referrer"]) {
    const obj = k === "pageUrl" ? r.meta : r.device;
    if (obj && typeof obj[k] === "string") obj[k] = redactUrl(obj[k]);
  }
  return r;
}
