ALTER TABLE "report_artifacts" ADD COLUMN "status" text DEFAULT 'pending' NOT NULL;--> statement-breakpoint
ALTER TABLE "reports" ADD COLUMN "capture_session_id" text;--> statement-breakpoint
ALTER TABLE "reports" ADD CONSTRAINT "reports_capture_session_id_capture_sessions_id_fk" FOREIGN KEY ("capture_session_id") REFERENCES "public"."capture_sessions"("id") ON DELETE set null ON UPDATE no action;