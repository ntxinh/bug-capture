import {
  index,
  integer,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { organization, user } from "./auth";

export const projects = pgTable(
  "projects",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    slug: text("slug").notNull(),
    key: text("key").notNull().unique(),
    publicKey: text("public_key").notNull().unique(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (t) => [
    index("projects_organizationId_idx").on(t.organizationId),
    uniqueIndex("projects_org_slug_uidx").on(t.organizationId, t.slug),
  ],
);

export const projectEnvironments = pgTable(
  "project_environments",
  {
    id: text("id").primaryKey(),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    key: text("key").notNull(),
    baseUrl: text("base_url"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (t) => [
    index("project_environments_projectId_idx").on(t.projectId),
    uniqueIndex("project_environments_project_key_uidx").on(t.projectId, t.key),
  ],
);

export const projectOrigins = pgTable(
  "project_origins",
  {
    id: text("id").primaryKey(),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    origin: text("origin").notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (t) => [
    index("project_origins_projectId_idx").on(t.projectId),
    uniqueIndex("project_origins_project_origin_uidx").on(
      t.projectId,
      t.origin,
    ),
  ],
);

export const captureSessions = pgTable(
  "capture_sessions",
  {
    id: text("id").primaryKey(),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    environmentId: text("environment_id").references(
      () => projectEnvironments.id,
      { onDelete: "set null" },
    ),
    startedAt: timestamp("started_at").defaultNow().notNull(),
    endedAt: timestamp("ended_at"),
    status: text("status").default("recording").notNull(),
    // status: recording | stopped | submitted | discarded
  },
  (t) => [index("capture_sessions_projectId_idx").on(t.projectId)],
);

export const reports = pgTable(
  "reports",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    environmentId: text("environment_id").references(
      () => projectEnvironments.id,
      { onDelete: "set null" },
    ),
    title: text("title").notNull(),
    description: text("description"),
    status: text("status").default("open").notNull(),
    // status: open | in_progress | resolved | closed | ignored
    priority: text("priority").default("normal").notNull(),
    // priority: low | normal | high | urgent
    createdBy: text("created_by")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    assignedTo: text("assigned_to").references(() => user.id, {
      onDelete: "set null",
    }),
    captureSessionId: text("capture_session_id").references(
      () => captureSessions.id,
      { onDelete: "set null" },
    ),
    captureMode: text("capture_mode"),
    startedAt: timestamp("started_at"),
    endedAt: timestamp("ended_at"),
    appVersion: text("app_version"),
    gitSha: text("git_sha"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (t) => [
    index("reports_organizationId_idx").on(t.organizationId),
    index("reports_projectId_idx").on(t.projectId),
    index("reports_status_idx").on(t.status),
  ],
);

export const reportArtifacts = pgTable(
  "report_artifacts",
  {
    id: text("id").primaryKey(),
    reportId: text("report_id")
      .notNull()
      .references(() => reports.id, { onDelete: "cascade" }),
    type: text("type").notNull(),
    // type: replay | screenshot | audio | video | report_bundle | attachment
    storageProvider: text("storage_provider").notNull(),
    storageKey: text("storage_key").notNull(),
    contentType: text("content_type").notNull(),
    sizeBytes: integer("size_bytes").notNull(),
    sha256: text("sha256").notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    status: text("status").default("pending").notNull(),
    // status: pending | uploaded | verified
  },
  (t) => [index("report_artifacts_reportId_idx").on(t.reportId)],
);

export const reportShares = pgTable(
  "report_shares",
  {
    id: text("id").primaryKey(),
    reportId: text("report_id")
      .notNull()
      .references(() => reports.id, { onDelete: "cascade" }),
    tokenHash: text("token_hash").notNull().unique(),
    visibility: text("visibility").default("link").notNull(),
    expiresAt: timestamp("expires_at"),
    createdBy: text("created_by")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    revokedAt: timestamp("revoked_at"),
  },
  (t) => [index("report_shares_reportId_idx").on(t.reportId)],
);

export const externalLinks = pgTable(
  "external_links",
  {
    id: text("id").primaryKey(),
    reportId: text("report_id")
      .notNull()
      .references(() => reports.id, { onDelete: "cascade" }),
    provider: text("provider").notNull(),
    externalId: text("external_id").notNull(),
    url: text("url").notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (t) => [index("external_links_reportId_idx").on(t.reportId)],
);
