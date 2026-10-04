import { describe, expect, it } from "bun:test";
import {
  DEFAULT_RULES,
  MASK,
  redactBody,
  redactHeaders,
  redactUrl,
  SENSITIVE_KEYS,
} from "../src/index";

describe("redactHeaders", () => {
  it("masks every sensitive header", () => {
    const out = redactHeaders({
      Authorization: "Bearer abc",
      Cookie: "sid=1",
      "X-Api-Key": "k",
      "Content-Type": "application/json",
    });
    expect(out.Authorization).toBe(MASK);
    expect(out.Cookie).toBe(MASK);
    expect(out["X-Api-Key"]).toBe(MASK);
    expect(out["Content-Type"]).toBe("application/json");
  });

  it("is case-insensitive", () => {
    const out = redactHeaders({ authorization: "Bearer abc" });
    expect(out.authorization).toBe(MASK);
  });
});

describe("redactUrl", () => {
  it("masks sensitive query params, keeps others", () => {
    const out = redactUrl("https://x.test/p?token=t1&page=2&password=pw");
    expect(out).toContain(`token=${MASK}`);
    expect(out).toContain("page=2");
    expect(out).toContain(`password=${MASK}`);
  });

  it("leaves clean urls untouched", () => {
    const u = "https://x.test/p?page=2";
    expect(redactUrl(u)).toBe(u);
  });
});

describe("redactBody", () => {
  it("masks JSON fields", () => {
    const out = redactBody(
      JSON.stringify({ user: "a", password: "p", token: "t" }),
    );
    const parsed = JSON.parse(out);
    expect(parsed.user).toBe("a");
    expect(parsed.password).toBe(MASK);
    expect(parsed.token).toBe(MASK);
  });

  it("masks urlencoded fields", () => {
    const out = redactBody("user=a&secret=s&client_secret=cs");
    expect(out).toContain("user=a");
    expect(out).toContain(`secret=${MASK}`);
    expect(out).toContain(`client_secret=${MASK}`);
  });

  it("returns non-parseable bodies unchanged", () => {
    expect(redactBody("<xml>a</xml>")).toBe("<xml>a</xml>");
  });
});

describe("DEFAULT_RULES", () => {
  it("covers every sensitive key in every target", () => {
    const keyedTargets = new Set(DEFAULT_RULES.map((r) => r.target));
    for (const t of ["header", "url", "body"] as const) {
      expect(keyedTargets.has(t)).toBe(true);
    }
    for (const k of SENSITIVE_KEYS) {
      expect(DEFAULT_RULES.some((r) => r.id.includes(k))).toBe(true);
    }
  });
});
