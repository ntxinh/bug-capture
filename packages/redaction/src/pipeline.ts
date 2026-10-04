import { keyRule, MASK, type RedactionRule } from "./rules";

// URLSearchParams.toString() percent-encodes the mask's brackets; decode it back.
const MASK_ENC = encodeURIComponent(MASK);

export interface RedactionPipeline {
  redactHeaders(headers: Record<string, string>): Record<string, string>;
  redactUrl(url: string): string;
  redactBody(body: string): string;
}

function matching(
  rules: readonly RedactionRule[],
  target: RedactionRule["target"],
  key: string,
): RedactionRule | undefined {
  // reset lastIndex so global/sticky patterns behave like plain tests
  return rules.find((r) => {
    if (r.target !== target) return false;
    r.pattern.lastIndex = 0; // reset stateful /g|/y patterns
    return r.pattern.test(key);
  });
}

function redactParams(p: URLSearchParams, rules: readonly RedactionRule[]) {
  for (const k of [...p.keys()]) {
    const r = matching(rules, "url", k);
    if (!r) continue;
    if (r.action === "remove") p.delete(k);
    else p.set(k, MASK);
  }
}

function redactHash(u: URL, rules: readonly RedactionRule[]) {
  const h = u.hash;
  if (!h) return;
  // fragment is either `#k=v&k=v` or `#/route?k=v`; mask sensitive params
  const qi = h.indexOf("?");
  const qs = qi >= 0 ? h.slice(qi + 1) : h.includes("=") ? h.slice(1) : null;
  if (!qs) return;
  const p = new URLSearchParams(qs);
  const before = p.toString();
  redactParams(p, rules);
  const red = p.toString();
  if (before === red) return; // nothing redacted — don't normalize the fragment
  u.hash = qi >= 0 ? `${h.slice(0, qi + 1)}${red}` : `#${red}`;
}

function redactUrlString(url: string, rules: readonly RedactionRule[]): string {
  try {
    const u = new URL(url);
    redactParams(u.searchParams, rules);
    redactHash(u, rules);
    return u.toString().replaceAll(MASK_ENC, MASK);
  } catch {
    return url; // relative/non-parseable URL — leave for caller
  }
}

function redactJson(value: unknown, rules: readonly RedactionRule[]): unknown {
  if (Array.isArray(value)) return value.map((v) => redactJson(v, rules));
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      const r = matching(rules, "body", k);
      if (r?.action === "remove") continue;
      out[k] = r ? MASK : redactJson(v, rules);
    }
    return out;
  }
  return value;
}

function redactBodyString(
  body: string,
  rules: readonly RedactionRule[],
): string {
  const trimmed = body.trim();
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    try {
      return JSON.stringify(redactJson(JSON.parse(trimmed), rules));
    } catch {
      return body;
    }
  }
  if (trimmed.includes("=")) {
    const p = new URLSearchParams(trimmed);
    const before = p.toString();
    redactParams(p, rules);
    const after = p.toString();
    if (before !== after) return after.replaceAll(MASK_ENC, MASK);
  }
  return body;
}

export function createRedactionPipeline(
  rules: readonly RedactionRule[],
): RedactionPipeline {
  return {
    redactHeaders: (headers) => {
      const out: Record<string, string> = {};
      for (const [k, v] of Object.entries(headers)) {
        const r = matching(rules, "header", k);
        if (r?.action === "remove") continue;
        out[k] = r ? MASK : v;
      }
      return out;
    },
    redactUrl: (url) => redactUrlString(url, rules),
    redactBody: (body) => redactBodyString(body, rules),
  };
}

/** Build a pipeline from an exact key list (same semantics as SENSITIVE_KEYS). */
export function keysPipeline(
  keys: readonly string[],
  target: RedactionRule["target"],
): RedactionRule[] {
  return keys.map((k) => keyRule(k, target));
}
