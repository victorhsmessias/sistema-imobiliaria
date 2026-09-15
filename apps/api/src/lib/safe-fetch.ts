import { lookup as dnsLookup, type LookupAddress } from 'node:dns';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';

/**
 * Download de URL escolhida por terceiro, com protecao contra SSRF.
 *
 * A importacao XML baixa o que o feed do parceiro manda: a URL do proprio
 * feed e a de cada foto. Sem protecao, um feed com
 * <Item medium="image">http://169.254.169.254/latest/meta-data/</Item> faria o
 * servidor buscar credenciais da nuvem, varrer a rede interna da VPS ou bater
 * no Postgres e no MinIO locais -- e devolver o resultado como "foto".
 *
 * As defesas, e por que cada uma existe:
 *
 *  - So http/https, sem usuario:senha na URL e so portas 80/443.
 *  - O IP e checado DEPOIS da resolucao de DNS, contra todas as faixas
 *    privadas, de loopback, link-local, CGNAT, multicast e reservadas (v4 e
 *    v6, inclusive IPv4 embutido em IPv6). Checar so o hostname nao adianta:
 *    "fotos.imobiliaria.com.br" pode resolver para 10.0.0.5.
 *  - A conexao usa o MESMO IP que foi checado. A checagem roda dentro do
 *    `lookup` que o proprio socket usa, entao nao ha janela para DNS rebinding
 *    (resolver publico na checagem e privado na conexao).
 *  - Redirecionamento e seguido a mao, revalidando cada salto: um servidor
 *    publico que responde 302 para http://127.0.0.1 nao passa.
 *  - Limite de bytes aplicado durante o streaming (Content-Length mente),
 *    tempo total limitado e Content-Type conferido antes de ler o corpo.
 */

export class UnsafeUrlError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UnsafeUrlError';
  }
}

export class FetchFailedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'FetchFailedError';
  }
}

const BLOCKED = new net.BlockList();

const BLOCKED_IPV4: Array<[string, number]> = [
  ['0.0.0.0', 8], // "esta rede"; 0.0.0.0 conecta em localhost em varios sistemas
  ['10.0.0.0', 8], // privada
  ['100.64.0.0', 10], // CGNAT
  ['127.0.0.0', 8], // loopback
  ['169.254.0.0', 16], // link-local -- metadados de nuvem (169.254.169.254)
  ['172.16.0.0', 12], // privada (inclui a rede padrao do Docker)
  ['192.0.0.0', 24], // atribuicoes de protocolo IETF
  ['192.0.2.0', 24], // documentacao
  ['192.88.99.0', 24], // relay 6to4
  ['192.168.0.0', 16], // privada
  ['198.18.0.0', 15], // benchmark
  ['198.51.100.0', 24], // documentacao
  ['203.0.113.0', 24], // documentacao
  ['224.0.0.0', 4], // multicast
  ['240.0.0.0', 4], // reservada e broadcast
];

// IPv4 mapeado (::ffff:0:0/96) NAO entra aqui: o BlockList do Node compara
// todo IPv4 tambem como endereco mapeado, e essa regra bloquearia a internet
// inteira. Endereco mapeado e convertido para IPv4 em isBlockedAddress().
const BLOCKED_IPV6: Array<[string, number]> = [
  ['::', 128], // nao especificado
  ['::1', 128], // loopback
  ['64:ff9b::', 96], // NAT64
  ['64:ff9b:1::', 48], // NAT64 local
  ['100::', 64], // descarte
  ['2001::', 32], // Teredo
  ['2001:db8::', 32], // documentacao
  ['2002::', 16], // 6to4 (embute IPv4 arbitrario)
  ['fc00::', 7], // ULA, a "rede privada" do IPv6
  ['fe80::', 10], // link-local
  ['fec0::', 10], // site-local (obsoleto, mas roteado em redes antigas)
  ['ff00::', 8], // multicast
];

for (const [prefix, bits] of BLOCKED_IPV4) BLOCKED.addSubnet(prefix, bits, 'ipv4');
for (const [prefix, bits] of BLOCKED_IPV6) BLOCKED.addSubnet(prefix, bits, 'ipv6');

/** Forma canonica de um IPv6 ("0:0:0:0:0:FFFF:7F00:1" -> "::ffff:7f00:1"). */
function canonicalIpv6(address: string): string {
  try {
    return new URL(`http://[${address}]/`).hostname.slice(1, -1);
  } catch {
    return address.toLowerCase();
  }
}

/** IPv4 dentro de ::ffff:a.b.c.d / ::ffff:XXXX:YYYY, ou null. */
function mappedIpv4(canonical: string): string | null {
  const dotted = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/.exec(canonical)?.[1];
  if (dotted && net.isIPv4(dotted)) return dotted;
  const hex = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(canonical);
  if (!hex) return null;
  const high = parseInt(hex[1]!, 16);
  const low = parseInt(hex[2]!, 16);
  return `${high >> 8}.${high & 255}.${low >> 8}.${low & 255}`;
}

/** true quando o IP pertence a uma faixa que o servidor nunca deve buscar. */
export function isBlockedAddress(address: string): boolean {
  const family = net.isIP(address);
  if (family === 4) return BLOCKED.check(address, 'ipv4');
  if (family === 6) {
    const canonical = canonicalIpv6(address);
    // IPv4 mapeado: decide pelo IPv4, que e para onde o socket vai de fato.
    const ipv4 = mappedIpv4(canonical);
    if (ipv4) return BLOCKED.check(ipv4, 'ipv4');
    return BLOCKED.check(canonical, 'ipv6');
  }
  // Nao e IP: quem chama deveria ter resolvido antes. Na duvida, bloqueia.
  return true;
}

export interface SafeFetchOptions {
  /** Teto do corpo, conferido durante o download. */
  maxBytes: number;
  /** Tempo total, somando redirecionamentos. */
  timeoutMs?: number;
  maxRedirects?: number;
  allowedPorts?: number[];
  /** Recebe o Content-Type (sem parametros, minusculo) e decide se aceita. */
  accept?: (contentType: string | null) => boolean;
  /**
   * SO PARA TESTES: libera um IP que a lista bloquearia, para a suite poder
   * subir um servidor em 127.0.0.1. Nunca passe isto em codigo de producao.
   */
  unsafeAllowAddress?: (address: string) => boolean;
}

export interface SafeFetchResult {
  body: Buffer;
  contentType: string | null;
  finalUrl: string;
}

const DEFAULT_PORTS = [80, 443];
const USER_AGENT = 'RedeParceriaImob-Importer/1.0';

/** Valida protocolo, credenciais, porta e IP literal. Nao resolve DNS. */
export function assertFetchableUrl(
  input: string | URL,
  options: Pick<SafeFetchOptions, 'allowedPorts' | 'unsafeAllowAddress'> = {},
): URL {
  let url: URL;
  try {
    url = new URL(String(input));
  } catch {
    throw new UnsafeUrlError('URL inválida.');
  }

  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new UnsafeUrlError(`Protocolo não permitido (${url.protocol}). Use http ou https.`);
  }
  if (url.username !== '' || url.password !== '') {
    throw new UnsafeUrlError('URL com usuário e senha não é aceita.');
  }

  const port = url.port === '' ? (url.protocol === 'https:' ? 443 : 80) : Number(url.port);
  if (!(options.allowedPorts ?? DEFAULT_PORTS).includes(port)) {
    throw new UnsafeUrlError(`Porta ${port} não permitida.`);
  }

  // O parser WHATWG ja normaliza "2130706433", "0x7f.1" e afins para a forma
  // pontuada, entao a checagem abaixo ve o IP de verdade.
  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (host === '') throw new UnsafeUrlError('URL sem host.');
  // IP literal nao passa pelo lookup do socket: precisa ser checado aqui.
  if (net.isIP(host) !== 0 && isBlockedAddress(host) && !options.unsafeAllowAddress?.(host)) {
    throw new UnsafeUrlError('Endereço de rede interna não permitido.');
  }

  return url;
}

type LookupCallback = (
  error: NodeJS.ErrnoException | null,
  address?: string | LookupAddress[],
  family?: number,
) => void;

/**
 * `lookup` entregue ao socket: resolve, checa TODOS os enderecos e so entao
 * devolve. Como e o proprio socket que chama, o IP checado e o IP conectado.
 */
function guardedLookup(allow?: (address: string) => boolean) {
  return (hostname: string, options: { all?: boolean }, callback: LookupCallback): void => {
    dnsLookup(hostname, { all: true }, (error, addresses) => {
      if (error) {
        callback(error);
        return;
      }
      const list = addresses as LookupAddress[];
      const blocked = list.some((a) => isBlockedAddress(a.address) && !allow?.(a.address));
      if (list.length === 0 || blocked) {
        callback(new UnsafeUrlError('O host resolve para um endereço de rede interna.'));
        return;
      }
      if (options.all) callback(null, list);
      else callback(null, list[0]!.address, list[0]!.family);
    });
  };
}

interface HopResult {
  location?: string;
  body?: Buffer;
  contentType: string | null;
}

function requestOnce(url: URL, options: Required<Pick<SafeFetchOptions, 'maxBytes'>> & SafeFetchOptions, deadline: number): Promise<HopResult> {
  return new Promise((resolve, reject) => {
    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      reject(new FetchFailedError('Tempo esgotado.'));
      return;
    }

    let settled = false;
    const fail = (error: Error) => {
      if (settled) return;
      settled = true;
      reject(error);
    };

    const client = url.protocol === 'https:' ? https : http;
    const request = client.request(
      url,
      {
        method: 'GET',
        agent: false,
        lookup: guardedLookup(options.unsafeAllowAddress) as unknown as net.LookupFunction,
        headers: { 'user-agent': USER_AGENT, accept: '*/*' },
      },
      (response) => {
        const status = response.statusCode ?? 0;

        if (status >= 300 && status < 400 && response.headers.location) {
          response.resume();
          settled = true;
          resolve({ location: response.headers.location, contentType: null });
          return;
        }
        if (status !== 200) {
          response.resume();
          fail(new FetchFailedError(`O servidor respondeu HTTP ${status}.`));
          return;
        }

        const contentType =
          response.headers['content-type']?.split(';')[0]?.trim().toLowerCase() || null;
        if (options.accept && !options.accept(contentType)) {
          response.destroy();
          fail(new FetchFailedError(`Tipo de conteúdo não aceito (${contentType ?? 'ausente'}).`));
          return;
        }

        const declared = Number(response.headers['content-length']);
        if (Number.isFinite(declared) && declared > options.maxBytes) {
          response.destroy();
          fail(new FetchFailedError('Arquivo acima do tamanho permitido.'));
          return;
        }

        const chunks: Buffer[] = [];
        let size = 0;
        response.on('data', (chunk: Buffer) => {
          size += chunk.length;
          if (size > options.maxBytes) {
            response.destroy();
            request.destroy();
            fail(new FetchFailedError('Arquivo acima do tamanho permitido.'));
            return;
          }
          chunks.push(chunk);
        });
        response.on('end', () => {
          if (settled) return;
          settled = true;
          resolve({ body: Buffer.concat(chunks), contentType });
        });
        response.on('error', (error) => fail(new FetchFailedError(`Falha no download: ${error.message}`)));
      },
    );

    const timer = setTimeout(() => {
      request.destroy();
      fail(new FetchFailedError('Tempo esgotado.'));
    }, remaining);

    request.on('error', (error) => {
      fail(
        error instanceof UnsafeUrlError || error instanceof FetchFailedError
          ? error
          : new FetchFailedError(`Falha de conexão: ${error.message}`),
      );
    });
    request.on('close', () => clearTimeout(timer));
    request.end();
  });
}

export async function safeFetch(input: string, options: SafeFetchOptions): Promise<SafeFetchResult> {
  const maxRedirects = options.maxRedirects ?? 3;
  const deadline = Date.now() + (options.timeoutMs ?? 15_000);

  let url = assertFetchableUrl(input, options);
  for (let hop = 0; ; hop++) {
    const result = await requestOnce(url, options, deadline);

    if (result.location !== undefined) {
      if (hop >= maxRedirects) throw new FetchFailedError('Redirecionamentos demais.');
      // Cada salto passa pela validacao inteira de novo.
      url = assertFetchableUrl(new URL(result.location, url), options);
      continue;
    }

    return { body: result.body ?? Buffer.alloc(0), contentType: result.contentType, finalUrl: url.toString() };
  }
}
