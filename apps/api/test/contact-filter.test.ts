import { describe, expect, it } from 'vitest';
import { CONTACT_MASK, maskContacts } from '../src/lib/contact-filter.js';

/**
 * O filtro e a ultima barreira para a negociacao nao sair da plataforma.
 * Falso negativo vaza contato; falso positivo estraga valor, metragem e datas,
 * que aparecem em toda conversa de imovel. Os dois lados estao na tabela.
 */
describe('maskContacts', () => {
  it.each([
    ['me liga 43 98020-2000', `me liga ${CONTACT_MASK}`],
    ['(43) 3322-1100 comercial', `${CONTACT_MASK} comercial`],
    ['+55 43 980202000', CONTACT_MASK],
    ['43980202000', CONTACT_MASK],
    ['43 3322 1100', CONTACT_MASK],
    ['43.98020.2000', CONTACT_MASK],
    ['só 98020-2000', `só ${CONTACT_MASK}`],
    ['fulano@beta.com.br', CONTACT_MASK],
    ['Fulano@Beta.COM', CONTACT_MASK],
    ['www.beta.com.br', CONTACT_MASK],
    ['beta.com.br', CONTACT_MASK],
    ['site https://beta.com.br/x', `site ${CONTACT_MASK}`],
    ['wa.me/5543980202000', CONTACT_MASK],
    ['insta @betaimoveis', `insta ${CONTACT_MASK}`],
  ])('mascara %j', (input, expected) => {
    expect(maskContacts(input)).toEqual({ text: expected, masked: true });
  });

  it.each([
    'R$ 1.308.000',
    'R$ 2.209.000 à vista',
    'R$ 1308000',
    'valor 1.308.000',
    'IPTU 13.250',
    'Condomínio R$ 955',
    '233 m²',
    'área 1.200 m² e 2026',
    'CRECI 12345',
    'CEP 86050-000',
    'ref 12345678',
    '3 quartos',
    '28/09',
    '28/09/2026',
    'Olá, tudo bem? Visita às 15h 🙂',
  ])('nao mexe em %j', (input) => {
    expect(maskContacts(input)).toEqual({ text: input, masked: false });
  });

  it('mascara cada ocorrencia, nao so a primeira', () => {
    expect(maskContacts('43 98020-2000 ou vendas@beta.com.br').text).toBe(
      `${CONTACT_MASK} ou ${CONTACT_MASK}`,
    );
  });
});
