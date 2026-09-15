CREATE TYPE "public"."media_kind" AS ENUM('photo', 'floor_plan', 'video', 'tour');--> statement-breakpoint
CREATE TYPE "public"."property_purpose" AS ENUM('sale', 'rent', 'sale_rent');--> statement-breakpoint
CREATE TYPE "public"."property_status" AS ENUM('draft', 'active', 'reserved', 'sold_rented', 'archived');--> statement-breakpoint
CREATE TYPE "public"."property_type" AS ENUM('apartamento', 'casa', 'casa_condominio', 'terreno', 'sala_comercial', 'galpao', 'loja', 'sitio_chacara', 'outro');--> statement-breakpoint
CREATE TYPE "public"."tenant_status" AS ENUM('pending', 'active', 'suspended');--> statement-breakpoint
CREATE TYPE "public"."user_role" AS ENUM('partner_admin', 'partner_agent', 'platform_admin');--> statement-breakpoint
CREATE TYPE "public"."user_status" AS ENUM('active', 'disabled');--> statement-breakpoint
CREATE TABLE "tenants" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"legal_name" text NOT NULL,
	"display_name" text NOT NULL,
	"slug" text NOT NULL,
	"status" "tenant_status" DEFAULT 'pending' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "refresh_tokens" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"token_hash" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"revoked_at" timestamp with time zone,
	"user_agent" text,
	"ip" "inet",
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid,
	"email" "citext" NOT NULL,
	"password_hash" text NOT NULL,
	"name" text NOT NULL,
	"phone" text,
	"role" "user_role" DEFAULT 'partner_agent' NOT NULL,
	"status" "user_status" DEFAULT 'active' NOT NULL,
	"token_version" integer DEFAULT 0 NOT NULL,
	"last_login_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "cities" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"uf" char(2) NOT NULL,
	"name" text NOT NULL,
	"slug" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "neighborhood_aliases" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"city_id" uuid NOT NULL,
	"neighborhood_id" uuid NOT NULL,
	"alias_slug" text NOT NULL,
	"source" text DEFAULT 'manual' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "neighborhoods" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"city_id" uuid NOT NULL,
	"zone_id" uuid,
	"name" text NOT NULL,
	"slug" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "zones" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"city_id" uuid NOT NULL,
	"name" text NOT NULL,
	"slug" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "properties" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"reference_code" text,
	"title" text NOT NULL,
	"description" text,
	"purpose" "property_purpose" DEFAULT 'sale' NOT NULL,
	"type" "property_type" NOT NULL,
	"status" "property_status" DEFAULT 'draft' NOT NULL,
	"city_id" uuid NOT NULL,
	"neighborhood_id" uuid NOT NULL,
	"zone_id" uuid,
	"street" text,
	"street_number" text,
	"complement" text,
	"zip" text,
	"latitude" numeric(10, 7),
	"longitude" numeric(10, 7),
	"bedrooms" smallint DEFAULT 0 NOT NULL,
	"suites" smallint DEFAULT 0 NOT NULL,
	"bathrooms" smallint DEFAULT 0 NOT NULL,
	"parking_spots" smallint DEFAULT 0 NOT NULL,
	"area_total" numeric(10, 2),
	"area_built" numeric(10, 2),
	"price_cents" bigint,
	"condo_fee_cents" bigint,
	"iptu_cents" bigint,
	"currency" text DEFAULT 'BRL' NOT NULL,
	"accepts_exchange" boolean DEFAULT false NOT NULL,
	"is_exclusive" boolean DEFAULT false NOT NULL,
	"published_to_network" boolean DEFAULT true NOT NULL,
	"external_source" text,
	"external_id" text,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "property_media" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"property_id" uuid NOT NULL,
	"storage_key" text NOT NULL,
	"kind" "media_kind" DEFAULT 'photo' NOT NULL,
	"position" integer DEFAULT 0 NOT NULL,
	"width" integer,
	"height" integer,
	"byte_size" integer,
	"content_type" text,
	"sanitized_at" timestamp with time zone,
	"original_filename" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "audit_log" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"tenant_id" uuid,
	"actor_user_id" uuid,
	"action" text NOT NULL,
	"entity_type" text,
	"entity_id" uuid,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"ip" "inet",
	"user_agent" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "refresh_tokens" ADD CONSTRAINT "refresh_tokens_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "neighborhood_aliases" ADD CONSTRAINT "neighborhood_aliases_city_id_cities_id_fk" FOREIGN KEY ("city_id") REFERENCES "public"."cities"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "neighborhood_aliases" ADD CONSTRAINT "neighborhood_aliases_neighborhood_id_neighborhoods_id_fk" FOREIGN KEY ("neighborhood_id") REFERENCES "public"."neighborhoods"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "neighborhoods" ADD CONSTRAINT "neighborhoods_city_id_cities_id_fk" FOREIGN KEY ("city_id") REFERENCES "public"."cities"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "neighborhoods" ADD CONSTRAINT "neighborhoods_zone_id_zones_id_fk" FOREIGN KEY ("zone_id") REFERENCES "public"."zones"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "zones" ADD CONSTRAINT "zones_city_id_cities_id_fk" FOREIGN KEY ("city_id") REFERENCES "public"."cities"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "properties" ADD CONSTRAINT "properties_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "properties" ADD CONSTRAINT "properties_city_id_cities_id_fk" FOREIGN KEY ("city_id") REFERENCES "public"."cities"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "properties" ADD CONSTRAINT "properties_neighborhood_id_neighborhoods_id_fk" FOREIGN KEY ("neighborhood_id") REFERENCES "public"."neighborhoods"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "properties" ADD CONSTRAINT "properties_zone_id_zones_id_fk" FOREIGN KEY ("zone_id") REFERENCES "public"."zones"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "properties" ADD CONSTRAINT "properties_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "property_media" ADD CONSTRAINT "property_media_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "property_media" ADD CONSTRAINT "property_media_property_id_properties_id_fk" FOREIGN KEY ("property_id") REFERENCES "public"."properties"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "tenants_slug_key" ON "tenants" USING btree ("slug");--> statement-breakpoint
CREATE UNIQUE INDEX "refresh_tokens_hash_key" ON "refresh_tokens" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX "refresh_tokens_user_idx" ON "refresh_tokens" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "users_email_key" ON "users" USING btree ("email");--> statement-breakpoint
CREATE INDEX "users_tenant_idx" ON "users" USING btree ("tenant_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "cities_uf_slug_key" ON "cities" USING btree ("uf","slug");--> statement-breakpoint
CREATE UNIQUE INDEX "neighborhood_aliases_city_alias_key" ON "neighborhood_aliases" USING btree ("city_id","alias_slug");--> statement-breakpoint
CREATE INDEX "neighborhood_aliases_neighborhood_idx" ON "neighborhood_aliases" USING btree ("neighborhood_id");--> statement-breakpoint
CREATE UNIQUE INDEX "neighborhoods_city_slug_key" ON "neighborhoods" USING btree ("city_id","slug");--> statement-breakpoint
CREATE INDEX "neighborhoods_zone_idx" ON "neighborhoods" USING btree ("zone_id");--> statement-breakpoint
CREATE UNIQUE INDEX "zones_city_slug_key" ON "zones" USING btree ("city_id","slug");--> statement-breakpoint
CREATE INDEX "properties_tenant_idx" ON "properties" USING btree ("tenant_id","status");--> statement-breakpoint
CREATE INDEX "properties_network_idx" ON "properties" USING btree ("neighborhood_id","type","price_cents") WHERE deleted_at IS NULL AND status = 'active' AND published_to_network;--> statement-breakpoint
CREATE INDEX "properties_network_zone_idx" ON "properties" USING btree ("zone_id") WHERE deleted_at IS NULL AND status = 'active' AND published_to_network;--> statement-breakpoint
CREATE INDEX "properties_filters_idx" ON "properties" USING btree ("type","bedrooms","price_cents");--> statement-breakpoint
CREATE UNIQUE INDEX "properties_external_key" ON "properties" USING btree ("tenant_id","external_source","external_id") WHERE external_id IS NOT NULL;--> statement-breakpoint
CREATE INDEX "property_media_property_idx" ON "property_media" USING btree ("property_id","position");--> statement-breakpoint
CREATE INDEX "property_media_tenant_idx" ON "property_media" USING btree ("tenant_id");--> statement-breakpoint
CREATE UNIQUE INDEX "property_media_storage_key_key" ON "property_media" USING btree ("storage_key");--> statement-breakpoint
CREATE INDEX "audit_log_tenant_idx" ON "audit_log" USING btree ("tenant_id","created_at");--> statement-breakpoint
CREATE INDEX "audit_log_entity_idx" ON "audit_log" USING btree ("entity_type","entity_id");--> statement-breakpoint
CREATE INDEX "audit_log_action_idx" ON "audit_log" USING btree ("action","created_at");