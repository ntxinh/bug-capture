// Report viewer: reconstructs the extension's report object from the stored
// envelope + uploaded artifacts, then reuses /ext/renderer.js (the same code
// the extension viewer runs). The replay engine arrives as a classic script
// exposing window.RRWebReplayer.
import {
  mountAudio,
  mountReplay,
  renderReport,
  REPLAY_CSS,
  REPORT_CSS,
} from "/ext/renderer.js";

const $ = (id) => document.getElementById(id);

function fail(status) {
  const msg =
    status === 401
      ? 'Sign in to view this report. <a href="/app/">Sign in →</a>'
      : status === 404
        ? "Report not found."
        : `Failed to load report (${status}).`;
  const el = document.createElement("div");
  el.className = "err";
  el.innerHTML = msg;
  $("app").replaceChildren(el);
}

function blobToDataUrl(blob) {
  return new Promise((res, rej) => {
    const r = new FileReader();
    r.onload = () => res(r.result);
    r.onerror = rej;
    r.readAsDataURL(blob);
  });
}

const style = document.createElement("style");
style.textContent = REPORT_CSS + REPLAY_CSS;
document.head.appendChild(style);

const id = new URLSearchParams(location.search).get("id");
if (!id) {
  fail(404);
} else {
  let rep;
  try {
    const res = await fetch(`/api/v1/reports/${id}`);
    if (!res.ok) throw { status: res.status };
    rep = await res.json();
  } catch (err) {
    fail(err.status ?? 0);
  }
  if (rep) {
    // Stored envelope: {schemaVersion, summary, meta:{…, device}, events, artifacts}
    const env = rep.data ?? {};
    const report = {
      meta: {
        ...(env.meta ?? {}),
        pageTitle: rep.title,
        capturedAt: env.meta?.capturedAt ?? rep.createdAt,
      },
      device: env.meta?.device,
      events: env.events ?? [],
      rrwebEvents: [],
      audio: null,
    };
    const uploaded = (a) => a.type && a.status === "uploaded" && a.downloadUrl;
    const replay = rep.artifacts?.find(
      (a) => a.type === "replay" && uploaded(a),
    );
    if (replay)
      report.rrwebEvents = await fetch(replay.downloadUrl).then((r) =>
        r.json(),
      );
    const audio = rep.artifacts?.find((a) => a.type === "audio" && uploaded(a));
    if (audio) {
      const blob = await fetch(audio.downloadUrl).then((r) => r.blob());
      report.audio = { dataUrl: await blobToDataUrl(blob) };
    }

    renderReport($("app"), report);

    const ReplayerCtor = globalThis.RRWebReplayer;
    const hasReplay = !!(
      ReplayerCtor &&
      report.rrwebEvents &&
      report.rrwebEvents.length > 1
    );
    if (hasReplay) {
      $("replay-section").hidden = false; // visible BEFORE mount so it measures
      mountReplay($("replay"), report, ReplayerCtor);
    }
    // Standalone narration only when no replay exists to drive it in sync.
    if (!hasReplay && report.audio?.dataUrl) {
      $("audio-section").hidden = false;
      mountAudio($("audio"), report);
    }
  }
}
