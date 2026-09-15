import { pgEnum } from 'drizzle-orm/pg-core';

export const tenantStatusEnum = pgEnum('tenant_status', [
  'pending',
  'active',
  'suspended',
]);

export const userRoleEnum = pgEnum('user_role', [
  'partner_admin',
  'partner_agent',
  'platform_admin',
]);

export const userStatusEnum = pgEnum('user_status', ['active', 'disabled']);

export const propertyPurposeEnum = pgEnum('property_purpose', [
  'sale',
  'rent',
  'sale_rent',
]);

export const propertyTypeEnum = pgEnum('property_type', [
  'apartamento',
  'casa',
  'casa_condominio',
  'terreno',
  'sala_comercial',
  'galpao',
  'loja',
  'sitio_chacara',
  'outro',
]);

export const propertyStatusEnum = pgEnum('property_status', [
  'draft',
  'active',
  'reserved',
  'sold_rented',
  'archived',
]);

export const mediaKindEnum = pgEnum('media_kind', [
  'photo',
  'floor_plan',
  'video',
  'tour',
]);

/** Formato de feed aceito. VrSync e o padrao do mercado; o XML ZAP legado foi desligado em 10/2024. */
export const importFormatEnum = pgEnum('import_format', ['vrsync']);

export const importJobStatusEnum = pgEnum('import_job_status', [
  'queued',
  'running',
  'succeeded',
  'failed',
]);

export const importItemStatusEnum = pgEnum('import_item_status', [
  'created',
  'updated',
  'unchanged',
  /** Estava no feed anterior e sumiu deste: o imovel sai do ar. */
  'archived',
  /** O parceiro excluiu o imovel na plataforma; o feed nao o ressuscita. */
  'skipped',
  /** Cidade ou bairro sem correspondencia no catalogo: espera curadoria. */
  'needs_curation',
  'failed',
]);
