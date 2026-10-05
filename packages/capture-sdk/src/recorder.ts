import { redactBody, redactHeaders, redactUrl } from "@bugcapture/redaction";
import { record as rrwebRecord } from "rrweb";
import { type OjEvent, pageMeta } from "./envelope";

export type RrwebRecordFn = (options: {
  emit: (event: unknown) => void;
  checkoutEveryNms?: number;
}) => (() => void) | undefined;

export interface RecorderConfig {
  maxEvents?: number;
  maxBodyBytes?: number;
}

const CONSOLE_LEVELS = ["log", "info", "warn", "error", "debug"] as const;
const TEXTUAL = /json|text|xml/i;
type ConsoleLevel = (typeof CONSOLE_LEVELS)[number];
type AnyRec = Record<string, unknown>;

/** Minimal XHR surface the wrap touches; avoids the DOM lib. */
interface XhrLike {
  __oj?: {
    method: string;
    url: string;
    requestHeaders?: Record<string, string>;
  };
  status: number;
  responseText: unknown;
  getResponseHeader(name: string): string | null;
  getAllResponseHeaders(): string;
  addEventListener(type: string, cb: () => void): void;
}

/** `getAllResponseHeaders()` returns `name: value\r\n` lines → object. */
function parseXhrHeaders(raw: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of raw.split("\r\n")) {
    const i = line.indexOf(":");
    if (i > 0)
      out[line.slice(0, i).trim().toLowerCase()] = line.slice(i + 1).trim();
  }
  return out;
}

function headersToObject(h: unknown): Record<string, string> {
  try {
    const out: Record<string, string> = {};
    new Headers(h as Bun.HeadersInit).forEach((v, k) => {
      out[k] = v;
    });
    return out;
  } catch {
    return {};
  }
}

function safeStringify(args: readonly unknown[], cap: number): string {
  const seen = new WeakSet();
  try {
    return JSON.stringify(
      args.map((a) =>
        a instanceof Error ? { message: a.message, stack: a.stack } : a,
      ),
      (_k, v: unknown) => {
        if (typeof v === "bigint") return String(v);
        if (v && typeof v === "object") {
          if (seen.has(v)) return "[circular]";
          seen.add(v);
        }
        return v;
      },
    ).slice(0, cap);
  } catch {
    return String(args).slice(0, cap);
  }
}

function stackOf(v: unknown): string | undefined {
  if (v instanceof Error) return v.stack;
  if (v && typeof v === "object" && "stack" in v && typeof v.stack === "string")
    return v.stack;
  return undefined;
}

export class Recorder {
  readonly events: OjEvent[] = [];
  private readonly replay: unknown[] = [];
  private readonly restore: (() => void)[] = [];
  private readonly maxEvents: number;
  private readonly maxBodyBytes: number;
  private readonly recordFn?: RrwebRecordFn;
  private startWall = 0;
  private running = false;

  constructor(cfg: RecorderConfig = {}, recordFn?: RrwebRecordFn) {
    this.maxEvents = cfg.maxEvents ?? 5000;
    this.maxBodyBytes = cfg.maxBodyBytes ?? 64 * 1024;
    this.recordFn = recordFn;
  }

  private push(kind: OjEvent["kind"], title: string, detail: AnyRec): void {
    if (!this.running) return;
    const t = Date.now();
    this.events.push({ t, rel: t - this.startWall, kind, title, detail });
    if (this.events.length > this.maxEvents) this.events.shift();
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.startWall = Date.now();
    const record = this.recordFn ?? (rrwebRecord as unknown as RrwebRecordFn);
    const stopRr = record({
      emit: (e) => {
        if (this.running) this.replay.push(e);
      },
      checkoutEveryNms: 30000,
    });
    if (typeof stopRr === "function") this.restore.push(stopRr);
    this.push("meta", "page", pageMeta() as unknown as AnyRec);
    this.patchConsole();
    this.patchFetch();
    this.patchXhr();
    this.patchErrors();
  }

  /** Returns the captured buffers and restores every patched global. */
  stop(): { events: OjEvent[]; replay: unknown[] } {
    this.running = false;
    for (const r of this.restore.splice(0)) {
      try {
        r();
      } catch {
        /* capture must never break the page */
      }
    }
    return { events: this.events.splice(0), replay: this.replay.splice(0) };
  }

  private patchConsole(): void {
    for (const level of CONSOLE_LEVELS) {
      const c = console as unknown as Record<
        ConsoleLevel,
        (...a: unknown[]) => void
      >;
      const orig = c[level];
      const self = this;
      c[level] = function (this: unknown, ...args: unknown[]) {
        self.push("console", level, { level, args: safeStringify(args, 8192) });
        return orig.apply(console, args);
      };
      this.restore.push(() => {
        c[level] = orig;
      });
    }
  }

  private patchFetch(): void {
    const orig = globalThis.fetch;
    if (!orig) return;
    globalThis.fetch = (async (
      input: Parameters<typeof fetch>[0],
      init?: Parameters<typeof fetch>[1],
    ) => {
      const t0 = Date.now();
      // No `new Request(input, init)` — undici's ctor types reject URL, and
      // Bun's init isn't a DOM RequestInit. Read the pieces directly.
      const isReq = input instanceof Request;
      const method = (
        init?.method ?? (isReq ? input.method : "GET")
      ).toUpperCase();
      const url = redactUrl(isReq ? input.url : String(input));
      const requestHeaders = redactHeaders({
        ...headersToObject(isReq ? input.headers : undefined),
        ...headersToObject(init?.headers),
      });
      const detail: AnyRec = { method, url, requestHeaders };
      if (
        typeof init?.body === "string" &&
        init.body.length <= this.maxBodyBytes &&
        TEXTUAL.test(requestHeaders["content-type"] ?? "application/json")
      )
        detail.requestBody = redactBody(init.body);
      try {
        const res = await orig(input, init);
        detail.status = res.status;
        detail.durationMs = Date.now() - t0;
        detail.responseHeaders = redactHeaders(headersToObject(res.headers));
        // clone() tees the stream so the caller still gets the body; skipped
        // for binary/oversized payloads.
        if (TEXTUAL.test(res.headers.get("content-type") ?? "")) {
          const text = await res.clone().text();
          if (text.length <= this.maxBodyBytes)
            detail.responseBody = redactBody(text);
        }
        this.push("network", `${method} ${url}`, detail);
        return res;
      } catch (err) {
        detail.durationMs = Date.now() - t0;
        detail.error = err instanceof Error ? err.message : String(err);
        this.push("network", `${method} ${url}`, detail);
        throw err;
      }
    }) as typeof fetch;
    this.restore.push(() => {
      globalThis.fetch = orig;
    });
  }

  private patchXhr(): void {
    // DOM global, untyped under bun-types; presence/shape checked below.
    const g = globalThis as unknown as AnyRec;
    const xhr = g.XMLHttpRequest;
    if (typeof xhr !== "function") return;
    const proto = xhr.prototype as AnyRec;
    const { open, send, setRequestHeader } = proto;
    if (typeof open !== "function" || typeof send !== "function") return;
    const self = this;
    proto.open = function (
      this: XhrLike,
      method: string,
      url: string,
      ...rest: unknown[]
    ) {
      this.__oj = { method, url: String(url) };
      return open.call(this, method, url, ...rest);
    };
    if (typeof setRequestHeader === "function")
      proto.setRequestHeader = function (
        this: XhrLike,
        name: string,
        value: string,
      ) {
        if (!this.__oj) this.__oj = { method: "GET", url: "" };
        const oj = this.__oj;
        if (!oj.requestHeaders) oj.requestHeaders = {};
        oj.requestHeaders[String(name).toLowerCase()] = String(value);
        return setRequestHeader.call(this, name, value);
      };
    proto.send = function (this: XhrLike, body?: unknown) {
      const m = this.__oj;
      const method = m?.method ?? "GET";
      const url = redactUrl(m?.url ?? "");
      const t0 = Date.now();
      const requestHeaders = redactHeaders(m?.requestHeaders ?? {});
      const detail: AnyRec = { method, url, requestHeaders };
      const isFormData = body != null && body.constructor?.name === "FormData";
      const bodyText =
        typeof body === "string"
          ? body
          : body != null && body.constructor?.name === "URLSearchParams"
            ? body.toString()
            : undefined;
      if (isFormData) detail.requestBody = "[formdata]";
      else if (
        bodyText != null &&
        bodyText.length <= self.maxBodyBytes &&
        TEXTUAL.test(requestHeaders["content-type"] ?? "application/json")
      )
        detail.requestBody = redactBody(bodyText);
      const done = () => {
        detail.status = this.status;
        detail.durationMs = Date.now() - t0;
        try {
          detail.responseHeaders = redactHeaders(
            parseXhrHeaders(this.getAllResponseHeaders() ?? ""),
          );
          if (TEXTUAL.test(this.getResponseHeader("content-type") ?? "")) {
            const text = this.responseText;
            if (typeof text === "string" && text.length <= self.maxBodyBytes)
              detail.responseBody = redactBody(text);
          }
        } catch {
          /* header/responseText access throws for some responseTypes */
        }
        self.push("network", `${method} ${url}`, detail);
      };
      this.addEventListener("loadend", done);
      return send.call(this, body);
    };
    this.restore.push(() => {
      proto.open = open;
      proto.send = send;
      if (typeof setRequestHeader === "function")
        proto.setRequestHeader = setRequestHeader;
    });
  }

  private patchErrors(): void {
    // window ?? globalThis covers browsers and bun-test stubs alike.
    const g = globalThis as unknown as AnyRec;
    const win = g.window;
    const target =
      win && typeof win === "object" && "addEventListener" in win ? win : g;
    if (typeof target.addEventListener !== "function") return;
    // DOM EventTarget — listener payloads are runtime objects typed per-handler.
    const evTarget = target as {
      addEventListener: (type: string, cb: (e: never) => void) => void;
      removeEventListener?: (type: string, cb: (e: never) => void) => void;
    };
    const onError = (e: {
      message?: string;
      filename?: string;
      lineno?: number;
      colno?: number;
      error?: unknown;
    }) =>
      this.push("error", String(e.message ?? "error"), {
        stack: stackOf(e.error),
        source: e.filename,
        lineno: e.lineno,
        colno: e.colno,
      });
    const onRejection = (e: { reason?: unknown }) =>
      this.push(
        "error",
        `unhandledrejection: ${e.reason instanceof Error ? e.reason.message : String(e.reason)}`,
        { stack: stackOf(e.reason) },
      );
    evTarget.addEventListener("error", onError);
    evTarget.addEventListener("unhandledrejection", onRejection);
    this.restore.push(() => {
      evTarget.removeEventListener?.("error", onError);
      evTarget.removeEventListener?.("unhandledrejection", onRejection);
    });
  }
}
