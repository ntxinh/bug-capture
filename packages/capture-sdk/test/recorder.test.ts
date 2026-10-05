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

  test("console patch pushes event and preserves passthrough", () => {
    let calledWith: unknown[] | undefined;
    const orig = console.error;
    console.error = (...a: unknown[]) => {
      calledWith = a;
    };
    const rec = new Recorder({}, stubRecord);
    rec.start();
    console.error("boom", { a: 1 });
    const [ev] = kind(rec.events, "console");
    expect(ev.title).toBe("error");
    expect(ev.detail.level).toBe("error");
    expect(JSON.parse(String(ev.detail.args))).toEqual(["boom", { a: 1 }]);
    expect(calledWith).toEqual(["boom", { a: 1 }]);
    rec.stop();
    expect(console.error).not.toBe(orig); // restores the spy, not the original
    console.error = orig;
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
      responseBody: '{"ok":true}',
    });
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

  test("window error listener pushes error event", () => {
    const rec = new Recorder({}, stubRecord);
    rec.start();
    for (const l of listeners.error ?? [])
      l({ message: "oops", filename: "a.js", lineno: 3, colno: 7 });
    const [ev] = kind(rec.events, "error");
    expect(ev.title).toBe("oops");
    expect(ev.detail).toMatchObject({ source: "a.js", lineno: 3, colno: 7 });
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
