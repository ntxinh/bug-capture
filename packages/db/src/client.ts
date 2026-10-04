import { drizzle, type PostgresJsDatabase } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "./schema";

/** Drizzle instance bound to this package's schema; $client is the postgres.Sql pool. */
export type Db = PostgresJsDatabase<typeof schema> & { $client: postgres.Sql };

export function createDb(url: string): Db {
  const sql = postgres(url, { max: 10 });
  return drizzle(sql, { schema });
}
