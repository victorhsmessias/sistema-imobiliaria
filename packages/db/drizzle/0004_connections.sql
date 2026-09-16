CREATE TYPE "public"."connection_event_type" AS ENUM('requested', 'approved', 'rejected', 'cancelled', 'expired', 'revoked', 'disclosed');--> statement-breakpoint
CREATE TYPE "public"."connection_status" AS ENUM('pending', 'approved', 'rejected', 'cancelled', 'expired', 'revoked');--> statement-breakpoint
CREATE TYPE "public"."disclosure_level" AS ENUM('partner', 'partner_contact');--> statement-breakpoint
CREATE TABLE "connection_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"connection_request_id" uuid NOT NULL,
	"type" "connection_event_type" NOT NULL,
	"actor_tenant_id" uuid,
	"actor_user_id" uuid,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "connection_requests" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"property_id" uuid NOT NULL,
	"requester_tenant_id" uuid NOT NULL,
	"requester_user_id" uuid NOT NULL,
	"owner_tenant_id" uuid NOT NULL,
	"status" "connection_status" DEFAULT 'pending' NOT NULL,
	"disclosure_level" "disclosure_level" DEFAULT 'partner_contact' NOT NULL,
	"message" text,
	"decision_note" text,
	"decided_by_user_id" uuid,
	"decided_at" timestamp with time zone,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "connection_events" ADD CONSTRAINT "connection_events_connection_request_id_connection_requests_id_fk" FOREIGN KEY ("connection_request_id") REFERENCES "public"."connection_requests"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "connection_events" ADD CONSTRAINT "connection_events_actor_tenant_id_tenants_id_fk" FOREIGN KEY ("actor_tenant_id") REFERENCES "public"."tenants"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "connection_events" ADD CONSTRAINT "connection_events_actor_user_id_users_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "connection_requests" ADD CONSTRAINT "connection_requests_property_id_properties_id_fk" FOREIGN KEY ("property_id") REFERENCES "public"."properties"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "connection_requests" ADD CONSTRAINT "connection_requests_requester_tenant_id_tenants_id_fk" FOREIGN KEY ("requester_tenant_id") REFERENCES "public"."tenants"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "connection_requests" ADD CONSTRAINT "connection_requests_requester_user_id_users_id_fk" FOREIGN KEY ("requester_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "connection_requests" ADD CONSTRAINT "connection_requests_owner_tenant_id_tenants_id_fk" FOREIGN KEY ("owner_tenant_id") REFERENCES "public"."tenants"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "connection_requests" ADD CONSTRAINT "connection_requests_decided_by_user_id_users_id_fk" FOREIGN KEY ("decided_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "connection_events_request_idx" ON "connection_events" USING btree ("connection_request_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "connection_requests_pending_key" ON "connection_requests" USING btree ("property_id","requester_tenant_id") WHERE status = 'pending';--> statement-breakpoint
CREATE INDEX "connection_requests_owner_idx" ON "connection_requests" USING btree ("owner_tenant_id","status","created_at");--> statement-breakpoint
CREATE INDEX "connection_requests_requester_idx" ON "connection_requests" USING btree ("requester_tenant_id","status","created_at");