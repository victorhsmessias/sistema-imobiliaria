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
-- RLS: conexoes  (FORCE)
-- ---------------------------------------------------------------------------
-- Primeira tabela do sistema cuja linha pertence a DOIS tenants: quem pediu e
-- o dono do imovel. As policies comparam as duas pontas, e nao um tenant_id
-- unico. Um terceiro parceiro nao ve a linha nem sabe que ela existe.
ALTER TABLE connection_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE connection_requests FORCE  ROW LEVEL SECURITY;

DROP POLICY IF EXISTS connection_requests_party_select ON connection_requests;
CREATE POLICY connection_requests_party_select ON connection_requests
  FOR SELECT
  USING (requester_tenant_id = app_current_tenant() OR owner_tenant_id = app_current_tenant());

-- So quem pede cria, e so carimbado com o proprio tenant. Pedir conexao no
-- proprio imovel nao faz sentido e fica barrado aqui, nao so no service.
DROP POLICY IF EXISTS connection_requests_requester_insert ON connection_requests;
CREATE POLICY connection_requests_requester_insert ON connection_requests
  FOR INSERT
  WITH CHECK (
    requester_tenant_id = app_current_tenant()
    AND owner_tenant_id <> app_current_tenant()
  );

-- As duas pontas atualizam a propria linha (o dono decide, quem pediu cancela).
-- QUAL transicao cada lado pode fazer e regra de negocio, no service: o banco
-- garante que ninguem de fora toca a linha.
DROP POLICY IF EXISTS connection_requests_party_update ON connection_requests;
CREATE POLICY connection_requests_party_update ON connection_requests
  FOR UPDATE
  USING (requester_tenant_id = app_current_tenant() OR owner_tenant_id = app_current_tenant())
  WITH CHECK (requester_tenant_id = app_current_tenant() OR owner_tenant_id = app_current_tenant());
-- Sem policy de DELETE: conexao nao se apaga, muda de status.

ALTER TABLE connection_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE connection_events FORCE  ROW LEVEL SECURITY;

-- A visibilidade do evento segue a da solicitacao: o EXISTS abaixo passa pela
-- policy de connection_requests, entao quem nao ve a conexao nao ve a trilha.
DROP POLICY IF EXISTS connection_events_party_select ON connection_events;
CREATE POLICY connection_events_party_select ON connection_events
  FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM connection_requests r
       WHERE r.id = connection_events.connection_request_id
    )
  );

DROP POLICY IF EXISTS connection_events_party_insert ON connection_events;
CREATE POLICY connection_events_party_insert ON connection_events
  FOR INSERT
  WITH CHECK (
    -- Ator nulo e a expiracao automatica: ninguem decidiu, o prazo acabou.
    (actor_tenant_id = app_current_tenant() OR actor_tenant_id IS NULL)
    AND EXISTS (
      SELECT 1 FROM connection_requests r
       WHERE r.id = connection_events.connection_request_id
    )
  );
-- Append-only: sem UPDATE e sem DELETE, como audit_log.


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
-- Conexao: resolucao do dono e revelacao controlada
--
-- Estas funcoes existem porque o RLS, sozinho, nao resolve o fluxo:
--  - quem PEDE conexao nao pode descobrir o dono (network_listings nao tem
--    tenant_id, de proposito);
--  - depois de aprovado, quem pediu precisa ver dados de OUTRO tenant.
--
-- Em vez de afrouxar as policies, a travessia fica em funcoes de superficie
-- minima, com a regra de revelacao dentro do proprio WHERE.
-- ===========================================================================

DROP FUNCTION IF EXISTS connection_disclosure(uuid);
DROP FUNCTION IF EXISTS connection_requester(uuid);
DROP FUNCTION IF EXISTS connection_listing(uuid);

-- Dono de um anuncio visivel na rede.
--
-- O valor devolvido NUNCA chega ao cliente: ele so carimba owner_tenant_id na
-- linha da solicitacao, para as policies das duas pontas funcionarem depois.
CREATE OR REPLACE FUNCTION network_listing_owner(p_listing_id uuid)
RETURNS uuid
  LANGUAGE sql
  STABLE
  SECURITY DEFINER
  SET search_path = public, pg_temp
AS $$
  SELECT p.tenant_id
  FROM properties p
  WHERE p.id = p_listing_id
    AND p.deleted_at IS NULL
    AND p.status = 'active'
    AND p.published_to_network;
$$;

-- O que o DONO revela a quem pediu.
--
-- As tres condicoes do WHERE sao a regra do produto, escrita no banco: a
-- conexao precisa estar APROVADA, e quem pergunta precisa ser o SOLICITANTE
-- daquela conexao. Uma consulta de qualquer outro lugar devolve zero linhas.
--
-- Nao devolve endereco: aprovar conexao nao e abrir o cadastro do imovel.
CREATE FUNCTION connection_disclosure(p_request_id uuid)
RETURNS TABLE (partner_name text, broker_name text, broker_phone text, broker_email text)
  LANGUAGE sql
  STABLE
  SECURITY DEFINER
  SET search_path = public, pg_temp
AS $$
  SELECT t.display_name, u.name, u.phone, u.email::text
  FROM connection_requests r
  JOIN tenants t     ON t.id = r.owner_tenant_id
  JOIN properties p  ON p.id = r.property_id
  LEFT JOIN users u  ON u.id = coalesce(r.decided_by_user_id, p.created_by)
  WHERE r.id = p_request_id
    AND r.status = 'approved'
    AND r.requester_tenant_id = app_current_tenant();
$$;

-- Quem esta pedindo, para o DONO decidir.
--
-- Disponivel desde a solicitacao, e nao apos aceite: pedir conexao e se
-- identificar. A assimetria e deliberada (ver schema/connections.ts).
CREATE FUNCTION connection_requester(p_request_id uuid)
RETURNS TABLE (partner_name text, broker_name text, broker_phone text, broker_email text)
  LANGUAGE sql
  STABLE
  SECURITY DEFINER
  SET search_path = public, pg_temp
AS $$
  SELECT t.display_name, u.name, u.phone, u.email::text
  FROM connection_requests r
  JOIN tenants t ON t.id = r.requester_tenant_id
  JOIN users u   ON u.id = r.requester_user_id
  WHERE r.id = p_request_id
    AND r.owner_tenant_id = app_current_tenant();
$$;

-- O imovel da conexao, com os MESMOS campos que a rede ja mostra.
--
-- Serve as duas pontas e continua sem titulo, descricao, codigo interno e
-- endereco -- um pedido de conexao nao amplia o que a busca revela.
CREATE FUNCTION connection_listing(p_request_id uuid)
RETURNS TABLE (
  listing_id        uuid,
  type              property_type,
  purpose           property_purpose,
  neighborhood_name text,
  city_name         text,
  city_uf           char(2),
  bedrooms          smallint,
  suites            smallint,
  bathrooms         smallint,
  parking_spots     smallint,
  area_built        numeric,
  area_total        numeric,
  sale_price_cents  bigint,
  rent_price_cents  bigint
)
  LANGUAGE sql
  STABLE
  SECURITY DEFINER
  SET search_path = public, pg_temp
AS $$
  SELECT p.id, p.type, p.purpose, n.name, c.name, c.uf,
         p.bedrooms, p.suites, p.bathrooms, p.parking_spots,
         p.area_built, p.area_total, p.sale_price_cents, p.rent_price_cents
  FROM connection_requests r
  JOIN properties p     ON p.id = r.property_id
  JOIN neighborhoods n  ON n.id = p.neighborhood_id
  JOIN cities c         ON c.id = p.city_id
  WHERE r.id = p_request_id
    AND (r.requester_tenant_id = app_current_tenant() OR r.owner_tenant_id = app_current_tenant());
$$;


-- ---------------------------------------------------------------------------
-- Curadoria de alias de bairro
-- ---------------------------------------------------------------------------
-- O catalogo e vocabulario COMPARTILHADO: app_user nao escreve nele (ver os
-- REVOKE abaixo). Mas a importacao XML produz bairros nao reconhecidos, e
-- obrigar o parceiro a esperar uma planilha do admin trava a carteira dele.
--
-- Meio-termo: uma funcao de superficie minima, que so acrescenta grafia
-- alternativa para um bairro que JA existe. Ela nao cria bairro, nao renomeia
-- e nao sequestra alias de outro bairro -- conflito volta descrito, para a
-- aplicacao explicar, em vez de um UPDATE silencioso que tiraria imoveis do
-- resultado de busca alheio.
--
-- O slug chega pronto: a normalizacao vive em packages/db/src/slug.ts e
-- reescreve-la em SQL criaria duas implementacoes divergindo em silencio.
DROP FUNCTION IF EXISTS catalog_add_alias(uuid, text);
CREATE FUNCTION catalog_add_alias(p_neighborhood_id uuid, p_alias_slug text)
RETURNS TABLE (alias_slug text, created boolean, conflict_with text)
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = public, pg_temp
AS $$
DECLARE
  v_city      uuid;
  v_tenant    uuid := app_current_tenant();
  v_source    text;
  v_existing  uuid;
BEGIN
  IF v_tenant IS NULL THEN
    RETURN;  -- sem tenant no contexto, nada acontece (fail-closed)
  END IF;
  IF p_alias_slug !~ '^[a-z0-9]+(-[a-z0-9]+)*$' THEN
    RETURN;
  END IF;

  SELECT n.city_id INTO v_city FROM neighborhoods n WHERE n.id = p_neighborhood_id;
  IF v_city IS NULL THEN
    RETURN;  -- bairro inexistente: a aplicacao responde 404
  END IF;

  SELECT a.neighborhood_id INTO v_existing
    FROM neighborhood_aliases a
   WHERE a.city_id = v_city AND a.alias_slug = p_alias_slug;

  IF v_existing = p_neighborhood_id THEN
    -- Idempotente: pedir de novo o mesmo alias nao e erro.
    RETURN QUERY SELECT p_alias_slug, false, NULL::text;
    RETURN;
  END IF;

  IF v_existing IS NOT NULL THEN
    RETURN QUERY SELECT p_alias_slug, false, (SELECT n.name FROM neighborhoods n WHERE n.id = v_existing);
    RETURN;
  END IF;

  SELECT 'partner:' || t.slug INTO v_source FROM tenants t WHERE t.id = v_tenant;

  INSERT INTO neighborhood_aliases (city_id, neighborhood_id, alias_slug, source)
  VALUES (v_city, p_neighborhood_id, p_alias_slug, coalesce(v_source, 'partner'));

  RETURN QUERY SELECT p_alias_slug, true, NULL::text;
END;
$$;


-- ===========================================================================
-- Privilegios
-- ===========================================================================

-- Tabelas de dominio do parceiro: RLS faz a filtragem por linha.
GRANT SELECT, INSERT, UPDATE, DELETE ON properties, property_media TO app_user;
GRANT SELECT, INSERT, UPDATE, DELETE ON users                      TO app_user;
GRANT SELECT, UPDATE                 ON tenants                    TO app_user;
GRANT SELECT, INSERT, UPDATE, DELETE ON import_sources, import_jobs, import_items TO app_user;

-- Conexoes: cria, le e atualiza. Nunca apaga.
GRANT SELECT, INSERT, UPDATE ON connection_requests TO app_user;
REVOKE DELETE, TRUNCATE ON connection_requests FROM app_user;
GRANT SELECT, INSERT ON connection_events TO app_user;
REVOKE UPDATE, DELETE, TRUNCATE ON connection_events FROM app_user;

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
    'network_media_storage_key(uuid)',
    'network_listing_owner(uuid)',
    'connection_disclosure(uuid)',
    'connection_requester(uuid)',
    'connection_listing(uuid)',
    'catalog_add_alias(uuid,text)'
  ]
  LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC', fn);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO app_user', fn);
  END LOOP;
END
$$;

-- As funcoes de conexao sao SECURITY DEFINER e rodam como app_network_reader,
-- mas decidem o que revelar comparando com app_current_tenant(). Sem este
-- GRANT, o dono delas nao consegue chamar a funcao que le o tenant da sessao,
-- e a leitura da conexao morre com "permission denied for function
-- app_current_tenant" -- erro que so aparece em runtime, dentro da funcao.
GRANT EXECUTE ON FUNCTION app_current_tenant() TO app_network_reader;

-- As funcoes de auth precisam rodar com bypass: dono = app_network_reader.
ALTER FUNCTION auth_find_user_by_email(citext)                              OWNER TO app_network_reader;
ALTER FUNCTION auth_find_user_by_id(uuid)                                   OWNER TO app_network_reader;
ALTER FUNCTION auth_touch_last_login(uuid)                                  OWNER TO app_network_reader;
ALTER FUNCTION auth_issue_refresh_token(uuid,text,timestamptz,text,inet)    OWNER TO app_network_reader;
ALTER FUNCTION auth_consume_refresh_token(text)                             OWNER TO app_network_reader;
ALTER FUNCTION auth_revoke_refresh_token(text)                              OWNER TO app_network_reader;
ALTER FUNCTION auth_revoke_all_sessions(uuid)                               OWNER TO app_network_reader;
ALTER FUNCTION network_media_storage_key(uuid)                              OWNER TO app_network_reader;
ALTER FUNCTION network_listing_owner(uuid)                                  OWNER TO app_network_reader;
ALTER FUNCTION connection_disclosure(uuid)                                  OWNER TO app_network_reader;
ALTER FUNCTION connection_requester(uuid)                                   OWNER TO app_network_reader;
ALTER FUNCTION connection_listing(uuid)                                     OWNER TO app_network_reader;
ALTER FUNCTION catalog_add_alias(uuid,text)                                 OWNER TO app_network_reader;
GRANT SELECT, INSERT, UPDATE ON users, refresh_tokens TO app_network_reader;
GRANT SELECT ON tenants TO app_network_reader;
-- As funcoes de conexao leem as duas pontas com os direitos do dono.
GRANT SELECT ON connection_requests, properties, neighborhoods, cities TO app_network_reader;
-- catalog_add_alias() escreve APENAS aqui, e so acrescentando grafia.
GRANT SELECT, INSERT ON neighborhood_aliases TO app_network_reader;
