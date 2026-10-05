import { sealSecret, unsealSecret } from "./crypto";

const SECRET_KEYS: Record<string, true> = { token: true, url: true };

export function sealConfig(cfg: Record<string, unknown>) {
  const out = { ...cfg };
  for (const k of Object.keys(out)) {
    if (SECRET_KEYS[k] && typeof out[k] === "string") {
      out[k] = sealSecret(out[k] as string); // getKey() throws if unconfigured
    }
  }
  return out;
}

export function unsealConfig(cfg: Record<string, unknown>) {
  const out = { ...cfg };
  for (const k of Object.keys(out)) {
    if (SECRET_KEYS[k] && typeof out[k] === "string") {
      out[k] = unsealSecret(out[k] as string); // getKey() throws if unconfigured
    }
  }
  return out;
}

export function maskConfig(cfg: Record<string, unknown>) {
  const out = { ...cfg };
  for (const k of Object.keys(out)) {
    if (SECRET_KEYS[k]) out[k] = "•••";
  }
  return out;
}
