import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { OpenJamClient } from "./client.js";

// SDK wraps thrown handler errors into {isError:true} results.
const text = (data: unknown) => ({
  content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }],
});

export function registerTools(server: McpServer, client: OpenJamClient): void {
  server.registerTool(
    "openjam_list_reports",
    {
      description: "List bug reports. Optional projectId/status filters.",
      inputSchema: {
        projectId: z.string().optional(),
        status: z.string().optional(),
        limit: z.number().int().positive().optional().default(20),
      },
    },
    async (args) => text(await client.listReports(args)),
  );

  server.registerTool(
    "openjam_get_report",
    {
      description: "Get a bug report with its artifacts and shares.",
      inputSchema: { reportId: z.string() },
    },
    async ({ reportId }) => text(await client.getReport(reportId)),
  );

  server.registerTool(
    "openjam_get_ai_context",
    {
      description:
        "Get the AI-oriented context bundle for a report (events, environment, artifacts, symbolicated stack).",
      inputSchema: { reportId: z.string() },
    },
    async ({ reportId }) => text(await client.getAiContext(reportId)),
  );

  server.registerTool(
    "openjam_get_replay",
    {
      description:
        "Download a report's replay artifact to a local temp file; returns { path, sizeBytes }.",
      inputSchema: { reportId: z.string() },
    },
    async ({ reportId }) => text(await client.getReplay(reportId)),
  );
}
