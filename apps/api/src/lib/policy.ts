import type { Db } from "@bugcapture/db";
import { member, projects, reports } from "@bugcapture/db/schema";
import { and, eq } from "drizzle-orm";

export type Role = "owner" | "admin" | "member";

export async function getRole(
  db: Db,
  userId: string,
  orgId: string,
): Promise<Role | null> {
  const [m] = await db
    .select({ role: member.role })
    .from(member)
    .where(and(eq(member.userId, userId), eq(member.organizationId, orgId)));
  return (m?.role as Role) ?? null;
}

export async function isMember(
  db: Db,
  userId: string,
  orgId: string,
): Promise<boolean> {
  return (await getRole(db, userId, orgId)) !== null;
}

export async function isAdmin(
  db: Db,
  userId: string,
  orgId: string,
): Promise<boolean> {
  const r = await getRole(db, userId, orgId);
  return r === "owner" || r === "admin";
}

/** Project lookup scoped to org — returns null if not found OR not in org (404 semantics). */
export async function projectInOrg(db: Db, orgId: string, projectId: string) {
  const [p] = await db
    .select()
    .from(projects)
    .where(and(eq(projects.id, projectId), eq(projects.organizationId, orgId)));
  return p ?? null;
}

/** Report lookup scoped to org — returns null if not found OR not in org (404 semantics). */
export async function reportInOrg(db: Db, orgId: string, reportId: string) {
  const [r] = await db
    .select()
    .from(reports)
    .where(and(eq(reports.id, reportId), eq(reports.organizationId, orgId)));
  return r ?? null;
}
