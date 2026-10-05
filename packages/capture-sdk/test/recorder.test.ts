import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { OjEvent } from "../src/envelope";
import { Recorder, type RrwebRecordFn } from "../src/recorder";

type Listener = (e: Record<string, unknown>) => void;

const listeners: Record<string, Listener[]> = {};
const stubRecord: RrwebRecordFn = ({ emit }) => {
  emit({ type: 4, data: { href: "https://app.dev/" } });
  return () => {};
};

function installDomStubs() {
  const g = globalThis as Record<string, unknown>;
  g.window = {
    innerWidth: 1024,
    innerHeight: 768,
    addEventListener: (type: string, cb: Listener) => {
      listeners[type] = [...(listeners[type] ?? []), cb];
    },
    removeEventListener: (type: string, cb: Listener) => {
      listeners[type] = (listeners[type] ?? []).filter((l) => l !== cb);
    },
  };
  g.document = { title: "Doc Title", referrer: "https://ref.dev/" };
  g.location = { href: "https://app.dev/dashboard?token=secret1" };
  g.navigator = { userAgent: "UA/1.0" };
}

const saved: Record<string, unknown> = {};
beforeEach(() => {
  for (const k of ["window", "document", "location", "navigator"])
    saved[k] = (globalThis as Record<string, unknown>)[k];
  installDomStubs();
});
afterEach(() => {
  for (const k of ["window", "document", "location", "navigator"]) {
    const g = globalThis as Record<string, unknown>;
    if (saved[k] === undefined) delete g[k];
    else g[k] = saved[k];
  }
  for (const k of Object.keys(listeners)) delete listeners[k];
});

const kind = (events: OjEvent[], k: string) =>
  events.filter((e) => e.kind === k);

describe("Recorder", () => {
  test("start pushes meta/page event with pageMeta fields", () => {
    const rec = new Recorder({}, stubRecord);
    rec.start();
    const [meta] = kind(rec.events, "meta");
    expect(meta.title).toBe("page");
    expect(meta.detail).toMatchObject({
      url: "https://app.dev/dashboard?token=secret1",
      title: "Doc Title",
      userAgent: "UA/1.0",
      viewport: "1024x768",
    });
    rec.stop();
  });

  test("recordFn drives replay buffer; stop returns buffers", () => {
    let emitted = false;
    const rec = new Recorder({}, ({ emit }) => {
      emit({ t: 1 });
      emitted = true;
    });
    rec.start();
    const { replay } = rec.stop();
    expect(emitted).toBe(true);
    expect(replay).toEqual([{ t: 1 }]);
  });

  test("console patch pushes renderer-shaped event and preserves passthrough", () => {
    let calledWith: unknown[] | undefined;
    const orig = console.error;
    console.error = (...a: unknown[]) => {
      calledWith = a;
    };
    const rec = new Recorder({}, stubRecord);
    rec.start();
    console.error("boom", { a: 1 });
    const [ev] = kind(rec.events, "console");
    // renderer.js reads ev.level for the row class and detail.message for the body
    expect(ev.level).toBe("error");
    expect(ev.title).toBe('["boom",{"a":1}]');
    expect(ev.detail.level).toBe("error");
    expect(ev.detail.message).toBe('["boom",{"a":1}]');
    expect(ev.detail.stack).toEqual([]);
    expect(calledWith).toEqual(["boom", { a: 1 }]);
    rec.stop();
    expect(console.error).not.toBe(orig); // restores the spy, not the original
    console.error = orig;
  });

  test("console.warn maps to extension 'warning' level", () => {
    const rec = new Recorder({}, stubRecord);
    rec.start();
    console.warn("careful");
    const [ev] = kind(rec.events, "console");
    expect(ev.level).toBe("warning");
    rec.stop();
  });

  test("fetch wrap: passthrough + redacted network event", async () => {
    const real = globalThis.fetch;
    let seen: { url: string; init: unknown } | undefined;
    const spy = (input: RequestInfo | URL, init?: RequestInit) => {
      seen = { url: String(input), init };
      return Promise.resolve(
        new Response('{"ok":true}', {
          status: 201,
          headers: {
            "content-type": "application/json",
            "set-cookie": "sid=1",
          },
        }),
      );
    };
    globalThis.fetch = spy as typeof fetch;
    const rec = new Recorder({}, stubRecord);
    rec.start();
    const res = await fetch("https://api.dev/x?token=tok123", {
      method: "POST",
      headers: {
        authorization: "Bearer s3cret",
        "content-type": "application/json",
      },
      body: '{"a":1}',
    });
    expect(res.status).toBe(201);
    expect(await res.text()).toBe('{"ok":true}'); // body still readable
    expect(seen?.url).toBe("https://api.dev/x?token=tok123"); // real URL onward
    const [ev] = kind(rec.events, "network");
    expect(ev.title).toBe("POST https://api.dev/x?token=[redacted]");
    expect(ev.detail).toMatchObject({
      method: "POST",
      url: "https://api.dev/x?token=[redacted]",
      status: 201,
    });
    // responseBody lands after the response resolves (async clone capture) —
    // yield event-loop turns until the clone's text() settles; bounded, no sleeps.
    const turn = () => {
      const { promise, resolve } = Promise.withResolvers<void>();
      setImmediate(resolve);
      return promise;
    };
    for (let i = 0; i < 20 && ev.detail.responseBody === undefined; i++)
      await turn();
    expect(ev.detail.responseBody).toBe('{"ok":true}');
    const reqH = ev.detail.requestHeaders as Record<string, string>;
    expect(reqH.authorization).toBe("[redacted]");
    const resH = ev.detail.responseHeaders as Record<string, string>;
    expect(resH["set-cookie"]).toBe("[redacted]");
    expect(typeof ev.detail.durationMs).toBe("number");
    rec.stop();
    expect(globalThis.fetch).toBe(spy); // restores what was live at start()
    globalThis.fetch = real;
  });

  test("fetch wrap: non-textual response skips body capture", async () => {
    globalThis.fetch = (() =>
      Promise.resolve(
        new Response(new Uint8Array([1, 2, 3]), {
          headers: { "content-type": "application/octet-stream" },
        }),
      )) as typeof fetch;
    const rec = new Recorder({}, stubRecord);
    rec.start();
    await fetch("https://api.dev/blob");
    const [ev] = kind(rec.events, "network");
    expect(ev.detail.responseBody).toBeUndefined();
    rec.stop();
  });

  test("fetch wrap: rejection records error detail and rethrows", async () => {
    globalThis.fetch = (() =>
      Promise.reject(new Error("conn refused"))) as typeof fetch;
    const rec = new Recorder({}, stubRecord);
    rec.start();
    await expect(fetch("https://api.dev/down")).rejects.toThrow("conn refused");
    const [ev] = kind(rec.events, "network");
    expect(ev.detail.error).toBe("conn refused");
    rec.stop();
  });

  test("fetch wrap: streaming response resolves without awaiting body", async () => {
    // SSE-style response whose body never ends — the wrap must return the
    // response at header-arrival, not after reading the body.
    globalThis.fetch = (() =>
      Promise.resolve(
        new Response(
          new ReadableStream({ start: () => {} }), // never enqueues, never closes
          { status: 200, headers: { "content-type": "text/event-stream" } },
        ),
      )) as typeof fetch;
    const rec = new Recorder({}, stubRecord);
    rec.start();
    const res = await fetch("https://api.dev/stream"); // hangs forever pre-fix
    expect(res.status).toBe(200);
    const [ev] = kind(rec.events, "network"); // event pushed at header-arrival
    expect(ev.detail.status).toBe(200);
    rec.stop();
    // the clone's dangling body read holds no handles; no cleanup needed
  });

  test("XHR wrap pushes network event with captured headers", () => {
    class FakeXHR {
      status = 0;
      responseText = "";
      private cbs: (() => void)[] = [];
      private reqH: Record<string, string> = {};
      open(_m: string, _u: string) {}
      setRequestHeader(k: string, v: string) {
        this.reqH[k] = v;
      }
      addEventListener(_t: string, cb: () => void) {
        this.cbs.push(cb);
      }
      getResponseHeader(n: string) {
        return n === "content-type" ? "application/json" : null;
      }
      getAllResponseHeaders() {
        return "content-type: application/json\r\nset-cookie: sid=1\r\n";
      }
      send(_b?: unknown) {
        // fire loadend synchronously so the event lands before stop()
        this.status = 200;
        this.responseText = '{"done":1}';
        for (const c of this.cbs) c();
      }
    }
    const g = globalThis as Record<string, unknown>;
    const savedXhr = g.XMLHttpRequest;
    g.XMLHttpRequest = FakeXHR;
    const rec = new Recorder({}, stubRecord);
    rec.start();
    const xhr = new FakeXHR();
    xhr.open("POST", "https://api.dev/xhr?token=zzz");
    xhr.setRequestHeader("Authorization", "Bearer s3cret");
    xhr.setRequestHeader("Content-Type", "application/json");
    xhr.send('{"x":2}');
    const [ev] = kind(rec.events, "network"); // read before stop() drains
    rec.stop();
    expect(ev.title).toBe("POST https://api.dev/xhr?token=[redacted]");
    expect(ev.detail.requestBody).toBe('{"x":2}');
    expect(ev.detail.status).toBe(200);
    expect(ev.detail.responseBody).toBe('{"done":1}');
    const reqH = ev.detail.requestHeaders as Record<string, string>;
    expect(reqH.authorization).toBe("[redacted]");
    expect(reqH["content-type"]).toBe("application/json");
    const resH = ev.detail.responseHeaders as Record<string, string>;
    expect(resH["content-type"]).toBe("application/json");
    expect(resH["set-cookie"]).toBe("[redacted]");
    if (savedXhr === undefined) delete g.XMLHttpRequest;
    else g.XMLHttpRequest = savedXhr;
  });

  test("XHR wrap: FormData body → [formdata], non-textual request body skipped", () => {
    class FakeXHR {
      status = 200;
      responseText = "ok";
      private cbs: (() => void)[] = [];
      open(_m: string, _u: string) {}
      setRequestHeader(_k: string, _v: string) {}
      addEventListener(_t: string, cb: () => void) {
        this.cbs.push(cb);
      }
      getResponseHeader(_n: string) {
        return null;
      }
      getAllResponseHeaders() {
        return "";
      }
      send(_b?: unknown) {
        for (const c of this.cbs) c();
      }
    }
    const g = globalThis as Record<string, unknown>;
    const savedXhr = g.XMLHttpRequest;
    const savedFormData = g.FormData;
    g.XMLHttpRequest = FakeXHR;
    g.FormData = class FormData {}; // no DOM FormData under bun-types
    const rec = new Recorder({}, stubRecord);
    rec.start();
    const fd = new (g.FormData as new () => unknown)();
    const xhr1 = new FakeXHR();
    xhr1.open("POST", "https://api.dev/fd");
    xhr1.send(fd);
    const xhr2 = new FakeXHR();
    xhr2.open("POST", "https://api.dev/blob");
    xhr2.send(new Uint8Array([1, 2]));
    const xhr3 = new FakeXHR();
    xhr3.open("POST", "https://api.dev/q");
    xhr3.setRequestHeader("Content-Type", "text/plain");
    xhr3.send(new URLSearchParams("a=1&b=2"));
    const evs = kind(rec.events, "network");
    rec.stop();
    expect(evs[0].detail.requestBody).toBe("[formdata]");
    expect(evs[1].detail.requestBody).toBeUndefined();
    expect(evs[2].detail.requestBody).toBe("a=1&b=2");
    if (savedXhr === undefined) delete g.XMLHttpRequest;
    else g.XMLHttpRequest = savedXhr;
    if (savedFormData === undefined) delete g.FormData;
    else g.FormData = savedFormData;
  });

  test("window error listener pushes renderer-shaped error event", () => {
    const rec = new Recorder({}, stubRecord);
    rec.start();
    const err = new Error("kaboom");
    err.stack = "Error: kaboom\n    at f (a.js:3:7)";
    for (const l of listeners.error ?? [])
      l({ message: "oops", filename: "a.js", lineno: 3, colno: 7, error: err });
    const [ev] = kind(rec.events, "error");
    expect(ev.level).toBe("error");
    expect(ev.title).toBe("oops");
    // renderer iterates detail.stack.forEach — must be string[]
    expect(ev.detail).toEqual({
      message: "oops",
      url: "a.js",
      line: 3,
      column: 7,
      stack: ["Error: kaboom", "    at f (a.js:3:7)"],
    });
    rec.stop();
  });

  test("unhandledrejection pushes error event with stack array", () => {
    const rec = new Recorder({}, stubRecord);
    rec.start();
    const err = new Error("async fail");
    err.stack = "Error: async fail\n    at g (b.js:1:1)";
    for (const l of listeners.unhandledrejection ?? []) l({ reason: err });
    const [ev] = kind(rec.events, "error");
    expect(ev.level).toBe("error");
    expect(ev.title).toBe("unhandledrejection: async fail");
    expect(ev.detail.message).toBe("unhandledrejection: async fail");
    expect(ev.detail.stack).toEqual([
      "Error: async fail",
      "    at g (b.js:1:1)",
    ]);
    rec.stop();
  });

  test("events ring-buffer at maxEvents", () => {
    const rec = new Recorder({ maxEvents: 3 }, stubRecord);
    rec.start(); // meta event occupies slot 1
    console.warn("a");
    console.warn("b");
    console.warn("c");
    expect(rec.events).toHaveLength(3);
    expect(rec.events[0].kind).toBe("console"); // meta evicted
    rec.stop();
    expect(rec.events).toHaveLength(0); // stop drains
  });
});
