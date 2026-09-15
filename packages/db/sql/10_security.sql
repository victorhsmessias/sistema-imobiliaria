-- ===========================================================================
-- Objetos de seguranca: policies de RLS, views de busca e funcoes de auth.
--
-- Roda como app_migrator, DEPOIS das migrations do drizzle, a cada `db:migrate`.
-- Tudo aqui e idempotente (DROP IF EXISTS + CREATE), de proposito: as policies
-- nunca ficam fora de sincronia com este arquivo, e este arquivo e a unica
-- fonte de verdade sobre quem enxerga o que.
--
-- Regra de revisao: qualquer PR que toque este arquivo exige revisao de um
-- segundo par de olhos. E aqui que a anonimizacao vive.
--
-- Executado pelo driver node-postgres (src/migrate.ts), nao pelo psql:
-- nao use meta-comandos de psql (\set, \i, \echo) neste arquivo.
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- Contexto de tenant
-- ---------------------------------------------------------------------------
-- A aplicacao injeta o tenant por transacao com:
--     SELECT set_config('app.tenant_id', $1, true)
--
-- O `true` final torna o valor LOCAL a transacao -- ele nao vaza para a
-- proxima request que pegar a mesma conexao do pool. Isso e essencial: com
-- pool, uma conexao e reusada entre tenants diferentes o tempo todo.
--
-- Quando nao setado, current_setting(..., true) devolve NULL, a comparacao
-- vira NULL, e nenhuma linha casa. Ou seja: ESQUECER de setar o tenant
-- resulta em zero linhas, nunca em todas as linhas. Fail-closed.
CREATE OR REPLACE FUNCTION app_current_tenant() RETURNS uuid
  LANGUAGE sql
  STABLE
  SET search_path = public, pg_temp
AS $$
  SELECT nullif(current_setting('app.tenant_id', true), '')::uuid;
$$;

COMMENT ON FUNCTION app_current_tenant() IS
  'Tenant da transacao corrente. NULL quando nao setado -- policies entao nao casam com nada (fail-closed).';


-- ---------------------------------------------------------------------------
-- RLS: tenants
-- ---------------------------------------------------------------------------
-- Sem FORCE: o dono (app_migrator) precisa administrar parceiros e rodar seed.
ALTER TABLE tenants ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenants_self_select ON tenants;
CREATE POLICY tenants_self_select ON tenants
  FOR SELECT TO app_user
  USING (id = app_current_tenant());

DROP POLICY IF EXISTS tenants_self_update ON tenants;
CREATE POLICY tenants_self_update ON tenants
  FOR UPDATE TO app_user
  USING (id = app_current_tenant())
  WITH CHECK (id = app_current_tenant());
-- Sem policy de INSERT/DELETE: criar ou remover parceiro nao passa pela API.


-- ---------------------------------------------------------------------------
-- RLS: users
-- ---------------------------------------------------------------------------
ALTER TABLE users ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS users_tenant_all ON users;
CREATE POLICY users_tenant_all ON users
  FOR ALL TO app_user
  USING (tenant_id = app_current_tenant())
  WITH CHECK (tenant_id = app_current_tenant());
-- O login acontece ANTES de existir tenant no contexto, entao ele nao passa
-- por esta policy -- passa por auth_find_user_by_email() la embaixo.


-- ---------------------------------------------------------------------------
-- RLS: properties  (FORCE)
-- ---------------------------------------------------------------------------
-- FORCE aplica as policies inclusive ao dono da tabela. Consequencia pratica:
-- o seed tambem precisa setar app.tenant_id antes de inserir, o que faz do
-- proprio seed uma prova de que as policies funcionam.
ALTER TABLE properties ENABLE ROW LEVEL SECURITY;
ALTER TABLE properties FORCE  ROW LEVEL SECURITY;
DROP POLICY IF EXISTS properties_tenant_all ON properties;
CREATE POLICY properties_tenant_all ON properties
  FOR ALL
  USING (tenant_id = app_current_tenant())
  WITH CHECK (tenant_id = app_current_tenant());


-- ---------------------------------------------------------------------------
-- RLS: property_media  (FORCE)
-- ---------------------------------------------------------------------------
ALTER TABLE property_media ENABLE ROW LEVEL SECURITY;
ALTER TABLE property_media FORCE  ROW LEVEL SECURITY;
DROP POLICY IF EXISTS property_media_tenant_all ON property_media;
CREATE POLICY property_media_tenant_all ON property_media
  FOR ALL
  USING (tenant_id = app_current_tenant())
  WITH CHECK (tenant_id = app_current_tenant());


-- ---------------------------------------------------------------------------
-- RLS: importacao XML  (FORCE)
-- ---------------------------------------------------------------------------
-- Tudo aqui identifica o dono: a URL do feed e o dominio da imobiliaria, e o
-- payload bruto de cada anuncio traz ContactInfo, endereco e as URLs
-- originais das fotos. Mesmo tratamento de properties.
ALTER TABLE import_sources ENABLE ROW LEVEL SECURITY;
ALTER TABLE import_sources FORCE  ROW LEVEL SECURITY;
DROP POLICY IF EXISTS import_sources_tenant_all ON import_sources;
CREATE POLICY import_sources_tenant_all ON import_sources
  FOR ALL
  USING (tenant_id = app_current_tenant())
  WITH CHECK (tenant_id = app_current_tenant());

ALTER TABLE import_jobs ENABLE ROW LEVEL SECURITY;
ALTER TABLE import_jobs FORCE  ROW LEVEL SECURITY;
DROP POLICY IF EXISTS import_jobs_tenant_all ON import_jobs;
CREATE POLICY import_jobs_tenant_all ON import_jobs
  FOR ALL
  USING (tenant_id = app_current_tenant())
  WITH CHECK (tenant_id = app_current_tenant());

ALTER TABLE import_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE import_items FORCE  ROW LEVEL SECURITY;
DROP POLICY IF EXISTS import_items_tenant_all ON import_items;
CREATE POLICY import_items_tenant_all ON import_items
  FOR ALL
  USING (tenant_id = app_current_tenant())
  WITH CHECK (tenant_id = app_current_tenant());


-- ---------------------------------------------------------------------------
-- RLS: audit_log  (append-only)
-- ---------------------------------------------------------------------------
-- Nao existe policy de UPDATE nem de DELETE, e os privilegios sao revogados
-- abaixo. Trilha de auditoria que a aplicacao consegue reescrever nao e
-- trilha de auditoria.
ALTER TABLE audit_log ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS audit_log_tenant_select ON audit_log;
CREATE POLICY audit_log_tenant_select ON audit_log
  FOR SELECT TO app_user
  USING (tenant_id = app_current_tenant());

DROP POLICY IF EXISTS audit_log_tenant_insert ON audit_log;
CREATE POLICY audit_log_tenant_insert ON audit_log
  FOR INSERT TO app_user
  WITH CHECK (tenant_id = app_current_tenant() OR tenant_id IS NULL);


-- ---------------------------------------------------------------------------
-- RLS: refresh_tokens  (sem acesso direto)
-- ---------------------------------------------------------------------------
-- app_user nao recebe privilegio nenhum nesta tabela. Todo acesso passa pelas
-- funcoes SECURITY DEFINER abaixo. Beneficio concreto: mesmo uma falha grave
-- de SQL injection numa rota autenticada nao consegue ler nem forjar tokens.
ALTER TABLE refresh_tokens ENABLE ROW LEVEL SECURITY;
ALTER TABLE refresh_tokens FORCE  ROW LEVEL SECURITY;


-- ===========================================================================
-- Funcoes de autenticacao (SECURITY DEFINER)
--
-- Estas funcoes atravessam o RLS de proposito: no momento do login ainda nao
-- existe tenant no contexto -- descobrir qual e o tenant e justamente o que o
-- login faz. Todas sao owned por app_network_reader (o role de bypass),
-- tem search_path fixo e recebem EXECUTE apenas de app_user.
-- ===========================================================================

-- CREATE OR REPLACE nao muda tipo de retorno. Como este arquivo e reaplicado
-- a cada migrate e as assinaturas evoluem, dropamos antes de recriar.
DROP FUNCTION IF EXISTS auth_find_user_by_email(citext);
DROP FUNCTION IF EXISTS auth_find_user_by_id(uuid);

CREATE FUNCTION auth_find_user_by_email(p_email citext)
RETURNS TABLE (
  id                  uuid,
  tenant_id           uuid,
  email               citext,
  password_hash       text,
  name                text,
  role                user_role,
  status              user_status,
  token_version       integer,
  tenant_status       tenant_status,
  tenant_display_name text,
  tenant_slug         text
)
  LANGUAGE sql
  STABLE
  SECURITY DEFINER
  SET search_path = public, pg_temp
AS $$
  SELECT u.id, u.tenant_id, u.email, u.password_hash, u.name, u.role,
         u.status, u.token_version, t.status, t.display_name, t.slug
  FROM users u
  LEFT JOIN tenants t ON t.id = u.tenant_id
  WHERE u.email = p_email;
$$;

CREATE FUNCTION auth_find_user_by_id(p_user_id uuid)
RETURNS TABLE (
  id                  uuid,
  tenant_id           uuid,
  email               citext,
  name                text,
  role                user_role,
  status              user_status,
  token_version       integer,
  tenant_status       tenant_status,
  tenant_display_name text,
  tenant_slug         text
)
  LANGUAGE sql
  STABLE
  SECURITY DEFINER
  SET search_path = public, pg_temp
AS $$
  SELECT u.id, u.tenant_id, u.email, u.name, u.role,
         u.status, u.token_version, t.status, t.display_name, t.slug
  FROM users u
  LEFT JOIN tenants t ON t.id = u.tenant_id
  WHERE u.id = p_user_id;
$$;

CREATE OR REPLACE FUNCTION auth_touch_last_login(p_user_id uuid)
RETURNS void
  LANGUAGE sql
  SECURITY DEFINER
  SET search_path = public, pg_temp
AS $$
  UPDATE users SET last_login_at = now() WHERE id = p_user_id;
$$;

CREATE OR REPLACE FUNCTION auth_issue_refresh_token(
  p_user_id    uuid,
  p_token_hash text,
  p_expires_at timestamptz,
  p_user_agent text DEFAULT NULL,
  p_ip         inet DEFAULT NULL
)
RETURNS uuid
  LANGUAGE sql
  SECURITY DEFINER
  SET search_path = public, pg_temp
AS $$
  INSERT INTO refresh_tokens (user_id, token_hash, expires_at, user_agent, ip)
  VALUES (p_user_id, p_token_hash, p_expires_at, p_user_agent, p_ip)
  RETURNING id;
$$;

-- Consome o token e o invalida no mesmo comando (rotacao de uso unico).
-- Se dois requests chegarem com o mesmo refresh token, apenas um recebe
-- linha de volta -- o outro ve zero linhas e e tratado como replay.
CREATE OR REPLACE FUNCTION auth_consume_refresh_token(p_token_hash text)
RETURNS TABLE (user_id uuid, token_id uuid)
  LANGUAGE sql
  SECURITY DEFINER
  SET search_path = public, pg_temp
AS $$
  UPDATE refresh_tokens
     SET revoked_at = now()
   WHERE token_hash = p_token_hash
     AND revoked_at IS NULL
     AND expires_at > now()
  RETURNING user_id, id;
$$;

CREATE OR REPLACE FUNCTION auth_revoke_refresh_token(p_token_hash text)
RETURNS void
  LANGUAGE sql
  SECURITY DEFINER
  SET search_path = public, pg_temp
AS $$
  UPDATE refresh_tokens SET revoked_at = now()
   WHERE token_hash = p_token_hash AND revoked_at IS NULL;
$$;

-- Logout de todas as sessoes + invalidacao dos access tokens ja emitidos.
CREATE OR REPLACE FUNCTION auth_revoke_all_sessions(p_user_id uuid)
RETURNS void
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = public, pg_temp
AS $$
BEGIN
  UPDATE refresh_tokens SET revoked_at = now()
   WHERE user_id = p_user_id AND revoked_at IS NULL;
  UPDATE users SET token_version = token_version + 1
   WHERE id = p_user_id;
END;
$$;


-- ===========================================================================
-- Busca cross-tenant anonimizada
--
-- As views abaixo sao o UNICO caminho pelo qual um parceiro enxerga dado de
-- outro parceiro. Elas sao owned por app_network_reader (BYPASSRLS) e,
-- por serem security_invoker = false, executam com os direitos do dono.
--
-- A lista de colunas e uma ALLOW-LIST escrita a mao. Nunca use SELECT *
-- aqui: uma coluna nova em properties entraria na rede sem ninguem decidir.
-- ===========================================================================

DROP VIEW IF EXISTS network_listing_media;
DROP VIEW IF EXISTS network_listings;

CREATE VIEW network_listings WITH (security_invoker = false) AS
SELECT
  p.id                  AS listing_id,
  -- tenant_id AUSENTE de proposito. Nao adicione.
  p.type,
  p.purpose,
  p.city_id,
  p.neighborhood_id,
  p.bedrooms,
  p.suites,
  p.bathrooms,
  p.parking_spots,
  p.area_total,
  p.area_built,
  p.sale_price_cents,
  p.rent_price_cents,
  p.condo_fee_cents,
  p.iptu_cents,
  p.currency,
  p.accepts_exchange,
  p.created_at,
  p.updated_at
  -- DELIBERADAMENTE FORA:
  --   tenant_id, reference_code, external_source, external_id  -> identificam o dono
  --   title, description                                       -> texto livre com telefone/marca
  --   street, street_number, complement, zip                   -> permitem achar o anuncio original
  --   latitude, longitude                                      -> idem, com precisao de metros
  --   created_by, is_exclusive                                 -> metadado interno
FROM properties p
WHERE p.deleted_at IS NULL
  AND p.status = 'active'
  AND p.published_to_network;

ALTER VIEW network_listings OWNER TO app_network_reader;

COMMENT ON VIEW network_listings IS
  'Projecao anonima de properties para busca cross-tenant. Allow-list manual de colunas; adicionar coluna aqui e decisao de produto, nao de implementacao.';


-- Midia visivel na rede. Sem storage_key: a chave do bucket nunca chega ao
-- cliente. A API resolve a chave por network_media_storage_key() e devolve
-- uma URL assinada de curta duracao.
--
-- sanitized_at IS NOT NULL e obrigatorio: midia que ainda nao passou pelo
-- strip de EXIF carrega GPS, autor e copyright do dono.
CREATE VIEW network_listing_media WITH (security_invoker = false) AS
SELECT
  m.id          AS media_id,
  m.property_id AS listing_id,
  m.kind,
  m.position,
  m.width,
  m.height
FROM property_media m
JOIN properties p ON p.id = m.property_id
WHERE m.sanitized_at IS NOT NULL
  AND m.kind IN ('photo', 'floor_plan')
  AND p.deleted_at IS NULL
  AND p.status = 'active'
  AND p.published_to_network;

ALTER VIEW network_listing_media OWNER TO app_network_reader;

-- Resolve a chave de storage de uma midia visivel na rede, revalidando a
-- visibilidade. Recebe media_id e devolve a chave -- nunca o contrario.
CREATE OR REPLACE FUNCTION network_media_storage_key(p_media_id uuid)
RETURNS text
  LANGUAGE sql
  STABLE
  SECURITY DEFINER
  SET search_path = public, pg_temp
AS $$
  SELECT m.storage_key
  FROM property_media m
  JOIN properties p ON p.id = m.property_id
  WHERE m.id = p_media_id
    AND m.sanitized_at IS NOT NULL
    AND m.kind IN ('photo', 'floor_plan')
    AND p.deleted_at IS NULL
    AND p.status = 'active'
    AND p.published_to_network;
$$;


-- ===========================================================================
-- Privilegios
-- ===========================================================================

-- Tabelas de dominio do parceiro: RLS faz a filtragem por linha.
GRANT SELECT, INSERT, UPDATE, DELETE ON properties, property_media TO app_user;
GRANT SELECT, INSERT, UPDATE, DELETE ON users                      TO app_user;
GRANT SELECT, UPDATE                 ON tenants                    TO app_user;
GRANT SELECT, INSERT, UPDATE, DELETE ON import_sources, import_jobs, import_items TO app_user;

-- Auditoria: so escreve e le. Nunca altera nem apaga.
GRANT SELECT, INSERT ON audit_log TO app_user;
REVOKE UPDATE, DELETE, TRUNCATE ON audit_log FROM app_user;
GRANT USAGE, SELECT ON SEQUENCE audit_log_id_seq TO app_user;

-- Catalogo geografico: leitura para todos, escrita so por admin (via migrator).
GRANT SELECT ON cities, neighborhoods, neighborhood_aliases TO app_user;
REVOKE INSERT, UPDATE, DELETE ON cities, neighborhoods, neighborhood_aliases FROM app_user;

-- Traducao de PropertyType: vocabulario global, mesmo regime do catalogo.
GRANT SELECT ON property_type_mappings TO app_user;
REVOKE INSERT, UPDATE, DELETE ON property_type_mappings FROM app_user;

-- Refresh tokens: acesso zero. So pelas funcoes.
REVOKE ALL ON refresh_tokens FROM app_user;

-- Views de busca: a view precisa ler as tabelas base com os direitos do dono.
GRANT SELECT ON properties, property_media TO app_network_reader;
GRANT SELECT ON network_listings, network_listing_media TO app_user;

-- Funcoes: negar a PUBLIC primeiro e so entao liberar a app_user.
-- Sem o REVOKE, toda funcao SECURITY DEFINER nasce executavel por PUBLIC.
DO $$
DECLARE
  fn text;
BEGIN
  FOREACH fn IN ARRAY ARRAY[
    'app_current_tenant()',
    'auth_find_user_by_email(citext)',
    'auth_find_user_by_id(uuid)',
    'auth_touch_last_login(uuid)',
    'auth_issue_refresh_token(uuid,text,timestamptz,text,inet)',
    'auth_consume_refresh_token(text)',
    'auth_revoke_refresh_token(text)',
    'auth_revoke_all_sessions(uuid)',
    'network_media_storage_key(uuid)'
  ]
  LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC', fn);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO app_user', fn);
  END LOOP;
END
$$;

-- As funcoes de auth precisam rodar com bypass: dono = app_network_reader.
ALTER FUNCTION auth_find_user_by_email(citext)                              OWNER TO app_network_reader;
ALTER FUNCTION auth_find_user_by_id(uuid)                                   OWNER TO app_network_reader;
ALTER FUNCTION auth_touch_last_login(uuid)                                  OWNER TO app_network_reader;
ALTER FUNCTION auth_issue_refresh_token(uuid,text,timestamptz,text,inet)    OWNER TO app_network_reader;
ALTER FUNCTION auth_consume_refresh_token(text)                             OWNER TO app_network_reader;
ALTER FUNCTION auth_revoke_refresh_token(text)                              OWNER TO app_network_reader;
ALTER FUNCTION auth_revoke_all_sessions(uuid)                               OWNER TO app_network_reader;
ALTER FUNCTION network_media_storage_key(uuid)                              OWNER TO app_network_reader;
GRANT SELECT, INSERT, UPDATE ON users, refresh_tokens TO app_network_reader;
GRANT SELECT ON tenants TO app_network_reader;
