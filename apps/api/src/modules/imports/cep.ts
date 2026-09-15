/**
 * Resolucao de bairro pelo CEP, como segunda tentativa na importacao.
 *
 * Quando o <Neighborhood> do feed nao casa com o catalogo nem com os aliases,
 * o <PostalCode> -- obrigatorio no VrSync -- ainda pode dizer o bairro.
 *
 * ViaCEP e chamado com host fixo e caminho so de digitos: nao ha URL vinda do
 * parceiro, entao nao passa por safeFetch. Qualquer falha devolve null, e o
 * anuncio vai para curadoria em vez de derrubar a importacao.
 *
 * LGPD: o CEP enviado e o do imovel, nao de pessoa. Ainda assim e
 * compartilhamento com terceiro, e precisa entrar em docs/lgpd-data-map.md
 * quando esse mapa for escrito (Fase 1, tarefa 8).
 */

export interface CepResult {
  neighborhood: string | null;
  city: string | null;
  uf: string | null;
}

export type CepLookup = (postalCode: string) => Promise<CepResult | null>;

export const viaCepLookup: CepLookup = async (postalCode) => {
  const digits = postalCode.replace(/\D/g, '');
  if (digits.length !== 8) return null;

  try {
    const response = await fetch(`https://viacep.com.br/ws/${digits}/json/`, {
      signal: AbortSignal.timeout(4000),
      redirect: 'error',
    });
    if (!response.ok) return null;

    const body = (await response.json()) as {
      erro?: boolean | string;
      bairro?: string;
      localidade?: string;
      uf?: string;
    };
    if (body.erro) return null;

    return {
      neighborhood: body.bairro?.trim() || null,
      city: body.localidade?.trim() || null,
      uf: body.uf?.trim().toUpperCase() || null,
    };
  } catch {
    return null;
  }
};
