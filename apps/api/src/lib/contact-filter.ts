/**
 * Mascara contato escrito em texto livre entre as partes de uma conexao.
 *
 * A negociacao precisa ficar dentro da plataforma (spec de 28/09/2026): o
 * contato nunca atravessa, nem digitado. Telefone, e-mail, link e @perfil
 * viram CONTACT_MASK.
 *
 * A ORDEM dos padroes importa: e-mail antes de dominio e de @perfil, senao
 * "fulano@beta.com.br" vira "fulano@[contato removido]".
 *
 * O que passa intacto e tao importante quanto o que e pego: valor em reais,
 * metragem, CRECI, CEP e datas aparecem em toda conversa de imovel (ver
 * test/contact-filter.test.ts).
 */
export const CONTACT_MASK = '[contato removido]';

const PATTERNS: readonly RegExp[] = [
  // e-mail
  /[\p{L}\d._%+-]+@[\p{L}\d-]+(?:\.[\p{L}\d-]+)+/giu,
  // link com protocolo ou www
  /\bhttps?:\/\/\S+/giu,
  /\bwww\.\S+/giu,
  // dominio solto: beta.com.br, wa.me/5543...
  /\b(?:[a-z\d-]+\.)+(?:com|net|org|br|me|io|app|imb|info|biz)(?:\.br)?\b(?:\/\S*)?/giu,
  // @perfil de rede social
  /(?<![\p{L}\d._])@[\p{L}\d._]{3,30}/giu,
  // telefone com DDD (10 ou 11 digitos, +55 opcional). Nao pega valor apos R$.
  // O 9 do celular pode vir separado do resto ("43 9 8020-2000"), por isso o
  // grupo carrega seu proprio separador opcional em vez de "9?" solto.
  /(?<!R\$\s*)(?<![\d.,])(?:\+?55[\s.-]*)?\(?\d{2}\)?[\s.-]*(?:9[\s.-]?)?\d{4}[\s.-]?\d{4}(?![\d.,]?\d)/gu,
  // telefone sem DDD: exige o traco, para nao pegar codigo de referencia
  /(?<!R\$\s*)(?<![\d.,])(?:9[\s.-]?)?\d{4}-\d{4}(?![\d.,]?\d)/gu,
];

export function maskContacts(text: string): { text: string; masked: boolean } {
  let result = text;
  for (const pattern of PATTERNS) {
    result = result.replace(pattern, CONTACT_MASK);
  }
  return { text: result, masked: result !== text };
}
