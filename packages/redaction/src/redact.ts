import { MASK, SENSITIVE_KEYS } from "./rules";

// URLSearchParams.toString() percent-encodes the mask's brackets; decode it back.
const MASK_ENC = encodeURIComponent(MASK);

function sensitiveSet(keys: readonly string[] = SENSITIVE_KEYS): Set<string> {
  return new Set(keys.map((k) => k.toLowerCase()));
}

export function redactHeaders(
  headers: Record<string, string>,
  keys: readonly string[] = SENSITIVE_KEYS,
): Record<string, string> {
  const sens = sensitiveSet(keys);
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) {
    out[k] = sens.has(k.toLowerCase()) ? MASK : v;
  }
  return out;
}

export function redactUrl(
  url: string,
  keys: readonly string[] = SENSITIVE_KEYS,
): string {
  const sens = sensitiveSet(keys);
  try {
    const u = new URL(url);
    for (const k of [...u.searchParams.keys()]) {
      if (sens.has(k.toLowerCase())) u.searchParams.set(k, MASK);
    }
    return u.toString().replaceAll(MASK_ENC, MASK);
  } catch {
    return url; // relative/non-parseable URL — leave for caller
  }
}

export function redactBody(
  body: string,
  keys: readonly string[] = SENSITIVE_KEYS,
): string {
  const sens = sensitiveSet(keys);
  const trimmed = body.trim();
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    try {
      return JSON.stringify(redactJson(JSON.parse(trimmed), sens));
    } catch {
      return body;
    }
  }
  if (trimmed.includes("=")) {
    try {
      const p = new URLSearchParams(trimmed);
      let changed = false;
      for (const k of [...p.keys()]) {
        if (sens.has(k.toLowerCase())) {
          p.set(k, MASK);
          changed = true;
        }
      }
      if (changed) return p.toString().replaceAll(MASK_ENC, MASK);
    } catch {
      /* fall through */
    }
  }
  return body;
}

function redactJson(value: unknown, sens: Set<string>): unknown {
  if (Array.isArray(value)) return value.map((v) => redactJson(v, sens));
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] = sens.has(k.toLowerCase()) ? MASK : redactJson(v, sens);
    }
    return out;
  }
  return value;
}
