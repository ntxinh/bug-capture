import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { OpenJamClient, type OpenJamConfig, resolveConfig } from "./client.js";
import { registerTools } from "./tools.js";

export { OpenJamClient, resolveConfig };

export async function main(): Promise<void> {
  let cfg: OpenJamConfig;
  try {
    cfg = resolveConfig();
  } catch (e) {
    console.error(`bugcapture-mcp: ${(e as Error).message}`);
    process.exit(1);
  }
  const server = new McpServer({ name: "bugcapture-mcp", version: "0.1.0" });
  registerTools(server, new OpenJamClient(cfg));
  await server.connect(new StdioServerTransport());
}

if (import.meta.main) await main();
