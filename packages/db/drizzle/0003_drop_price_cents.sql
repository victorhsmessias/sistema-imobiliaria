-- Remocao de price_cents, ja copiado para sale_price_cents / rent_price_cents
-- pela 0002.
--
-- Escrita a mao sobre o que o drizzle-kit gerou: a versao gerada fazia
-- DROP COLUMN com a view network_listings ainda dependendo da coluna. Mesmo
-- padrao da 0001: DROP VIEW -> trava -> DROP COLUMN. As views sao recriadas
-- por sql/10_security.sql, que src/migrate.ts roda depois das migrations.

DROP VIEW IF EXISTS network_listing_media;--> statement-breakpoint
DROP VIEW IF EXISTS network_listings;--> statement-breakpoint

DROP INDEX IF EXISTS "properties_network_idx";--> statement-breakpoint
DROP INDEX IF EXISTS "properties_filters_idx";--> statement-breakpoint
CREATE INDEX "properties_network_rent_idx" ON "properties" USING btree ("neighborhood_id","type","rent_price_cents") WHERE deleted_at IS NULL AND status = 'active' AND published_to_network;--> statement-breakpoint
CREATE INDEX "properties_network_idx" ON "properties" USING btree ("neighborhood_id","type","sale_price_cents") WHERE deleted_at IS NULL AND status = 'active' AND published_to_network;--> statement-breakpoint
CREATE INDEX "properties_filters_idx" ON "properties" USING btree ("type","bedrooms");--> statement-breakpoint

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_views
     WHERE schemaname = 'public'
       AND viewname IN ('network_listings', 'network_listing_media')
  ) THEN
    RAISE EXCEPTION
      '0003_drop_price_cents: views de busca ainda existem. DROP VIEW precisa rodar antes do DROP COLUMN price_cents.';
  END IF;
END
$$;--> statement-breakpoint

ALTER TABLE "properties" DROP COLUMN "price_cents";
