import type { BugReportEnvelope } from "@bugcapture/report-schema";
import type { ReportSink, SubmitResult } from "./index";

/** Test double / local-dev sink. Keeps envelopes in memory; not a persistence layer. */
export class InMemoryReportSink implements ReportSink {
  readonly reports: BugReportEnvelope[] = [];

  async submit(report: BugReportEnvelope): Promise<SubmitResult> {
    this.reports.push(report);
    return { ok: true, reportId: report.report.id };
  }
}
