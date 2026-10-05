import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { getKey, sealSecret, unsealSecret } from "../src/lib/crypto";

const KEY = "a".repeat(64);
const KEY2 = "b".repeat(64);

describe("crypto", () => {
  let saved: string | undefined;
  beforeEach(() => {
    saved = process.env.INTEGRATIONS_KEY;
    process.env.INTEGRATIONS_KEY = KEY;
  });
  afterEach(() => {
    if (saved === undefined) delete process.env.INTEGRATIONS_KEY;
    else process.env.INTEGRATIONS_KEY = saved;
  });

  it("round-trips a secret", () => {
    const packed = sealSecret("ghp_supersecret-token");
    expect(packed).not.toContain("ghp_supersecret");
    expect(unsealSecret(packed)).toBe("ghp_supersecret-token");
  });

  it("throws with the wrong key", () => {
    const packed = sealSecret("secret");
    expect(() => unsealSecret(packed, KEY2)).toThrow();
  });

  it("throws on a tampered ciphertext", () => {
    const [iv, tag, ct] = sealSecret("secret").split(".");
    const tampered = `${iv}.${tag}.${ct.slice(0, -2)}${ct.endsWith("0") ? "1" : "0"}`;
    expect(() => unsealSecret(tampered)).toThrow();
  });

  it("throws when INTEGRATIONS_KEY is missing", () => {
    delete process.env.INTEGRATIONS_KEY;
    expect(() => getKey()).toThrow();
    expect(() => sealSecret("secret")).toThrow();
  });

  it("throws when INTEGRATIONS_KEY is not 64 hex", () => {
    process.env.INTEGRATIONS_KEY = "zzzz";
    expect(() => getKey()).toThrow();
  });
});
