import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  FetchFailedError,
  isBlockedAddress,
  safeFetch,
  UnsafeUrlError,
} from '../src/lib/safe-fetch.js';

/**
 * Protecao contra SSRF no download de feed e de fotos.
 *
 * A importacao busca URLs que o parceiro escreveu no XML. Estes testes provam
 * que essas URLs nao alcancam a rede interna -- nem direto, nem por DNS, nem
 * por redirecionamento -- e que resposta grande, lenta ou de tipo errado nao
 * passa.
 */
describe('download seguro (SSRF)', () => {
  describe('faixas bloqueadas', () => {
    it.each([
      '127.0.0.1',
      '127.8.9.10',
      '10.1.2.3',
      '172.16.5.4',
      '172.31.255.255',
      '192.168.0.10',
      '169.254.169.254',
      '100.64.0.1',
      '0.0.0.0',
      '224.0.0.1',
      '255.255.255.255',
      '::1',
      '::',
      'fe80::1',
      'fc00::1',
      'fd12:3456::1',
      '::ffff:127.0.0.1',
      '::ffff:7f00:1',
      '::ffff:a9fe:a9fe',
    ])('bloqueia %s', (address) => {
      expect(isBlockedAddress(address)).toBe(true);
    });

    it.each(['8.8.8.8', '1.1.1.1', '200.147.35.149', '2800:3f0:4001:80d::200e', '172.32.0.1'])(
      'libera %s',
      (address) => {
        expect(isBlockedAddress(address)).toBe(false);
      },
    );
  });

  describe('URL recusada antes de qualquer conexao', () => {
    const base = { maxBytes: 1024, timeoutMs: 2000 };

    it.each([
      ['file:///etc/passwd', /Protocolo/],
      ['ftp://fotos.exemplo.com.br/1.jpg', /Protocolo/],
      ['gopher://127.0.0.1:6379/_FLUSHALL', /Protocolo/],
      ['http://usuario:senha@fotos.exemplo.com.br/1.jpg', /usuário e senha/],
      ['http://127.0.0.1/admin', /rede interna/],
      ['http://[::1]/', /rede interna/],
      ['http://[::ffff:127.0.0.1]/', /rede interna/],
      // Formas "disfarcadas" de 127.0.0.1 que o parser WHATWG normaliza.
      ['http://2130706433/', /rede interna/],
      ['http://0x7f.1/', /rede interna/],
      ['http://169.254.169.254/latest/meta-data/', /rede interna/],
      ['http://fotos.exemplo.com.br:6379/', /Porta 6379/],
    ])('%s', async (url, message) => {
      const attempt = safeFetch(url, base);
      await expect(attempt).rejects.toBeInstanceOf(UnsafeUrlError);
      await expect(safeFetch(url, base)).rejects.toThrow(message);
    });

    it('recusa host cujo DNS resolve para rede interna (localhost)', async () => {
      await expect(safeFetch('http://localhost/', base)).rejects.toBeInstanceOf(UnsafeUrlError);
    });
  });

  describe('com servidor local liberado so para o teste', () => {
    let server: http.Server;
    let port: number;
    const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0]);

    beforeAll(async () => {
      server = http.createServer((request, response) => {
        switch (request.url) {
          case '/foto.jpg':
            response.writeHead(200, { 'content-type': 'image/jpeg' });
            response.end(JPEG);
            return;
          case '/pagina':
            response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
            response.end('<html></html>');
            return;
          case '/declarado-grande':
            response.writeHead(200, { 'content-type': 'image/jpeg', 'content-length': '50000000' });
            response.end(JPEG);
            return;
          case '/stream-grande': {
            // Sem Content-Length: o limite tem que valer durante o streaming.
            response.writeHead(200, { 'content-type': 'image/jpeg' });
            const chunk = Buffer.alloc(64 * 1024, 1);
            let sent = 0;
            const push = () => {
              while (sent < 2_000_000) {
                sent += chunk.length;
                if (!response.write(chunk)) {
                  response.once('drain', push);
                  return;
                }
              }
              response.end();
            };
            push();
            return;
          }
          case '/redireciona-metadados':
            response.writeHead(302, { location: `http://169.254.169.254:${port}/latest/meta-data/` });
            response.end();
            return;
          case '/redireciona-ok':
            response.writeHead(301, { location: '/foto.jpg' });
            response.end();
            return;
          case '/loop':
            response.writeHead(302, { location: '/loop' });
            response.end();
            return;
          case '/lento':
            // Nunca responde.
            return;
          default:
            response.writeHead(404);
            response.end();
        }
      });
      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
      port = (server.address() as AddressInfo).port;
    });

    afterAll(async () => {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    });

    const options = () => ({
      maxBytes: 1_000_000,
      timeoutMs: 1500,
      allowedPorts: [port],
      accept: (contentType: string | null) => contentType?.startsWith('image/') ?? false,
      // Libera APENAS o servidor do teste. 169.254.x continua bloqueado.
      unsafeAllowAddress: (address: string) => address === '127.0.0.1',
    });

    const url = (path: string) => `http://127.0.0.1:${port}${path}`;

    it('baixa uma imagem valida', async () => {
      const result = await safeFetch(url('/foto.jpg'), options());
      expect(result.contentType).toBe('image/jpeg');
      expect(result.body.equals(JPEG)).toBe(true);
    });

    it('segue redirecionamento para destino permitido', async () => {
      const result = await safeFetch(url('/redireciona-ok'), options());
      expect(result.finalUrl).toBe(url('/foto.jpg'));
    });

    it('recusa redirecionamento para rede interna, revalidando o salto', async () => {
      await expect(safeFetch(url('/redireciona-metadados'), options())).rejects.toBeInstanceOf(
        UnsafeUrlError,
      );
    });

    it('recusa Content-Type que nao e imagem', async () => {
      await expect(safeFetch(url('/pagina'), options())).rejects.toThrow(/Tipo de conteúdo/);
    });

    it('recusa pelo Content-Length declarado', async () => {
      await expect(safeFetch(url('/declarado-grande'), options())).rejects.toThrow(/tamanho/);
    });

    it('recusa durante o streaming quando o corpo passa do limite', async () => {
      await expect(safeFetch(url('/stream-grande'), options())).rejects.toThrow(/tamanho/);
    });

    it('recusa redirecionamento em loop', async () => {
      await expect(safeFetch(url('/loop'), options())).rejects.toThrow(/Redirecionamentos demais/);
    });

    it('desiste de servidor que nao responde', async () => {
      const started = Date.now();
      await expect(safeFetch(url('/lento'), { ...options(), timeoutMs: 400 })).rejects.toBeInstanceOf(
        FetchFailedError,
      );
      expect(Date.now() - started).toBeLessThan(3000);
    });
  });
});
