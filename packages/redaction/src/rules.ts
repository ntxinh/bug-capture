export type RedactionTarget = "header" | "body" | "dom" | "url";
export type RedactionAction = "mask" | "remove";

export interface RedactionRule {
  id: string;
  target: RedactionTarget;
  pattern: RegExp;
  action: RedactionAction;
}

export const MASK = "[redacted]";

/** Header names / query params / body fields that always get masked.
 *  Matched case-insensitively and as exact keys. */
export const SENSITIVE_KEYS = [
  "authorization",
  "proxy-authorization",
  "cookie",
  "set-cookie",
  "x-api-key",
  "password",
  "token",
  "access_token",
  "refresh_token",
  "secret",
  "client_secret",
  "api_key",
  "apikey",
] as const;

/** Exact-match, case-insensitive key rule — building block for key lists. */
export function keyRule(key: string, target: RedactionTarget): RedactionRule {
  return {
    id: `${target}:${key}`,
    target,
    pattern: new RegExp(`^${key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`, "i"),
    action: "mask",
  };
}

export const DEFAULT_RULES: RedactionRule[] = SENSITIVE_KEYS.flatMap((k) => [
  keyRule(k, "header"),
  keyRule(k, "url"),
  keyRule(k, "body"),
]);
