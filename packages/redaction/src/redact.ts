import { createRedactionPipeline, keysPipeline } from "./pipeline";
import { DEFAULT_RULES, SENSITIVE_KEYS } from "./rules";

const defaultPipeline = createRedactionPipeline(DEFAULT_RULES);

export function redactHeaders(
  headers: Record<string, string>,
  keys: readonly string[] = SENSITIVE_KEYS,
): Record<string, string> {
  const p =
    keys === SENSITIVE_KEYS
      ? defaultPipeline
      : createRedactionPipeline(keysPipeline(keys, "header"));
  return p.redactHeaders(headers);
}

export function redactUrl(
  url: string,
  keys: readonly string[] = SENSITIVE_KEYS,
): string {
  const p =
    keys === SENSITIVE_KEYS
      ? defaultPipeline
      : createRedactionPipeline(keysPipeline(keys, "url"));
  return p.redactUrl(url);
}

export function redactBody(
  body: string,
  keys: readonly string[] = SENSITIVE_KEYS,
): string {
  const p =
    keys === SENSITIVE_KEYS
      ? defaultPipeline
      : createRedactionPipeline(keysPipeline(keys, "body"));
  return p.redactBody(body);
}
