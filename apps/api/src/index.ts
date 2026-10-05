import { createDb } from "@bugcapture/db";
import { LocalFsStorage, S3Storage } from "@bugcapture/storage";
import { buildApp } from "./app";
import { env } from "./env";
import { createAuth } from "./lib/auth";
import { startOutboxWorker } from "./lib/outbox";

const db = createDb(env.databaseUrl);
const auth = createAuth(db, env.betterAuthSecret, env.betterAuthUrl);
const [endpoint, bucket, accessKeyId, secretAccessKey] = [
  process.env.S3_ENDPOINT,
  process.env.S3_BUCKET,
  process.env.S3_ACCESS_KEY_ID,
  process.env.S3_SECRET_ACCESS_KEY,
];
const storage =
  endpoint && bucket && accessKeyId && secretAccessKey
    ? new S3Storage({ endpoint, bucket, accessKeyId, secretAccessKey })
    : new LocalFsStorage(
        process.env.ARTIFACT_DIR ?? "data/artifacts",
        env.betterAuthUrl,
      );
const app = buildApp(db, auth, env.betterAuthUrl, storage);
if (process.env.OUTBOX_DISABLED !== "1")
  startOutboxWorker(db, { intervalMs: 15_000 });

export default { port: env.port, fetch: app.fetch };
