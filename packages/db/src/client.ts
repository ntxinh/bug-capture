import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "./schema";

export type Db = ReturnType<typeof createDb>;

export function createDb(url: string) {
  const sql = postgres(url, { max: 10 });
  return drizzle(sql, { schema });
}
