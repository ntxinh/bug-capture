import { describe, expect, it } from "bun:test";
import {
  createRedactionPipeline,
  DEFAULT_RULES,
  MASK,
  type RedactionRule,
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

  it("matches custom keys exactly — a.b does not mask axb", () => {
    const out = redactHeaders({ axb: "1", "a.b": "2" }, ["a.b"]);
    expect(out.axb).toBe("1");
    expect(out["a.b"]).toBe(MASK);
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

  it("masks sensitive params in the fragment", () => {
    const out = redactUrl("https://app/cb#access_token=xyz&state=1");
    expect(out).toContain(`access_token=${MASK}`);
    expect(out).toContain("state=1");
  });

  it("masks params after ? inside a hash route", () => {
    const out = redactUrl("https://app/cb#/route?token=t&step=2");
    expect(out).toContain(`token=${MASK}`);
    expect(out).toContain("step=2");
  });

  it("leaves a param-less fragment untouched", () => {
    const u = "https://app/cb#section-2";
    expect(redactUrl(u)).toBe(u);
  });

  it("leaves non-redacted fragments byte-identical", () => {
    for (const u of ["https://app/cb#section-2", "https://app/cb#a?b"]) {
      expect(redactUrl(u)).toBe(u);
    }
  });

  it("keeps non-sensitive fragment params", () => {
    const out = redactUrl("https://app/cb#access_token=x&ok=1");
    expect(out).toContain(`access_token=${MASK}`);
    expect(out).toContain("ok=1");
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

describe("createRedactionPipeline", () => {
  it("masks a header matched by a custom rule", () => {
    const p = createRedactionPipeline([
      {
        id: "header:x-tenant",
        target: "header",
        pattern: /^x-tenant$/i,
        action: "mask",
      },
    ]);
    const out = p.redactHeaders({ "X-Tenant": "t1", Host: "h" });
    expect(out["X-Tenant"]).toBe(MASK);
    expect(out.Host).toBe("h");
  });

  it("removes fields when action is remove", () => {
    const rule: RedactionRule = {
      id: "x",
      target: "header",
      pattern: /^x-tenant$/i,
      action: "remove",
    };
    const p = createRedactionPipeline([rule]);
    expect(p.redactHeaders({ "X-Tenant": "t", Host: "h" })).toEqual({
      Host: "h",
    });
  });

  it("DEFAULT_RULES pipeline matches the standalone functions", () => {
    const p = createRedactionPipeline(DEFAULT_RULES);
    const headers = {
      Authorization: "Bearer abc",
      Cookie: "sid=1",
      "Content-Type": "application/json",
    };
    const url = "https://x.test/p?token=t1&page=2&password=pw";
    const json = JSON.stringify({ user: "a", password: "p", token: "t" });
    const form = "user=a&secret=s&client_secret=cs";
    expect(p.redactHeaders(headers)).toEqual(redactHeaders(headers));
    expect(p.redactUrl(url)).toBe(redactUrl(url));
    expect(p.redactBody(json)).toBe(redactBody(json));
    expect(p.redactBody(form)).toBe(redactBody(form));
    expect(p.redactBody("<xml>a</xml>")).toBe("<xml>a</xml>");
  });
});
