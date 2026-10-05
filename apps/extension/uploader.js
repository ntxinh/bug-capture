// Uploads a capture report to the server: redact → ingest (descriptor) →
// PUT each artifact's bytes → finalize. ES module, no dependencies.
import { redactReport } from "./redact.js";

const encode = (s) => new TextEncoder().encode(s);

async function sha256hex(bytes) {
  const d = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function dataUrlToBytes(dataUrl) {
  const i = dataUrl.indexOf(",");
  if (!dataUrl.slice(0, i).includes(";base64"))
    return encode(decodeURIComponent(dataUrl.slice(i + 1)));
  const bin = atob(dataUrl.slice(i + 1));
  const out = new Uint8Array(bin.length);
  for (let j = 0; j < bin.length; j++) out[j] = bin.charCodeAt(j);
  return out;
}

const fail = async (res, what) => {
  throw Object.assign(new Error(`${what} failed`), {
    status: res.status,
    body: await res.json().catch(() => ({})),
  });
};

export async function uploadReport(report, { apiUrl, token, projectId, environmentId }) {
  const r = redactReport(report);
  const artifacts = [];
  const put = (kind, bytes) =>
    artifacts.push({ kind, bytes, sha256: null, sizeBytes: bytes.byteLength });
  if (r.rrwebEvents)
    put("replay", encode(typeof r.rrwebEvents === "string" ? r.rrwebEvents : JSON.stringify(r.rrwebEvents)));
  if (r.audio?.dataUrl) put("audio", dataUrlToBytes(r.audio.dataUrl));
  for (const e of r.events || [])
    if (e.kind === "screenshot" && e.detail?.image?.startsWith?.("data:"))
      put("screenshot", dataUrlToBytes(e.detail.image));
  for (const a of artifacts) a.sha256 = await sha256hex(a.bytes);

  const envelope = {
    schemaVersion: 2,
    summary: { title: r.meta?.pageTitle || r.meta?.pageUrl || "capture", url: r.meta?.pageUrl },
    meta: { ...r.meta, device: r.device },
    events: r.events,
    artifacts: artifacts.map(({ bytes, ...d }) => d),
  };
  const auth = { authorization: `Bearer ${token}` };
  const res = await fetch(`${apiUrl}/api/v1/reports/ingest`, {
    method: "POST",
    headers: { "content-type": "application/json", ...auth },
    body: JSON.stringify({ projectId, environmentId, envelope }),
  });
  if (!res.ok) await fail(res, "ingest");
  const { reportId, uploads } = await res.json();
  await Promise.all(
    uploads.map(async (u, i) => {
      const p = await fetch(u.url, {
        method: "PUT",
        headers: u.url.startsWith(apiUrl) ? { ...u.headers, ...auth } : u.headers,
        body: artifacts[i].bytes,
      });
      if (!p.ok) await fail(p, "upload");
    }),
  );
  const fin = await fetch(`${apiUrl}/api/v1/reports/${reportId}/finalize`, {
    method: "POST",
    headers: auth,
  });
  if (!fin.ok) await fail(fin, "finalize");
  return { reportId };
}
