import { drizzle } from "drizzle-orm/postgres-js";
import { migrate as runMigrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";

export async function migrate(url: string) {
  const sql = postgres(url, { max: 1 });
  try {
    await runMigrate(drizzle(sql), {
      migrationsFolder: new URL("./migrations", import.meta.url).pathname,
    });
  } finally {
    await sql.end();
  }
}
