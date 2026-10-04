import type { Db } from "@bugcapture/db";
import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { organization } from "better-auth/plugins";

export function createAuth(db: Db, secret: string, baseURL: string) {
  return betterAuth({
    database: drizzleAdapter(db, { provider: "pg" }),
    secret,
    baseURL,
    emailAndPassword: { enabled: true, requireEmailVerification: false },
    plugins: [
      organization({
        sendInvitationEmail: async (data) => {
          // Dev stub: email transport lands in Phase 7 (Resend).
          console.log(
            `[invite] ${data.email} → org ${data.organization.name}: ${data.invitation.id}`,
          );
        },
      }),
    ],
    trustedOrigins: [baseURL],
  });
}

/** The configured auth instance's type — plugin endpoints (org, session) flow through inference. */
export type Auth = ReturnType<typeof createAuth>;
