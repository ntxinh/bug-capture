CREATE TABLE "releases" (
	"id" text PRIMARY KEY NOT NULL,
	"project_id" text NOT NULL,
	"version" text NOT NULL,
	"environment" text NOT NULL,
	"commit_sha" text,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sourcemaps" (
	"id" text PRIMARY KEY NOT NULL,
	"release_id" text NOT NULL,
	"filename" text NOT NULL,
	"storage_key" text NOT NULL,
	"size_bytes" integer NOT NULL,
	"sha256" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "releases" ADD CONSTRAINT "releases_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sourcemaps" ADD CONSTRAINT "sourcemaps_release_id_releases_id_fk" FOREIGN KEY ("release_id") REFERENCES "public"."releases"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "releases_project_version_env_uidx" ON "releases" USING btree ("project_id","version","environment");--> statement-breakpoint
CREATE UNIQUE INDEX "sourcemaps_release_filename_uidx" ON "sourcemaps" USING btree ("release_id","filename");