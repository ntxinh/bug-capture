export const env = {
  databaseUrl:
    process.env.DATABASE_URL ??
    "postgres://bugcapture:dev@localhost:5432/bugcapture",
  betterAuthSecret:
    process.env.BETTER_AUTH_SECRET ?? "dev-only-secret-change-me",
  betterAuthUrl: process.env.BETTER_AUTH_URL ?? "http://localhost:3000",
  port: Number(process.env.PORT ?? 3000),
};
