import type { Db } from "@bugcapture/db";
import {
  projectIntegrations,
  reportOutboxEvents,
  reports,
} from "@bugcapture/db/schema";
import { and, asc, eq, lte } from "drizzle-orm";
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
 * integrations. SKIP LOCKED keeps it safe for future multi-worker. Non-2xx
 * counts as a failed delivery.
 */
export async function drainOutbox(
  db: Db,
  { limit = 25, fetchImpl = fetch }: DrainOptions = {},
): Promise<number> {
  const due = await db
    .select()
    .from(reportOutboxEvents)
    .where(
      and(
        eq(reportOutboxEvents.status, "pending"),
        lte(reportOutboxEvents.nextAttemptAt, new Date()),
      ),
    )
    .orderBy(asc(reportOutboxEvents.createdAt))
    .limit(limit)
    .for("update", { skipLocked: true });
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
      for (const int of ints) {
        if (int.provider !== "slack" && int.provider !== "webhook") continue;
        const cfg = unsealConfig(int.config as Record<string, unknown>);
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
        });
        if (!res.ok) throw new Error(`integration post ${res.status}`);
      }
      await db
        .update(reportOutboxEvents)
        .set({ status: "sent", sentAt: new Date() })
        .where(eq(reportOutboxEvents.id, evt.id));
      sent++;
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
  const timer = setInterval(
    () => drainOutbox(db).catch((e) => console.error("outbox drain", e)),
    intervalMs,
  );
  return () => clearInterval(timer);
}
