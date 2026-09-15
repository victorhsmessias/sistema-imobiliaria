CREATE TYPE "public"."import_format" AS ENUM('vrsync');--> statement-breakpoint
CREATE TYPE "public"."import_item_status" AS ENUM('created', 'updated', 'unchanged', 'archived', 'skipped', 'needs_curation', 'failed');--> statement-breakpoint
CREATE TYPE "public"."import_job_status" AS ENUM('queued', 'running', 'succeeded', 'failed');--> statement-breakpoint
CREATE TABLE "import_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"job_id" uuid NOT NULL,
	"external_id" text,
	"property_id" uuid,
	"status" "import_item_status" NOT NULL,
	"changes" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"warnings" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"errors" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"raw_payload" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "import_jobs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"source_id" uuid NOT NULL,
	"status" "import_job_status" DEFAULT 'queued' NOT NULL,
	"dry_run" boolean NOT NULL,
	"stats" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"error" text,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "import_sources" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"name" text NOT NULL,
	"format" "import_format" DEFAULT 'vrsync' NOT NULL,
	"feed_url" text,
	"publish_to_network" boolean DEFAULT true NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"last_run_at" timestamp with time zone,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "property_type_mappings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"source_key" text NOT NULL,
	"type" "property_type" NOT NULL,
	"source" text DEFAULT 'manual' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "properties" ADD COLUMN "sale_price_cents" bigint;--> statement-breakpoint
ALTER TABLE "properties" ADD COLUMN "rent_price_cents" bigint;--> statement-breakpoint
ALTER TABLE "property_media" ADD COLUMN "source_url" text;--> statement-breakpoint
ALTER TABLE "property_media" ADD COLUMN "source_url_hash" text;--> statement-breakpoint
ALTER TABLE "property_media" ADD COLUMN "content_sha256" text;--> statement-breakpoint
ALTER TABLE "property_media" ADD COLUMN "caption" text;--> statement-breakpoint
ALTER TABLE "import_items" ADD CONSTRAINT "import_items_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "import_items" ADD CONSTRAINT "import_items_job_id_import_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."import_jobs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "import_items" ADD CONSTRAINT "import_items_property_id_properties_id_fk" FOREIGN KEY ("property_id") REFERENCES "public"."properties"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "import_jobs" ADD CONSTRAINT "import_jobs_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "import_jobs" ADD CONSTRAINT "import_jobs_source_id_import_sources_id_fk" FOREIGN KEY ("source_id") REFERENCES "public"."import_sources"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "import_jobs" ADD CONSTRAINT "import_jobs_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "import_sources" ADD CONSTRAINT "import_sources_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "import_sources" ADD CONSTRAINT "import_sources_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "import_items_job_idx" ON "import_items" USING btree ("job_id","status");--> statement-breakpoint
CREATE INDEX "import_jobs_source_idx" ON "import_jobs" USING btree ("source_id","created_at");--> statement-breakpoint
CREATE INDEX "import_sources_tenant_idx" ON "import_sources" USING btree ("tenant_id");--> statement-breakpoint
CREATE UNIQUE INDEX "property_type_mappings_source_key_key" ON "property_type_mappings" USING btree ("source_key");--> statement-breakpoint
CREATE INDEX "property_media_source_idx" ON "property_media" USING btree ("property_id","source_url_hash");--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- Escrito a mao: copia de price_cents para as colunas de venda e aluguel.
--
-- properties tem FORCE ROW LEVEL SECURITY. Sem desligar o FORCE, este UPDATE
-- rodaria como app_migrator sem tenant no contexto e afetaria ZERO linhas, sem
-- erro nenhum. O FORCE e religado ao fim deste arquivo, na mesma transacao, e
-- sql/10_security.sql o reaplica de novo logo depois.
-- ---------------------------------------------------------------------------
ALTER TABLE "properties" NO FORCE ROW LEVEL SECURITY;--> statement-breakpoint
UPDATE "properties" SET "sale_price_cents" = "price_cents"
 WHERE "purpose" IN ('sale', 'sale_rent') AND "price_cents" IS NOT NULL;--> statement-breakpoint
UPDATE "properties" SET "rent_price_cents" = "price_cents"
 WHERE "purpose" = 'rent' AND "price_cents" IS NOT NULL;--> statement-breakpoint
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM "properties"
     WHERE "price_cents" IS NOT NULL
       AND "sale_price_cents" IS NULL
       AND "rent_price_cents" IS NULL
  ) THEN
    RAISE EXCEPTION '0002: preco sem destino na copia para sale/rent_price_cents. Nada foi aplicado.';
  END IF;
END
$$;--> statement-breakpoint
ALTER TABLE "properties" FORCE ROW LEVEL SECURITY;--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- Traducao padrao de PropertyType (VrSync e grafias em portugues de sistemas
-- legados). A chave e o slug do ultimo segmento: "Residential / Apartment" e
-- procurado como "residential-apartment" e depois como "apartment".
--
-- Tipos sem equivalente exato vao para o tipo da plataforma mais proximo que
-- o corretor usaria no filtro: cobertura, kitnet, studio e flat SAO
-- apartamentos; sobrado E casa. O que nao casar com nada vira "outro" e sai
-- como aviso no relatorio da importacao.
-- ---------------------------------------------------------------------------
INSERT INTO "property_type_mappings" ("source_key", "type", "source") VALUES
  ('apartment', 'apartamento', 'seed'),
  ('apartamento', 'apartamento', 'seed'),
  ('penthouse', 'apartamento', 'seed'),
  ('cobertura', 'apartamento', 'seed'),
  ('flat', 'apartamento', 'seed'),
  ('kitnet', 'apartamento', 'seed'),
  ('kitchenette', 'apartamento', 'seed'),
  ('studio', 'apartamento', 'seed'),
  ('loft', 'apartamento', 'seed'),
  ('home', 'casa', 'seed'),
  ('house', 'casa', 'seed'),
  ('casa', 'casa', 'seed'),
  ('sobrado', 'casa', 'seed'),
  ('condo', 'casa_condominio', 'seed'),
  ('village-house', 'casa_condominio', 'seed'),
  ('casa-de-condominio', 'casa_condominio', 'seed'),
  ('casa-em-condominio', 'casa_condominio', 'seed'),
  ('land-lot', 'terreno', 'seed'),
  ('terreno', 'terreno', 'seed'),
  ('lote', 'terreno', 'seed'),
  ('farm-ranch', 'sitio_chacara', 'seed'),
  ('agricultural', 'sitio_chacara', 'seed'),
  ('chacara', 'sitio_chacara', 'seed'),
  ('sitio', 'sitio_chacara', 'seed'),
  ('fazenda', 'sitio_chacara', 'seed'),
  ('office', 'sala_comercial', 'seed'),
  ('consultorio', 'sala_comercial', 'seed'),
  ('corporate-floor', 'sala_comercial', 'seed'),
  ('sala-comercial', 'sala_comercial', 'seed'),
  ('conjunto-comercial', 'sala_comercial', 'seed'),
  ('business', 'loja', 'seed'),
  ('loja', 'loja', 'seed'),
  ('ponto-comercial', 'loja', 'seed'),
  ('industrial', 'galpao', 'seed'),
  ('warehouse', 'galpao', 'seed'),
  ('galpao', 'galpao', 'seed')
ON CONFLICT ("source_key") DO NOTHING;