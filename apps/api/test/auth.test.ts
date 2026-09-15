import { closeDb, getDb, sql } from '@imob/db';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { cookiesFrom, loginAs } from './helpers.js';

const ALFA_ADMIN = 'admin@alfa.test';
const BETA_AGENT = 'corretor@beta.test';

describe('autenticacao', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    // Rate limit desligado: a suite faz dezenas de logins e bateria no limite
    // de 8 por 5 minutos. Ha um teste dedicado com ele ligado, mais abaixo.
    app = await buildApp({ rateLimit: false });
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
    await closeDb();
  });

  describe('login', () => {
    it('autentica com credencial correta e devolve a sessao', async () => {
      const { statusCode, body, cookies } = await loginAs(app, ALFA_ADMIN);

      expect(statusCode).toBe(200);
      const user = body.user as Record<string, unknown>;
      expect(user.email).toBe(ALFA_ADMIN);
      expect((user.tenant as Record<string, unknown>).slug).toBe('alfa-imoveis');
      expect(cookies.imob_at).toBeTruthy();
      expect(cookies.imob_rt).toBeTruthy();
    });

    it('trata e-mail como case-insensitive', async () => {
      const { statusCode } = await loginAs(app, 'ADMIN@Alfa.TEST');
      expect(statusCode).toBe(200);
    });

    it('nunca devolve o hash de senha', async () => {
      const { body } = await loginAs(app, ALFA_ADMIN);
      expect(JSON.stringify(body)).not.toContain('$argon2');
      expect(JSON.stringify(body)).not.toContain('password');
    });

    it('marca os cookies como httpOnly e restringe o refresh a /auth', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/auth/login',
        payload: { email: ALFA_ADMIN, password: 'demo1234' },
      });

      const access = response.cookies.find((c) => c.name === 'imob_at');
      const refresh = response.cookies.find((c) => c.name === 'imob_rt');

      // httpOnly: um XSS em qualquer ponto do front nao vira roubo de sessao.
      expect(access?.httpOnly).toBe(true);
      expect(refresh?.httpOnly).toBe(true);
      expect(access?.path).toBe('/');
      // O refresh nao viaja em toda request -- so onde e util.
      expect(refresh?.path).toBe('/auth');
      expect(access?.sameSite?.toLowerCase()).toBe('lax');
    });

    it('responde igual para senha errada e para e-mail inexistente', async () => {
      // Respostas distintas revelariam quais e-mails pertencem a parceiros da
      // rede -- num produto cujo valor e esconder quem esta na rede.
      const wrongPassword = await loginAs(app, ALFA_ADMIN, 'senha-errada');
      const unknownEmail = await loginAs(app, 'ninguem@lugar-nenhum.test', 'senha-errada');

      expect(wrongPassword.statusCode).toBe(401);
      expect(unknownEmail.statusCode).toBe(401);
      expect(wrongPassword.body).toEqual(unknownEmail.body);
      expect(wrongPassword.body).toEqual({
        code: 'invalid_credentials',
        message: 'E-mail ou senha incorretos.',
      });
    });

    it('rejeita payload invalido com erro por campo', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/auth/login',
        payload: { email: 'nao-e-email', password: '' },
      });

      expect(response.statusCode).toBe(422);
      const body = response.json();
      expect(body.code).toBe('validation_error');
      expect(body.fields).toHaveProperty('email');
      expect(body.fields).toHaveProperty('password');
    });
  });

  describe('sessao', () => {
    it('/auth/me exige sessao', async () => {
      const response = await app.inject({ method: 'GET', url: '/auth/me' });
      expect(response.statusCode).toBe(401);
      expect(response.json().code).toBe('unauthenticated');
    });

    it('/auth/me devolve o usuario autenticado', async () => {
      const { cookies } = await loginAs(app, ALFA_ADMIN);
      const response = await app.inject({ method: 'GET', url: '/auth/me', cookies });

      expect(response.statusCode).toBe(200);
      expect(response.json().user.email).toBe(ALFA_ADMIN);
    });

    it('recusa access token adulterado', async () => {
      const { cookies } = await loginAs(app, ALFA_ADMIN);
      const tampered = { ...cookies, imob_at: `${cookies.imob_at?.slice(0, -3)}xyz` };

      const response = await app.inject({ method: 'GET', url: '/auth/me', cookies: tampered });
      expect(response.statusCode).toBe(401);
    });
  });

  describe('rotacao de refresh token', () => {
    it('troca o token a cada refresh', async () => {
      const { cookies } = await loginAs(app, ALFA_ADMIN);
      const response = await app.inject({ method: 'POST', url: '/auth/refresh', cookies });
      const rotated = cookiesFrom(response);

      expect(response.statusCode).toBe(200);
      expect(rotated.imob_rt).toBeTruthy();
      expect(rotated.imob_rt).not.toBe(cookies.imob_rt);
    });

    it('recusa reapresentacao de um refresh token ja usado', async () => {
      // Uso unico. Se o token foi roubado e reutilizado, ou se duas abas
      // renovaram juntas, a sessao cai -- em ambos os casos, de proposito.
      const { cookies } = await loginAs(app, ALFA_ADMIN);
      const first = await app.inject({ method: 'POST', url: '/auth/refresh', cookies });
      expect(first.statusCode).toBe(200);

      const replay = await app.inject({ method: 'POST', url: '/auth/refresh', cookies });
      expect(replay.statusCode).toBe(401);
    });

    it('limpa os cookies quando o refresh falha', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/auth/refresh',
        cookies: { imob_rt: 'token-que-nunca-existiu' },
      });

      expect(response.statusCode).toBe(401);
      // Deixar token morto no browser faz o front tentar renovar em loop.
      const cleared = response.cookies.filter((c) => c.name === 'imob_rt' && c.value === '');
      expect(cleared.length).toBeGreaterThan(0);
    });
  });

  describe('logout', () => {
    it('invalida o refresh token', async () => {
      const { cookies } = await loginAs(app, ALFA_ADMIN);

      const logout = await app.inject({ method: 'POST', url: '/auth/logout', cookies });
      expect(logout.statusCode).toBe(204);

      const afterLogout = await app.inject({ method: 'POST', url: '/auth/refresh', cookies });
      expect(afterLogout.statusCode).toBe(401);
    });
  });

  describe('revogacao', () => {
    it('derruba a sessao imediatamente, sem esperar o access token expirar', async () => {
      // O caso que mais importa numa rede fechada B2B: o desligamento de um
      // corretor precisa ter efeito agora, nao daqui a 15 minutos. Por isso o
      // preHandler confere o usuario no banco a cada request, e nao so a
      // assinatura do JWT.
      const { cookies } = await loginAs(app, BETA_AGENT);

      const before = await app.inject({ method: 'GET', url: '/auth/me', cookies });
      expect(before.statusCode).toBe(200);

      await getDb().execute(sql`
        SELECT auth_revoke_all_sessions(
          (SELECT id FROM auth_find_user_by_email(${BETA_AGENT}::citext))
        )
      `);

      const after = await app.inject({ method: 'GET', url: '/auth/me', cookies });
      expect(after.statusCode).toBe(401);
    });
  });
});

describe('rate limit do login', () => {
  let limitedApp: FastifyInstance;

  beforeAll(async () => {
    limitedApp = await buildApp({ rateLimit: true });
    await limitedApp.ready();
  });

  afterAll(async () => {
    await limitedApp.close();
  });

  it('barra forca bruta e varredura de e-mails apos 8 tentativas', async () => {
    // Nao e so contra adivinhacao de senha: sem limite, da para varrer e-mails
    // para descobrir quem sao os parceiros da rede.
    const codes: number[] = [];
    for (let i = 0; i < 12; i++) {
      const response = await limitedApp.inject({
        method: 'POST',
        url: '/auth/login',
        payload: { email: `varredura${i}@teste.test`, password: 'x' },
        remoteAddress: '203.0.113.77',
      });
      codes.push(response.statusCode);
    }

    expect(codes.filter((c) => c === 429).length).toBeGreaterThan(0);
    expect(codes.slice(0, 8).every((c) => c === 401)).toBe(true);
    expect(codes.at(-1)).toBe(429);
  });
});
