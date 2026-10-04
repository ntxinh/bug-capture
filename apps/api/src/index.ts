import { createDb } from "@bugcapture/db";
import { buildApp } from "./app";
import { env } from "./env";
import { createAuth } from "./lib/auth";

const db = createDb(env.databaseUrl);
const auth = createAuth(db, env.betterAuthSecret, env.betterAuthUrl);
const app = buildApp(auth);

export default { port: env.port, fetch: app.fetch };
