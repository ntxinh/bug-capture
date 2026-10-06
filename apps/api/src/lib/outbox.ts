import type { Db } from "@bugcapture/db";
import {
  projectIntegrations,
  reportOutboxEvents,
  reports,
} from "@bugcapture/db/schema";
import { and, eq, sql } from "drizzle-orm";
import { env } from "../env";
import { unsealConfig } from "./integration-config";
// Pick<Db,"insert"> so callers inside db.transaction(tx => …) can pass tx.
export async function emitReportEvent(
  db: Pick<Db, "insert">,
  type: string,
  reportId: string,
  payload: Record<string, unknown>,
): Promise<void> {
  await db.insert(reportOutboxEvents).values({
    id: crypto.randomUUID(),
    type,
    reportId,
    payload,
    status: "pending",
    attempts: 0,
    nextAttemptAt: new Date(),
  });
}

export interface DrainOptions {
  limit?: number;
  fetchImpl?: typeof fetch;
}

/**
 * Delivers pending outbox events to the report project's enabled slack/webhook
 * integrations. One UPDATE ... FOR UPDATE SKIP LOCKED statement atomically
 * claims due rows as 'delivering' — an overlapping drain sees them as
 * non-pending and skips, so no double delivery. Claims stamp nextAttemptAt =
 * now(), so a 'delivering' row orphaned by a crash is reclaimed after 10min.
 * Non-2xx counts as a failed delivery.
 */
export async function drainOutbox(
  db: Db,
  { limit = 25, fetchImpl = fetch }: DrainOptions = {},
): Promise<number> {
  const due = await db
    .update(reportOutboxEvents)
    .set({ status: "delivering", nextAttemptAt: new Date() })
    .where(
      sql`${reportOutboxEvents.id} in (
        select id from report_outbox_events
        where (status = 'pending' and next_attempt_at <= now())
           or (status = 'delivering' and next_attempt_at < now() - interval '10 minutes')
        order by created_at
        limit ${limit}
        for update skip locked
      )`,
    )
    .returning();
  let sent = 0;
  for (const evt of due) {
    const [rep] = await db
      .select()
      .from(reports)
      .where(eq(reports.id, evt.reportId));
    const ints = rep
      ? await db
          .select()
          .from(projectIntegrations)
          .where(
            and(
              eq(projectIntegrations.projectId, rep.projectId),
              eq(projectIntegrations.enabled, true),
            ),
          )
      : [];
    const payload = evt.payload as Record<string, unknown>;
    try {
      let outcome: "sent" | "skipped" = "sent";
      for (const int of ints) {
        if (
          int.provider !== "slack" &&
          int.provider !== "webhook" &&
          int.provider !== "email"
        )
          continue;
        const cfg = unsealConfig(int.config as Record<string, unknown>);
        if (int.provider === "email") {
          // no key → terminal skip; retrying can't conjure env config
          if (!env.resendApiKey) {
            outcome = "skipped";
            continue;
          }
          const res = await fetchImpl("https://api.resend.com/emails", {
            method: "POST",
            headers: {
              "content-type": "application/json",
              authorization: `Bearer ${env.resendApiKey}`,
            },
            body: JSON.stringify({
              from: cfg.from,
              to: cfg.to,
              subject: `[${payload.status ?? evt.type}] ${payload.title}`,
              html: `<a href="${payload.url}">view report</a>`,
            }),
            signal: AbortSignal.timeout(10_000),
          });
          if (!res.ok) throw new Error(`resend post ${res.status}`);
          continue;
        }
        const body =
          int.provider === "slack"
            ? { text: `🐞 ${payload.title} — ${payload.url}` }
            : {
                type: evt.type,
                report: {
                  id: evt.reportId,
                  title: payload.title,
                  status: payload.status,
                  url: payload.url,
                },
                payload,
              };
        const res = await fetchImpl(String(cfg.url), {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(10_000),
        });
        if (!res.ok) throw new Error(`integration post ${res.status}`);
      }
      await db
        .update(reportOutboxEvents)
        .set({
          status: outcome,
          ...(outcome === "sent" ? { sentAt: new Date() } : {}),
        })
        .where(eq(reportOutboxEvents.id, evt.id));
      if (outcome === "sent") sent++;
    } catch (e) {
      const attempts = evt.attempts + 1;
      await db
        .update(reportOutboxEvents)
        .set({
          attempts,
          lastError: e instanceof Error ? e.message : String(e),
          status: attempts >= 6 ? "failed" : "pending",
          nextAttemptAt: new Date(Date.now() + attempts * 60_000),
        })
        .where(eq(reportOutboxEvents.id, evt.id));
    }
  }
  return sent;
}

export function startOutboxWorker(
  db: Db,
  { intervalMs = 15_000 }: { intervalMs?: number } = {},
): () => void {
  let running = false;
  const timer = setInterval(() => {
    if (running) return; // slow batch still in flight — skip this tick
    running = true;
    drainOutbox(db)
      .catch((e) => console.error("outbox drain", e))
      .finally(() => {
        running = false;
      });
  }, intervalMs);
  return () => clearInterval(timer);
}
