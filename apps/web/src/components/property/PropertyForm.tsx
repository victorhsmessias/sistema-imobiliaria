'use client';

import type {
  PropertyDto,
  PropertyPurpose,
  PropertyStatus,
  PropertyType,
} from '@imob/contracts';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState, type ChangeEvent, type FormEvent, type ReactNode } from 'react';
import { Icon } from '@/components/Icon';
import { NeighborhoodPicker } from '@/components/search/NeighborhoodPicker';
import { apiFetch, ApiError } from '@/lib/api';
import { useCatalog } from '@/lib/catalog';
import { centsToInput, parseDecimal, parseMoneyToCents } from '@/lib/format';
import { PURPOSE_LABELS, STATUS_LABELS, TYPE_LABELS } from '@/lib/labels';
import styles from './property.module.css';

/**
 * As chaves do formulario sao os nomes dos campos da API. Assim um erro de
 * validacao devolvido pelo servidor ("fields.salePriceCents") cai direto no campo
 * certo, sem tabela de traducao para manter.
 */
interface FormValues {
  title: string;
  referenceCode: string;
  description: string;
  neighborhoodId: string;
  street: string;
  streetNumber: string;
  complement: string;
  zip: string;
  type: PropertyType;
  purpose: PropertyPurpose;
  status: PropertyStatus;
  bedrooms: string;
  suites: string;
  bathrooms: string;
  parkingSpots: string;
  areaBuilt: string;
  areaTotal: string;
  salePriceCents: string;
  rentPriceCents: string;
  condoFeeCents: string;
  iptuCents: string;
  acceptsExchange: boolean;
  isExclusive: boolean;
  publishedToNetwork: boolean;
}

type TextKey = {
  [K in keyof FormValues]: FormValues[K] extends string ? K : never;
}[keyof FormValues];
type BoolKey = {
  [K in keyof FormValues]: FormValues[K] extends boolean ? K : never;
}[keyof FormValues];

const EMPTY: FormValues = {
  title: '',
  referenceCode: '',
  description: '',
  neighborhoodId: '',
  street: '',
  streetNumber: '',
  complement: '',
  zip: '',
  type: 'apartamento',
  purpose: 'sale',
  status: 'active',
  bedrooms: '',
  suites: '',
  bathrooms: '',
  parkingSpots: '',
  areaBuilt: '',
  areaTotal: '',
  salePriceCents: '',
  rentPriceCents: '',
  condoFeeCents: '',
  iptuCents: '',
  acceptsExchange: false,
  isExclusive: false,
  publishedToNetwork: true,
};

const numberText = (value: number) => (value === 0 ? '' : String(value));
const decimalText = (value: number | null) =>
  value === null ? '' : value.toLocaleString('pt-BR', { maximumFractionDigits: 2 });

function fromDto(dto: PropertyDto): FormValues {
  return {
    title: dto.title,
    referenceCode: dto.referenceCode ?? '',
    description: dto.description ?? '',
    neighborhoodId: dto.neighborhood.id,
    street: dto.street ?? '',
    streetNumber: dto.streetNumber ?? '',
    complement: dto.complement ?? '',
    zip: dto.zip ?? '',
    type: dto.type,
    purpose: dto.purpose,
    status: dto.status,
    bedrooms: numberText(dto.bedrooms),
    suites: numberText(dto.suites),
    bathrooms: numberText(dto.bathrooms),
    parkingSpots: numberText(dto.parkingSpots),
    areaBuilt: decimalText(dto.areaBuilt),
    areaTotal: decimalText(dto.areaTotal),
    salePriceCents: centsToInput(dto.salePriceCents),
    rentPriceCents: centsToInput(dto.rentPriceCents),
    condoFeeCents: centsToInput(dto.condoFeeCents),
    iptuCents: centsToInput(dto.iptuCents),
    acceptsExchange: dto.acceptsExchange,
    isExclusive: dto.isExclusive,
    publishedToNetwork: dto.publishedToNetwork,
  };
}

function buildPayload(values: FormValues) {
  const errors: Record<string, string> = {};

  const text = (key: TextKey) => {
    const value = values[key].trim();
    return value === '' ? null : value;
  };

  const integer = (key: TextKey) => {
    const value = values[key].trim();
    if (value === '') return 0;
    if (!/^\d+$/.test(value)) {
      errors[key] = 'Use um número inteiro.';
      return 0;
    }
    return Number(value);
  };

  const decimal = (key: TextKey) => {
    const value = parseDecimal(values[key]);
    if (value !== null && Number.isNaN(value)) {
      errors[key] = 'Use só números, como 92 ou 92,5.';
      return null;
    }
    return value;
  };

  const money = (key: TextKey) => {
    const value = parseMoneyToCents(values[key]);
    if (value !== null && Number.isNaN(value)) {
      errors[key] = 'Use só números, como 580.000 ou 450,50.';
      return null;
    }
    return value;
  };

  if (values.title.trim().length < 3) errors.title = 'Dê um título com pelo menos 3 letras.';
  if (!values.neighborhoodId) errors.neighborhoodId = 'Escolha o bairro.';

  const payload = {
    title: values.title.trim(),
    referenceCode: text('referenceCode'),
    description: text('description'),
    neighborhoodId: values.neighborhoodId,
    street: text('street'),
    streetNumber: text('streetNumber'),
    complement: text('complement'),
    zip: text('zip'),
    type: values.type,
    purpose: values.purpose,
    status: values.status,
    bedrooms: integer('bedrooms'),
    suites: integer('suites'),
    bathrooms: integer('bathrooms'),
    parkingSpots: integer('parkingSpots'),
    areaBuilt: decimal('areaBuilt'),
    areaTotal: decimal('areaTotal'),
    // O campo da finalidade que nao se aplica fica escondido na tela; manda-lo
    // mesmo assim gravaria um aluguel num imovel so a venda.
    salePriceCents: values.purpose === 'rent' ? null : money('salePriceCents'),
    rentPriceCents: values.purpose === 'sale' ? null : money('rentPriceCents'),
    condoFeeCents: money('condoFeeCents'),
    iptuCents: money('iptuCents'),
    acceptsExchange: values.acceptsExchange,
    isExclusive: values.isExclusive,
    publishedToNetwork: values.publishedToNetwork,
  };

  return { payload, errors };
}

/**
 * Selo de visibilidade de cada secao.
 *
 * O formulario inteiro existe em torno de uma pergunta que o corretor faz:
 * "isso aqui os outros parceiros veem?". A resposta fica no cabecalho de
 * cada bloco e no indice lateral, e nao escondida num texto de ajuda.
 */
function Visibility({ network }: { network: boolean }) {
  return (
    <span className={network ? styles.visNetwork : styles.visPrivate}>
      <Icon name={network ? 'network' : 'lock'} size={14} />
      {network ? 'Aparece na busca da rede' : 'Só a sua imobiliária vê'}
    </span>
  );
}

function Section({
  id,
  title,
  network,
  description,
  children,
}: {
  id: string;
  title: string;
  network?: boolean;
  description?: string;
  children: ReactNode;
}) {
  return (
    <section id={`s-${id}`} className={styles.section} aria-labelledby={`s-${id}-title`}>
      <header className={styles.sectionHead}>
        <h2 id={`s-${id}-title`} className="section-title">
          {title}
        </h2>
        {network !== undefined && <Visibility network={network} />}
      </header>
      <div className={styles.sectionBody}>
        {description && <p className={`hint ${styles.sectionText}`}>{description}</p>}
        <div className={styles.grid}>{children}</div>
      </div>
    </section>
  );
}

// Ordem e visibilidade de cada secao, para o indice lateral. undefined = mista.
const SECTIONS: Array<{ id: string; title: string; network?: boolean }> = [
  { id: 'anuncio', title: 'Anúncio', network: false },
  { id: 'localizacao', title: 'Localização', network: true },
  { id: 'endereco', title: 'Endereço', network: false },
  { id: 'caracteristicas', title: 'Características', network: true },
  { id: 'valores', title: 'Valores', network: true },
  { id: 'publicacao', title: 'Publicação' },
];

interface Props {
  initial?: PropertyDto;
  onSaved?: (property: PropertyDto) => void;
  /** Secao de fotos, antes do formulario. So existe depois do primeiro salvamento. */
  media?: ReactNode;
}

export function PropertyForm({ initial, onSaved, media }: Props) {
  const router = useRouter();
  const { catalog } = useCatalog();

  const [values, setValues] = useState<FormValues>(() => (initial ? fromDto(initial) : EMPTY));
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState(false);

  const setText =
    (key: TextKey) =>
    (event: ChangeEvent<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>) => {
      const { value } = event.target;
      setValues((current) => ({ ...current, [key]: value }));
    };

  const setBool = (key: BoolKey) => (event: ChangeEvent<HTMLInputElement>) => {
    const { checked } = event.target;
    setValues((current) => ({ ...current, [key]: checked }));
  };

  function focusFirst(fieldErrors: Record<string, string>) {
    const first = Object.keys(fieldErrors)[0];
    if (first) document.getElementById(`f-${first}`)?.focus();
  }

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    setNotice(null);
    setFormError(null);

    const { payload, errors: clientErrors } = buildPayload(values);
    if (Object.keys(clientErrors).length > 0) {
      setErrors(clientErrors);
      setFormError('Revise os campos destacados.');
      focusFirst(clientErrors);
      return;
    }

    setErrors({});
    setSaving(true);
    try {
      if (initial) {
        const { property } = await apiFetch<{ property: PropertyDto }>(`/properties/${initial.id}`, {
          method: 'PATCH',
          body: JSON.stringify(payload),
        });
        setValues(fromDto(property));
        onSaved?.(property);
        setNotice('Alterações salvas.');
      } else {
        const { property } = await apiFetch<{ property: PropertyDto }>('/properties', {
          method: 'POST',
          body: JSON.stringify(payload),
        });
        router.replace(`/carteira/${property.id}?novo=1`);
      }
    } catch (reason) {
      if (reason instanceof ApiError && reason.fields) {
        setErrors(reason.fields);
        setFormError('Revise os campos destacados.');
        focusFirst(reason.fields);
      } else {
        setFormError(reason instanceof ApiError ? reason.message : 'Não foi possível salvar agora.');
      }
    } finally {
      setSaving(false);
    }
  }

  async function handleDelete() {
    if (!initial) return;
    if (!window.confirm('Excluir este imóvel? Ele sai da sua carteira e da busca da rede.')) return;
    setDeleting(true);
    try {
      await apiFetch(`/properties/${initial.id}`, { method: 'DELETE' });
      router.push('/carteira');
    } catch (reason) {
      setFormError(reason instanceof ApiError ? reason.message : 'Não foi possível excluir agora.');
      setDeleting(false);
    }
  }

  function field(
    key: TextKey,
    label: string,
    options: {
      hint?: string;
      prefix?: string;
      suffix?: string;
      inputMode?: 'numeric' | 'decimal' | 'text';
      required?: boolean;
      wide?: boolean;
      multiline?: boolean;
      maxLength?: number;
    } = {},
  ) {
    const id = `f-${key}`;
    const error = errors[key];
    const describedBy =
      [error ? `${id}-error` : null, options.hint ? `${id}-hint` : null].filter(Boolean).join(' ') ||
      undefined;

    const common = {
      id,
      name: key,
      className: `input ${options.inputMode && options.inputMode !== 'text' ? 'num' : ''}`,
      value: values[key],
      onChange: setText(key),
      required: options.required,
      maxLength: options.maxLength,
      'aria-invalid': error ? true : undefined,
      'aria-describedby': describedBy,
    };

    let control: ReactNode;
    if (options.multiline) {
      control = <textarea {...common} />;
    } else if (options.prefix || options.suffix) {
      control = (
        <div className={styles.affix}>
          {options.prefix && <span aria-hidden="true">{options.prefix}</span>}
          <input {...common} inputMode={options.inputMode} />
          {options.suffix && <span aria-hidden="true">{options.suffix}</span>}
        </div>
      );
    } else {
      control = <input {...common} inputMode={options.inputMode} />;
    }

    return (
      <div className={`field ${options.wide ? styles.wide : ''}`}>
        <label htmlFor={id}>
          {label}
          {options.required && (
            <span className={styles.required} aria-hidden="true">
              {' '}
              obrigatório
            </span>
          )}
        </label>
        {control}
        {options.hint && (
          <p id={`${id}-hint`} className="hint">
            {options.hint}
          </p>
        )}
        {error && (
          <p id={`${id}-error`} className="error-text">
            {error}
          </p>
        )}
      </div>
    );
  }

  const railItems = media ? [{ id: 'fotos', title: 'Fotos', network: true }, ...SECTIONS] : SECTIONS;

  return (
    <div className={styles.editor}>
      <nav className={styles.rail} aria-label="Seções do imóvel">
        <ul className={styles.railList}>
          {railItems.map((section) => (
            <li key={section.id}>
              <a href={`#s-${section.id}`}>
                {section.title}
                {section.network !== undefined && (
                  <span
                    className={section.network ? styles.railNet : styles.railPrivate}
                    title={section.network ? 'Aparece na busca da rede' : 'Só a sua imobiliária vê'}
                  >
                    <Icon name={section.network ? 'network' : 'lock'} size={14} />
                  </span>
                )}
              </a>
            </li>
          ))}
        </ul>
        <div className={styles.legend} aria-hidden="true">
          <span className={styles.railNet}>
            <Icon name="network" size={14} />
            Aparece na rede
          </span>
          <span>
            <Icon name="lock" size={14} />
            Só a sua imobiliária
          </span>
        </div>
      </nav>

      <div className={styles.editorBody}>
        {media}

        <form className={styles.form} onSubmit={handleSubmit} noValidate>
          {formError && (
            <p className="alert" role="alert">
              {formError}
            </p>
          )}

          <Section id="anuncio" title="Anúncio" network={false}>
            {field('title', 'Título', { required: true, wide: true, maxLength: 200 })}
            {field('referenceCode', 'Código interno', {
              maxLength: 60,
              hint: 'O código que a sua imobiliária usa para este imóvel.',
            })}
            {field('description', 'Descrição', { wide: true, multiline: true, maxLength: 5000 })}
          </Section>

          <Section
            id="localizacao"
            title="Localização"
            network
            description="Na rede, o imóvel aparece só pelo bairro."
          >
            <div className="field">
              <label htmlFor="f-neighborhoodId">
                Bairro
                <span className={styles.required} aria-hidden="true">
                  {' '}
                  obrigatório
                </span>
              </label>
              {catalog ? (
                <NeighborhoodPicker
                  inputId="f-neighborhoodId"
                  neighborhoods={catalog.neighborhoods}
                  selectedIds={values.neighborhoodId ? [values.neighborhoodId] : []}
                  onChange={(ids) =>
                    setValues((current) => ({ ...current, neighborhoodId: ids[0] ?? '' }))
                  }
                  single
                  invalid={Boolean(errors.neighborhoodId)}
                  describedBy={errors.neighborhoodId ? 'f-neighborhoodId-error' : 'f-neighborhoodId-hint'}
                />
              ) : (
                <input id="f-neighborhoodId" className="input" disabled placeholder="Carregando bairros…" />
              )}
              <p id="f-neighborhoodId-hint" className="hint">
                Digite parte do nome, com ou sem acento.
              </p>
              {errors.neighborhoodId && (
                <p id="f-neighborhoodId-error" className="error-text">
                  {errors.neighborhoodId}
                </p>
              )}
            </div>
          </Section>

          <Section
            id="endereco"
            title="Endereço"
            network={false}
            description="Rua, número e CEP nunca saem da sua carteira. Com eles, qualquer parceiro acharia o anúncio original."
          >
            {field('street', 'Rua', { wide: true, maxLength: 200 })}
            {field('streetNumber', 'Número', { maxLength: 20 })}
            {field('complement', 'Complemento', { maxLength: 120 })}
            {field('zip', 'CEP', { inputMode: 'numeric', maxLength: 12 })}
          </Section>

          <Section id="caracteristicas" title="Características" network>
            <div className="field">
              <label htmlFor="f-type">Tipo</label>
              <select id="f-type" className="input" value={values.type} onChange={setText('type')}>
                {(Object.keys(TYPE_LABELS) as PropertyType[]).map((key) => (
                  <option key={key} value={key}>
                    {TYPE_LABELS[key]}
                  </option>
                ))}
              </select>
            </div>
            <div className="field">
              <label htmlFor="f-purpose">Finalidade</label>
              <select id="f-purpose" className="input" value={values.purpose} onChange={setText('purpose')}>
                {(Object.keys(PURPOSE_LABELS) as PropertyPurpose[]).map((key) => (
                  <option key={key} value={key}>
                    {PURPOSE_LABELS[key]}
                  </option>
                ))}
              </select>
            </div>
            {field('bedrooms', 'Quartos', { inputMode: 'numeric' })}
            {field('suites', 'Suítes', { inputMode: 'numeric' })}
            {field('bathrooms', 'Banheiros', { inputMode: 'numeric' })}
            {field('parkingSpots', 'Vagas', { inputMode: 'numeric' })}
            {field('areaBuilt', 'Área construída', { inputMode: 'decimal', suffix: 'm²' })}
            {field('areaTotal', 'Área total', { inputMode: 'decimal', suffix: 'm²' })}
          </Section>

          <Section id="valores" title="Valores" network>
            {values.purpose !== 'rent' &&
              field('salePriceCents', 'Valor de venda', {
                inputMode: 'decimal',
                prefix: 'R$',
                hint: 'Deixe em branco para anunciar como sob consulta.',
              })}
            {values.purpose !== 'sale' &&
              field('rentPriceCents', 'Aluguel por mês', {
                inputMode: 'decimal',
                prefix: 'R$',
                hint: 'Deixe em branco para anunciar como sob consulta.',
              })}
            {field('condoFeeCents', 'Condomínio por mês', { inputMode: 'decimal', prefix: 'R$' })}
            {field('iptuCents', 'IPTU por ano', { inputMode: 'decimal', prefix: 'R$' })}
          </Section>

          <Section id="publicacao" title="Publicação">
            <div className="field">
              <label htmlFor="f-status">Status</label>
              <select id="f-status" className="input" value={values.status} onChange={setText('status')}>
                {(Object.keys(STATUS_LABELS) as PropertyStatus[]).map((key) => (
                  <option key={key} value={key}>
                    {STATUS_LABELS[key]}
                  </option>
                ))}
              </select>
            </div>

            <div className={`${styles.checks} ${styles.wide}`}>
              <label className={styles.check}>
                <input
                  type="checkbox"
                  checked={values.publishedToNetwork}
                  onChange={setBool('publishedToNetwork')}
                />
                <span>
                  <strong>Publicar na rede</strong>
                  <span className="hint">
                    Com status Ativo, o imóvel aparece na busca dos parceiros, sem nome, contato ou
                    endereço.
                  </span>
                </span>
              </label>
              <label className={styles.check}>
                <input type="checkbox" checked={values.acceptsExchange} onChange={setBool('acceptsExchange')} />
                <span>
                  <strong>Aceita permuta</strong>
                  <span className="hint">Aparece na busca da rede.</span>
                </span>
              </label>
              <label className={styles.check}>
                <input type="checkbox" checked={values.isExclusive} onChange={setBool('isExclusive')} />
                <span>
                  <strong>Exclusividade</strong>
                  <span className="hint">Controle interno. Só a sua imobiliária vê.</span>
                </span>
              </label>
            </div>
          </Section>

          <div className={styles.actions}>
            <div className={styles.actionsMain}>
              <button type="submit" className="btn btn-primary" disabled={saving}>
                {saving ? 'Salvando…' : initial ? 'Salvar alterações' : 'Cadastrar imóvel'}
              </button>
              <Link href="/carteira" className="btn btn-quiet">
                Cancelar
              </Link>
              {notice && (
                <span role="status" className={styles.saved}>
                  <Icon name="check" size={14} />
                  {notice}
                </span>
              )}
            </div>
            {initial && (
              <button
                type="button"
                className="btn btn-danger"
                onClick={() => void handleDelete()}
                disabled={deleting}
              >
                <Icon name="trash" size={14} />
                {deleting ? 'Excluindo…' : 'Excluir imóvel'}
              </button>
            )}
          </div>
        </form>
      </div>
    </div>
  );
}
