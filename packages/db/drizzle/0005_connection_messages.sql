CREATE TABLE "connection_message_reads" (
	"connection_request_id" uuid NOT NULL,
	"tenant_id" uuid NOT NULL,
	"last_read_at" timestamp with time zone NOT NULL,
	CONSTRAINT "connection_message_reads_connection_request_id_tenant_id_pk" PRIMARY KEY("connection_request_id","tenant_id")
);
--> statement-breakpoint
CREATE TABLE "connection_messages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"connection_request_id" uuid NOT NULL,
	"sender_tenant_id" uuid NOT NULL,
	"sender_user_id" uuid,
	"body" text NOT NULL,
	"body_original" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "connection_messages_body_length" CHECK (char_length("connection_messages"."body") BETWEEN 1 AND 8000)
);
--> statement-breakpoint
ALTER TABLE "connection_message_reads" ADD CONSTRAINT "connection_message_reads_connection_request_id_connection_requests_id_fk" FOREIGN KEY ("connection_request_id") REFERENCES "public"."connection_requests"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "connection_message_reads" ADD CONSTRAINT "connection_message_reads_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "connection_messages" ADD CONSTRAINT "connection_messages_connection_request_id_connection_requests_id_fk" FOREIGN KEY ("connection_request_id") REFERENCES "public"."connection_requests"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "connection_messages" ADD CONSTRAINT "connection_messages_sender_tenant_id_tenants_id_fk" FOREIGN KEY ("sender_tenant_id") REFERENCES "public"."tenants"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "connection_messages" ADD CONSTRAINT "connection_messages_sender_user_id_users_id_fk" FOREIGN KEY ("sender_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "connection_messages_request_idx" ON "connection_messages" USING btree ("connection_request_id","created_at","id");