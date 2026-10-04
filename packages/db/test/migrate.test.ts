import { describe, expect, it } from "bun:test";
import { PostgreSqlContainer } from "@testcontainers/postgresql";
import postgres from "postgres";
import { migrate } from "../src/migrate";

process.env.TESTCONTAINERS_RYUK_DISABLED ??= "true";
process.env.DOCKER_HOST ??= `unix:///run/user/${process.getuid()}/podman/podman.sock`;

describe("migrate", () => {
  it("applies schema to a fresh postgres", async () => {
    const container = await new PostgreSqlContainer(
      "postgres:16-alpine",
    ).start();
    try {
      await migrate(container.getConnectionUri());
      const sql = postgres(container.getConnectionUri());
      const rows = await sql`
        select table_name from information_schema.tables
        where table_schema = 'public' order by 1`;
      const names = rows.map((r) => r.table_name);
      for (const t of [
        "user",
        "session",
        "account",
        "verification",
        "rate_limit",
        "organization",
        "member",
        "invitation",
        "projects",
        "project_environments",
        "project_origins",
        "capture_sessions",
        "reports",
        "report_artifacts",
        "report_shares",
        "external_links",
      ]) {
        expect(names).toContain(t);
      }
      await sql.end();
    } finally {
      await container.stop();
    }
  }, 120_000);
});
