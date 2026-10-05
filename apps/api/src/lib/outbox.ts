import type { Db } from "@bugcapture/db";
import { reportOutboxEvents } from "@bugcapture/db/schema";

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
