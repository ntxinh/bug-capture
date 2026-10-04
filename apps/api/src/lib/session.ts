import { createMiddleware } from "hono/factory";
import type { Auth } from "./auth";

export type SessionUser = { id: string; email: string; name: string };

declare module "hono" {
  interface ContextVariableMap {
    user: SessionUser;
    orgId: string;
  }
}

export function requireAuth(auth: Auth) {
  return createMiddleware(async (c, next) => {
    const session = await auth.api.getSession({ headers: c.req.raw.headers });
    if (!session) return c.json({ error: "unauthorized" }, 401);
    const orgId = session.session.activeOrganizationId;
    if (!orgId) return c.json({ error: "no active organization" }, 400);
    c.set("user", {
      id: session.user.id,
      email: session.user.email,
      name: session.user.name,
    });
    c.set("orgId", orgId);
    await next();
  });
}
