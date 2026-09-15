-- Remocao do agrupamento por zona: bairro e a unica localizacao da rede.
--
-- Escrita a mao sobre o que o drizzle-kit gerou, porque a versao gerada nao
-- aplicava. Dois problemas:
--
--  1. As views de busca dependem de properties.zone_id. Sem derruba-las antes,
--     o DROP COLUMN falha. As duas views sao recriadas logo em seguida por
--     sql/10_security.sql, que src/migrate.ts roda depois das migrations.
--  2. `DROP TABLE zones CASCADE` vinha primeiro e levava as FKs junto; os
--     DROP CONSTRAINT seguintes quebravam por constraint inexistente.
--
-- Ordem obrigatoria: DROP VIEW -> indices -> FKs -> DROP COLUMN -> DROP TABLE.
-- A trava antes do DROP COLUMN aborta a migration inteira (o migrator roda em
-- transacao) se alguem reordenar este arquivo e as views ainda existirem.

DROP VIEW IF EXISTS network_listing_media;--> statement-breakpoint
DROP VIEW IF EXISTS network_listings;--> statement-breakpoint

DROP INDEX IF EXISTS "properties_network_zone_idx";--> statement-breakpoint
DROP INDEX IF EXISTS "neighborhoods_zone_idx";--> statement-breakpoint

ALTER TABLE "properties" DROP CONSTRAINT IF EXISTS "properties_zone_id_zones_id_fk";--> statement-breakpoint
ALTER TABLE "neighborhoods" DROP CONSTRAINT IF EXISTS "neighborhoods_zone_id_zones_id_fk";--> statement-breakpoint

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_views
     WHERE schemaname = 'public'
       AND viewname IN ('network_listings', 'network_listing_media')
  ) THEN
    RAISE EXCEPTION
      '0001_remove_zones: views de busca ainda existem. DROP VIEW precisa rodar antes do DROP COLUMN zone_id.';
  END IF;
END
$$;--> statement-breakpoint

ALTER TABLE "properties" DROP COLUMN "zone_id";--> statement-breakpoint
ALTER TABLE "neighborhoods" DROP COLUMN "zone_id";--> statement-breakpoint

-- Sem CASCADE: se ainda sobrar algo apontando para zones, a migration deve
-- falhar alto em vez de apagar dependencia que ninguem conferiu.
DROP TABLE "zones";
