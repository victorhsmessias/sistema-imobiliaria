-- ===========================================================================
-- Bootstrap de roles. Roda UMA vez por banco, com credencial administrativa.
--
--   dev : montado em /docker-entrypoint-initdb.d pelo docker-compose.dev.yml
--   prod: executar manualmente com o superusuario do Postgres antes do
--         primeiro deploy (psql -f 00_bootstrap_roles.sql)
--
-- ATENCAO EM PRODUCAO: as senhas abaixo sao de DESENVOLVIMENTO e estao no
-- repositorio. Logo apos rodar este arquivo em producao, troque as duas com
-- ALTER ROLE ... PASSWORD (o passo esta em docs/deploy.md). Enquanto nao
-- trocar, qualquer pessoa que ja leu o repositorio conhece a credencial do
-- banco -- e app_migrator ignora as policies de RLS ao escrever.
--
-- ---------------------------------------------------------------------------
-- Tres roles, e o motivo de cada um:
--
--   app_migrator       dono das tabelas, roda migrations. SEM BYPASSRLS.
--                      Como usamos FORCE ROW LEVEL SECURITY, ate ele fica
--                      sujeito as policies ao ler dados -- de proposito.
--
--   app_user           runtime da aplicacao. Sujeito a RLS. E a unica
--                      credencial que a API recebe.
--
--   app_network_reader NOLOGIN, BYPASSRLS. Existe para ser dono das duas
--                      views de busca cross-tenant, e de nada mais.
--
-- Por que app_network_reader precisa existir:
--   A busca da rede e, por definicao, uma leitura cross-tenant -- ela tem que
--   atravessar o RLS. Em vez de enfraquecer as policies para permitir isso,
--   concentramos a travessia num unico ponto: uma view com lista EXPLICITA de
--   colunas, cujo dono tem bypass. O bypass existe, mas passa por um funil
--   estreito e auditavel, em vez de ficar espalhado pela aplicacao.
--
--   Atributos de role (BYPASSRLS, SUPERUSER) NAO sao herdados por membership,
--   entao app_migrator ser membro de app_network_reader nao lhe da bypass.
-- ---------------------------------------------------------------------------

\set ON_ERROR_STOP on

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_migrator') THEN
    CREATE ROLE app_migrator LOGIN PASSWORD 'app_migrator_dev';
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_user') THEN
    CREATE ROLE app_user LOGIN PASSWORD 'app_user_dev';
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_network_reader') THEN
    CREATE ROLE app_network_reader NOLOGIN;
  END IF;
END
$$;

-- Garantias explicitas de atributo. Nao dependa do default.
ALTER ROLE app_migrator       NOSUPERUSER NOBYPASSRLS NOCREATEROLE NOCREATEDB;
ALTER ROLE app_user           NOSUPERUSER NOBYPASSRLS NOCREATEROLE NOCREATEDB;
ALTER ROLE app_network_reader NOSUPERUSER   BYPASSRLS NOCREATEROLE NOCREATEDB NOLOGIN;

-- Para poder fazer ALTER VIEW ... OWNER TO app_network_reader nas migrations.
GRANT app_network_reader TO app_migrator;

GRANT CREATE, USAGE ON SCHEMA public TO app_migrator;
GRANT USAGE ON SCHEMA public TO app_user;
-- CREATE (e nao so USAGE) porque o Postgres exige que o NOVO dono de um
-- objeto tenha CREATE no schema que o contem: sem isso o
-- "ALTER VIEW network_listings OWNER TO app_network_reader" e recusado.
GRANT CREATE, USAGE ON SCHEMA public TO app_network_reader;

-- CREATE no banco: o migrator do drizzle cria o schema "drizzle" para guardar
-- o journal de migrations aplicadas. Nome do banco vem de current_database()
-- para o arquivo funcionar em dev e em producao sem edicao.
DO $$
BEGIN
  EXECUTE format('GRANT CONNECT, CREATE, TEMPORARY ON DATABASE %I TO app_migrator', current_database());
  EXECUTE format('GRANT CONNECT ON DATABASE %I TO app_user', current_database());
  EXECUTE format('GRANT CONNECT ON DATABASE %I TO app_network_reader', current_database());
END
$$;

-- Extensoes exigem privilegio elevado: criadas aqui, nao na migration.
CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE EXTENSION IF NOT EXISTS unaccent;
CREATE EXTENSION IF NOT EXISTS citext;

-- Rede de seguranca: objetos futuros do migrator ja nascem acessiveis.
-- As migrations ainda fazem GRANT explicito (ver sql/10_security.sql).
ALTER DEFAULT PRIVILEGES FOR ROLE app_migrator IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO app_user;
ALTER DEFAULT PRIVILEGES FOR ROLE app_migrator IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO app_user;
