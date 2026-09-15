/**
 * Contrato de anonimizacao, em forma legivel por maquina.
 *
 * NETWORK_ALLOWED_COLUMNS espelha a lista de colunas da view network_listings
 * em sql/10_security.sql. O teste em test/anonymization.test.ts compara os
 * dois: se alguem adicionar uma coluna a view e nao a esta lista (ou o
 * contrario), o build quebra.
 *
 * Nao e redundancia. E o que obriga a adicao de uma coluna a rede a ser um
 * ato deliberado, revisado nos dois lugares, em vez de um efeito colateral
 * de um ALTER TABLE.
 */
export const NETWORK_ALLOWED_COLUMNS = [
  'listing_id',
  'type',
  'purpose',
  'city_id',
  'neighborhood_id',
  'bedrooms',
  'suites',
  'bathrooms',
  'parking_spots',
  'area_total',
  'area_built',
  'sale_price_cents',
  'rent_price_cents',
  'condo_fee_cents',
  'iptu_cents',
  'currency',
  'accepts_exchange',
  'created_at',
  'updated_at',
] as const;

export const NETWORK_MEDIA_ALLOWED_COLUMNS = [
  'media_id',
  'listing_id',
  'kind',
  'position',
  'width',
  'height',
] as const;

/**
 * Colunas de `properties` e `property_media` que identificam o dono e nunca
 * podem atravessar a fronteira de tenant. Cada entrada traz o motivo -- alguns
 * nao sao obvios e a proxima pessoa precisa saber antes de decidir "expor so
 * esse campo".
 */
export const OWNER_IDENTIFYING_COLUMNS: Record<string, string> = {
  tenant_id: 'E a identidade do dono, literalmente.',
  reference_code: 'Costuma embutir a sigla do parceiro ("ABC-1234") e e pesquisavel no Google.',
  title: 'Texto livre: corretor escreve o nome da imobiliaria nele.',
  description: 'Texto livre: telefone e nome do corretor aparecem no corpo.',
  street: 'Com o endereco o solicitante acha o anuncio original num portal publico.',
  street_number: 'Idem street.',
  complement: 'Idem street.',
  zip: 'Estreita a busca publica o suficiente para identificar o anuncio.',
  latitude: 'Localiza o imovel com precisao de metros; equivale ao endereco.',
  longitude: 'Idem latitude.',
  external_source: 'Aponta para o feed de importacao, que pertence a um parceiro.',
  external_id: 'ListingID do feed: e o codigo interno do parceiro.',
  created_by: 'Identifica o corretor.',
  is_exclusive: 'Metadado comercial interno do parceiro.',
  source_url: 'URL original da foto no feed: o dominio e o da imobiliaria.',
  source_url_hash: 'Correlaciona a foto com a URL original do parceiro.',
  content_sha256: 'Correlaciona a foto com o mesmo arquivo publicado nos portais.',
  caption: 'Legenda do feed; costuma trazer o nome da imobiliaria.',
  original_filename: 'Costuma conter o nome da imobiliaria ou do fotografo.',
  storage_key: 'Caminho no bucket; pode ser correlacionado entre listagens.',
};

/** Campos de outras tabelas que tambem nao podem vazar em resposta da rede. */
export const OWNER_IDENTIFYING_FIELDS_OTHER: Record<string, string> = {
  legal_name: 'Razao social do parceiro.',
  display_name: 'Marca comercial do parceiro.',
  slug: 'Identificador legivel do parceiro.',
  email: 'Dado pessoal do corretor (LGPD) e identificador do parceiro.',
  phone: 'Dado pessoal do corretor (LGPD) e canal de contato direto.',
  password_hash: 'Credencial.',
  feed_url: 'URL do feed XML: o dominio e o da imobiliaria.',
  raw_payload: 'O <Listing> original: ContactInfo, endereco e URLs das fotos.',
};
