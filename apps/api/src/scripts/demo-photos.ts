import sharp from 'sharp';

/**
 * Fotos ilustrativas para os dados de demonstracao.
 *
 * Desenho vetorial (SVG) convertido em WebP pelo sharp. Nada e baixado da
 * internet: sem licenca de imagem para conferir, sem dependencia de rede para
 * subir o ambiente, e o mesmo imovel gera sempre as mesmas fotos.
 *
 * A cena segue o tipo do imovel e a posicao da foto: a primeira e a fachada
 * (ou o terreno), as seguintes sao ambientes internos. A paleta sai do id do
 * imovel, entao todas as fotos de um mesmo anuncio combinam entre si.
 *
 * Sem texto no desenho: renderizar fonte depende do fontconfig da maquina, e
 * uma marca d'agua seria justamente o que o produto pede para evitar.
 */

export const DEMO_PHOTO_WIDTH = 1600;
export const DEMO_PHOTO_HEIGHT = 1067;

const W = DEMO_PHOTO_WIDTH;
const H = DEMO_PHOTO_HEIGHT;

type Rng = () => number;

/** FNV-1a para semear, LCG para sortear. Deterministico por string. */
function rngFrom(seed: string): Rng {
  let hash = 0x811c9dc5;
  for (let i = 0; i < seed.length; i++) {
    hash ^= seed.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  let state = hash >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 0x100000000;
  };
}

const pick = <T>(rng: Rng, items: readonly T[]): T => items[Math.floor(rng() * items.length)] as T;
const range = (rng: Rng, min: number, max: number): number => min + rng() * (max - min);
const n = (value: number): string => String(Math.round(value * 10) / 10);

/** Clareia (amount > 0) ou escurece (amount < 0) uma cor hex, em porcentagem. */
function shade(hex: string, amount: number): string {
  const value = parseInt(hex.slice(1), 16);
  const channels = [(value >> 16) & 255, (value >> 8) & 255, value & 255].map((c) =>
    amount < 0 ? c * (1 + amount / 100) : c + (255 - c) * (amount / 100),
  );
  return `#${channels
    .map((c) => Math.round(Math.max(0, Math.min(255, c))).toString(16).padStart(2, '0'))
    .join('')}`;
}

function rect(x: number, y: number, w: number, h: number, fill: string, attrs = ''): string {
  return `<rect x="${n(x)}" y="${n(y)}" width="${n(w)}" height="${n(h)}" fill="${fill}"${attrs ? ` ${attrs}` : ''}/>`;
}

function poly(points: Array<[number, number]>, fill: string, attrs = ''): string {
  return `<polygon points="${points.map(([x, y]) => `${n(x)},${n(y)}`).join(' ')}" fill="${fill}"${attrs ? ` ${attrs}` : ''}/>`;
}

// ---------------------------------------------------------------------------
// Paleta
// ---------------------------------------------------------------------------

interface Sky {
  top: string;
  bottom: string;
  glow: string;
}

const SKIES: readonly Sky[] = [
  { top: '#5f9fd6', bottom: '#d9ebf7', glow: '#ffffff' },
  { top: '#8fb2cc', bottom: '#eef2f3', glow: '#fff8e8' },
  { top: '#e39a62', bottom: '#fbe1c0', glow: '#fff0d2' },
  { top: '#4a82c3', bottom: '#cfe2f2', glow: '#ffffff' },
];
const FACADES = ['#e8e2d8', '#d9d4cc', '#c9c2b6', '#ecebe7', '#bdb6aa', '#dcd3c3'];
const WALLS = ['#eee8df', '#e6e1d9', '#dfe3e0', '#ebe5da', '#e2dbd1', '#d9dee1'];
const WOODS = ['#b88a5e', '#a77b52', '#c49a6c', '#8f6a4a', '#cdab82'];
const ACCENTS = ['#3f5d7a', '#7a5a3f', '#5f7a52', '#8a4b3c', '#44546a', '#9a7b3c'];
const GREENS = ['#4f7a45', '#5d8a4e', '#3f6b3a', '#6b8f55'];
const ROOFS = ['#7a4a3a', '#5a5f66', '#8a5a44', '#4b5058'];
const FABRICS = ['#8c8a86', '#b7b1a6', '#5f6b73', '#a89880', '#6d7a6a'];

interface Style {
  sky: Sky;
  facade: string;
  wall: string;
  wood: string;
  accent: string;
  green: string;
  roof: string;
  fabric: string;
}

function makeStyle(rng: Rng): Style {
  return {
    sky: pick(rng, SKIES),
    facade: pick(rng, FACADES),
    wall: pick(rng, WALLS),
    wood: pick(rng, WOODS),
    accent: pick(rng, ACCENTS),
    green: pick(rng, GREENS),
    roof: pick(rng, ROOFS),
    fabric: pick(rng, FABRICS),
  };
}

// ---------------------------------------------------------------------------
// Pecas reaproveitadas
// ---------------------------------------------------------------------------

function document(defs: string, body: string): string {
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">` +
    `<defs>${defs}` +
    '<radialGradient id="vignette" cx="0.5" cy="0.45" r="0.75">' +
    '<stop offset="0.6" stop-color="#000000" stop-opacity="0"/>' +
    '<stop offset="1" stop-color="#000000" stop-opacity="0.3"/></radialGradient>' +
    `</defs>${body}${rect(0, 0, W, H, 'url(#vignette)')}</svg>`
  );
}

function skyDefs(style: Style, sunX: number): string {
  const { top, bottom, glow } = style.sky;
  return (
    `<linearGradient id="sky" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${top}"/><stop offset="1" stop-color="${bottom}"/></linearGradient>` +
    `<radialGradient id="sun" cx="${n(sunX / W)}" cy="0.12" r="0.55"><stop offset="0" stop-color="${glow}" stop-opacity="0.75"/><stop offset="1" stop-color="${glow}" stop-opacity="0"/></radialGradient>` +
    `<linearGradient id="glass" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${shade(bottom, -12)}"/><stop offset="0.55" stop-color="${shade(top, -28)}"/><stop offset="1" stop-color="#34424d"/></linearGradient>`
  );
}

function skyLayer(style: Style, rng: Rng, horizon: number): { defs: string; body: string } {
  let clouds = '';
  const count = Math.floor(range(rng, 2, 5));
  for (let i = 0; i < count; i++) {
    const cx = range(rng, 0, W);
    const cy = range(rng, 60, horizon * 0.42);
    const s = range(rng, 60, 130);
    clouds +=
      `<g fill="#ffffff" opacity="${n(range(rng, 0.35, 0.6))}">` +
      `<ellipse cx="${n(cx)}" cy="${n(cy)}" rx="${n(s * 1.6)}" ry="${n(s * 0.42)}"/>` +
      `<ellipse cx="${n(cx + s * 0.5)}" cy="${n(cy - s * 0.24)}" rx="${n(s)}" ry="${n(s * 0.45)}"/></g>`;
  }
  return {
    defs: skyDefs(style, range(rng, 200, 1400)),
    body: rect(0, 0, W, horizon + 2, 'url(#sky)') + rect(0, 0, W, horizon, 'url(#sun)') + clouds,
  };
}

function tree(x: number, baseY: number, size: number, green: string): string {
  return (
    rect(x - size * 0.06, baseY - size * 0.9, size * 0.12, size * 0.9, '#5b4636') +
    `<circle cx="${n(x)}" cy="${n(baseY - size * 1.05)}" r="${n(size * 0.55)}" fill="${green}"/>` +
    `<circle cx="${n(x - size * 0.36)}" cy="${n(baseY - size * 0.78)}" r="${n(size * 0.4)}" fill="${shade(green, 8)}"/>` +
    `<circle cx="${n(x + size * 0.38)}" cy="${n(baseY - size * 0.84)}" r="${n(size * 0.42)}" fill="${shade(green, -14)}"/>`
  );
}

function shrubs(rng: Rng, fromX: number, toX: number, baseY: number, green: string): string {
  let out = '';
  for (let x = fromX; x < toX; x += range(rng, 46, 84)) {
    const r = range(rng, 26, 46);
    const tone = pick(rng, [green, shade(green, -14), shade(green, 10)]);
    out += `<circle cx="${n(x)}" cy="${n(baseY - r * 0.55)}" r="${n(r)}" fill="${tone}"/>`;
  }
  return out;
}

function plant(x: number, baseY: number, green: string, scale = 1): string {
  const s = scale;
  let leaves = '';
  const angles = [-50, -25, 0, 25, 50, -10, 15];
  for (const [i, angle] of angles.entries()) {
    const cx = x + angle * 0.9 * s;
    const cy = baseY - (130 + (i % 3) * 22) * s;
    leaves += `<ellipse cx="${n(cx)}" cy="${n(cy)}" rx="${n(20 * s)}" ry="${n(62 * s)}" fill="${i % 2 ? shade(green, -12) : green}" transform="rotate(${angle} ${n(cx)} ${n(cy)})"/>`;
  }
  return leaves + rect(x - 42 * s, baseY - 84 * s, 84 * s, 84 * s, '#d8d2c8', `rx="${n(8 * s)}"`);
}

function woodFloor(style: Style, floorY: number): string {
  let out = rect(0, floorY, W, H - floorY, style.wood);
  let y = floorY;
  let gap = 16;
  while (y < H) {
    out += rect(0, y, W, 2, shade(style.wood, -20), 'opacity="0.5"');
    y += gap;
    gap *= 1.28;
  }
  return out;
}

function roomWindow(style: Style, x: number, y: number, w: number, h: number): string {
  const frame = shade(style.wall, -32);
  return (
    rect(x, y, w, h, frame) +
    rect(x + 14, y + 14, w - 28, h - 28, 'url(#sky)') +
    rect(x + 14, y + h - 14 - h * 0.22, w - 28, h * 0.22, shade(style.green, -8), 'opacity="0.75"') +
    rect(x + w / 2 - 5, y, 10, h, frame) +
    rect(x, y + h * 0.38, w, 10, frame) +
    rect(x - 20, y + h, w + 40, 16, shade(style.wall, -14))
  );
}

function lightDefs(cx: number, cy: number): string {
  return (
    `<radialGradient id="light" cx="${n(cx / W)}" cy="${n(cy / H)}" r="0.65">` +
    '<stop offset="0" stop-color="#ffffff" stop-opacity="0.38"/>' +
    '<stop offset="1" stop-color="#ffffff" stop-opacity="0"/></radialGradient>'
  );
}

function wallArt(style: Style, rng: Rng, x: number, y: number, w: number, h: number): string {
  return (
    rect(x, y, w, h, '#2e2e2e') +
    rect(x + 12, y + 12, w - 24, h - 24, '#f4f3f0') +
    `<circle cx="${n(x + w * range(rng, 0.3, 0.45))}" cy="${n(y + h * 0.5)}" r="${n(h * 0.24)}" fill="${style.accent}"/>` +
    rect(x + w * 0.52, y + h * 0.3, w * 0.28, h * 0.42, shade(style.accent, 45)) +
    rect(x + w * 0.18, y + h * 0.78, w * 0.64, 6, '#2e2e2e', 'opacity="0.5"')
  );
}

// ---------------------------------------------------------------------------
// Fachadas
// ---------------------------------------------------------------------------

function apartmentExterior(style: Style, rng: Rng): string {
  const horizon = 880;
  const sky = skyLayer(style, rng, horizon);

  let skyline = '';
  for (let x = -20; x < W; ) {
    const w = range(rng, 90, 190);
    const h = range(rng, 140, 380);
    skyline += rect(x, horizon - h, w, h, shade(style.sky.top, -20), 'opacity="0.28"');
    x += w + range(rng, 8, 40);
  }

  const bw = range(rng, 440, 540);
  const sideW = 120;
  const bx = range(rng, 360, W - bw - sideW - 360);
  const top = range(rng, 70, 190);
  const floorH = 56;
  const rows = Math.floor((horizon - 150 - top) / floorH);
  const cols = bw > 490 ? 6 : 5;
  const pad = 34;
  const cellW = (bw - pad * 2) / cols;

  let building =
    rect(bx - 12, top - 26, bw + 24, 30, shade(style.facade, -32)) +
    rect(bx, top, bw, horizon - top, style.facade) +
    poly(
      [
        [bx + bw, top],
        [bx + bw + sideW, top + 36],
        [bx + bw + sideW, horizon],
        [bx + bw, horizon],
      ],
      shade(style.facade, -24),
    );

  for (let row = 0; row < rows; row++) {
    const y = top + 40 + row * floorH;
    for (let c = 0; c < cols; c++) {
      const lit = rng() < 0.1;
      building += rect(bx + pad + c * cellW + 5, y, cellW - 10, floorH - 22, lit ? '#f1d9a0' : 'url(#glass)');
    }
    building += rect(bx - 6, y + floorH - 20, bw + 12, 9, shade(style.facade, 14));
    building += poly(
      [
        [bx + bw + 22, y + 8],
        [bx + bw + sideW - 22, y + 14],
        [bx + bw + sideW - 22, y + floorH - 24],
        [bx + bw + 22, y + floorH - 26],
      ],
      '#3f4d58',
      'opacity="0.7"',
    );
  }

  const lobbyW = bw * 0.42;
  building +=
    rect(bx + (bw - lobbyW) / 2, horizon - 120, lobbyW, 120, 'url(#glass)') +
    rect(bx + (bw - lobbyW) / 2 - 30, horizon - 138, lobbyW + 60, 18, style.accent);

  const ground =
    rect(0, horizon, W, H - horizon, '#bdb9b0') +
    rect(0, horizon, W, 34, style.green) +
    rect(0, 986, W, 6, '#e8e5de') +
    rect(0, 992, W, H - 992, '#6f716f');

  const greenery =
    shrubs(rng, 0, bx - 20, horizon + 30, style.green) +
    shrubs(rng, bx + bw + sideW + 20, W, horizon + 30, style.green) +
    tree(range(rng, 110, 260), horizon + 26, range(rng, 190, 250), style.green) +
    tree(W - range(rng, 110, 260), horizon + 26, range(rng, 190, 250), shade(style.green, -8));

  return document(sky.defs, sky.body + skyline + building + ground + greenery);
}

function houseExterior(style: Style, rng: Rng, condominium: boolean): string {
  const horizon = 700;
  const sky = skyLayer(style, rng, horizon);
  const defs =
    sky.defs +
    `<linearGradient id="lawn" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${shade(style.green, 12)}"/><stop offset="1" stop-color="${shade(style.green, -18)}"/></linearGradient>`;

  let back = '';
  for (let x = -40; x < W + 40; x += range(rng, 50, 90)) {
    const r = range(rng, 40, 80);
    back += `<circle cx="${n(x)}" cy="${n(horizon - r * 0.45)}" r="${n(r)}" fill="${shade(style.green, -24)}" opacity="0.9"/>`;
  }
  if (condominium) {
    for (const x of [range(rng, 40, 140), range(rng, 1320, 1420)]) {
      back +=
        rect(x, horizon - 110, 180, 110, shade(style.facade, 6), 'opacity="0.85"') +
        poly(
          [
            [x - 16, horizon - 106],
            [x + 90, horizon - 170],
            [x + 196, horizon - 106],
          ],
          shade(style.roof, 10),
          'opacity="0.85"',
        );
    }
  }
  back += rect(0, horizon, W, H - horizon, 'url(#lawn)');

  const x0 = range(rng, 230, 380);
  const base = 850;
  const bodyTop = 520;
  const bodyW = 720;
  const modern = rng() < 0.5;
  let house = '';

  if (modern) {
    house +=
      rect(x0 + bodyW * 0.5, bodyTop - 170, bodyW * 0.5, 170, style.facade) +
      rect(x0 + bodyW * 0.5 + 40, bodyTop - 130, bodyW * 0.5 - 80, 90, 'url(#glass)') +
      rect(x0 + bodyW * 0.5 - 24, bodyTop - 200, bodyW * 0.5 + 64, 30, shade(style.roof, -12)) +
      rect(x0 - 40, bodyTop - 30, bodyW + 80, 30, shade(style.roof, -12));
  } else {
    house +=
      poly(
        [
          [x0 - 50, bodyTop + 6],
          [x0 + bodyW / 2, bodyTop - 210],
          [x0 + bodyW + 50, bodyTop + 6],
        ],
        style.roof,
      ) + rect(x0 - 50, bodyTop, bodyW + 100, 14, shade(style.roof, -22));
  }

  house += rect(x0, bodyTop + (modern ? 0 : 14), bodyW, base - bodyTop - (modern ? 0 : 14), style.facade);
  if (modern) {
    house += rect(x0, bodyTop, bodyW * 0.28, base - bodyTop, style.wood);
    for (let x = x0 + 18; x < x0 + bodyW * 0.28; x += 18) {
      house += rect(x, bodyTop, 2, base - bodyTop, shade(style.wood, -22), 'opacity="0.6"');
    }
  } else {
    house +=
      rect(x0 + 50, bodyTop + 90, 150, 120, shade(style.facade, -36)) +
      rect(x0 + 60, bodyTop + 100, 130, 100, 'url(#glass)');
  }

  const winX = x0 + bodyW * 0.33;
  house +=
    rect(winX, bodyTop + 70, 260, 200, shade(style.facade, -40)) +
    rect(winX + 10, bodyTop + 80, 240, 180, 'url(#glass)') +
    rect(winX + 127, bodyTop + 70, 6, 200, shade(style.facade, -40));

  const doorX = x0 + bodyW * 0.74;
  house += rect(doorX, base - 210, 96, 210, shade(style.wood, -18)) + rect(doorX + 74, base - 112, 8, 30, '#d9d4c7');

  const gx = x0 + bodyW;
  house +=
    rect(gx, base - 250, 280, 250, shade(style.facade, -6)) +
    rect(gx - 10, base - 266, 300, 20, shade(style.roof, -12)) +
    rect(gx + 30, base - 200, 220, 200, '#d9d6cf');
  for (let y = base - 176; y < base; y += 26) house += rect(gx + 30, y, 220, 3, '#bdb8af');

  const paths =
    poly(
      [
        [gx + 30, base],
        [gx + 250, base],
        [gx + 400, H],
        [gx - 60, H],
      ],
      '#cfcac1',
    ) +
    poly(
      [
        [doorX, base],
        [doorX + 96, base],
        [doorX + 150, H],
        [doorX - 60, H],
      ],
      '#d8d2c6',
    );

  const greenery =
    shrubs(rng, x0 - 20, doorX - 20, base + 10, style.green) +
    tree(range(rng, 70, 170), base + 40, range(rng, 220, 280), style.green) +
    tree(W - range(rng, 50, 120), base + 70, range(rng, 240, 290), shade(style.green, -8)) +
    (condominium ? shrubs(rng, -20, W + 20, H + 20, shade(style.green, -6)) : '');

  return document(defs, sky.body + back + house + paths + greenery);
}

function commercialExterior(style: Style, rng: Rng, type: string): string {
  const horizon = 880;
  const sky = skyLayer(style, rng, horizon);

  if (type === 'galpao') {
    const metal = pick(rng, ['#c9ccce', '#b8bec2', '#d3d0c8']);
    let shed =
      poly(
        [
          [120, 500],
          [800, 380],
          [1480, 500],
        ],
        shade(metal, -25),
      ) + rect(140, 490, 1320, horizon - 490, metal);
    for (let x = 160; x < 1460; x += 24) shed += rect(x, 500, 2, horizon - 500, shade(metal, -14));
    for (const x of [300, 700]) {
      shed += rect(x, horizon - 280, 300, 280, '#8f969b');
      for (let y = horizon - 260; y < horizon; y += 22) shed += rect(x, y, 300, 3, '#7c8388');
    }
    shed += rect(1060, 580, 320, 90, 'url(#glass)') + rect(140, 520, 1320, 16, style.accent);
    const ground = rect(0, horizon, W, H - horizon, '#a9a59d') + rect(0, horizon, W, 6, '#d9d5cc');
    return document(sky.defs, sky.body + shed + ground + tree(range(rng, 40, 90), horizon + 20, 220, style.green));
  }

  let skyline = '';
  for (let x = -20; x < W; ) {
    const w = range(rng, 100, 200);
    const h = range(rng, 160, 420);
    skyline += rect(x, horizon - h, w, h, shade(style.sky.top, -22), 'opacity="0.26"');
    x += w + range(rng, 10, 36);
  }

  const bx = range(rng, 240, 340);
  const bw = W - bx * 2;
  const top = range(rng, 150, 270);
  const body = shade('#56606a', range(rng, 0, 25));
  let building = rect(bx, top, bw, horizon - top, body);

  const cols = 9;
  const paneW = (bw - 60) / cols;
  const storefront = type === 'loja' ? 250 : 150;
  for (let y = top + 30; y < horizon - storefront - 70; y += 80) {
    for (let c = 0; c < cols; c++) {
      building += rect(bx + 30 + c * paneW + 4, y, paneW - 8, 72, 'url(#glass)');
      if (rng() < 0.25) building += rect(bx + 30 + c * paneW + 4, y, paneW - 8, 72, '#ffffff', 'opacity="0.1"');
    }
  }

  if (type === 'loja') {
    building +=
      rect(bx + 40, horizon - 220, bw - 80, 220, 'url(#glass)') +
      rect(bx + 20, horizon - 252, bw - 40, 36, style.accent);
    for (let x = bx + 40 + (bw - 80) / 4; x < bx + bw - 60; x += (bw - 80) / 4) {
      building += rect(x - 4, horizon - 220, 8, 220, '#2f3b45');
    }
  } else {
    const lobbyW = bw * 0.3;
    building +=
      rect(bx + (bw - lobbyW) / 2, horizon - 140, lobbyW, 140, 'url(#glass)') +
      rect(bx + (bw - lobbyW) / 2 - 40, horizon - 160, lobbyW + 80, 20, style.accent);
  }

  const ground =
    rect(0, horizon, W, H - horizon, '#bcb8af') + rect(0, 986, W, 6, '#e8e5de') + rect(0, 992, W, H - 992, '#6f716f');

  const greenery =
    rect(bx + 60, horizon - 10, 160, 50, '#8d8a84') +
    shrubs(rng, bx + 80, bx + 210, horizon, style.green) +
    rect(bx + bw - 220, horizon - 10, 160, 50, '#8d8a84') +
    shrubs(rng, bx + bw - 200, bx + bw - 70, horizon, style.green) +
    tree(range(rng, 80, 180), horizon + 40, range(rng, 200, 250), style.green);

  return document(sky.defs, sky.body + skyline + building + ground + greenery);
}

function landScene(style: Style, rng: Rng): string {
  const horizon = range(rng, 540, 620);
  const sky = skyLayer(style, rng, horizon);
  const defs =
    sky.defs +
    `<linearGradient id="field" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${shade(style.green, 22)}"/><stop offset="1" stop-color="${shade(style.green, -12)}"/></linearGradient>`;

  let scene =
    `<path d="M0 ${n(horizon)} Q ${n(W * 0.25)} ${n(horizon - range(rng, 90, 150))} ${n(W * 0.5)} ${n(horizon - 30)} T ${W} ${n(horizon - 70)} L ${W} ${n(horizon)} Z" fill="${shade(style.green, 32)}" opacity="0.55"/>` +
    `<path d="M0 ${n(horizon)} Q ${n(W * 0.6)} ${n(horizon - range(rng, 40, 90))} ${W} ${n(horizon - 20)} L ${W} ${n(horizon)} Z" fill="${shade(style.green, 16)}" opacity="0.7"/>`;

  for (let x = range(rng, -40, 200); x < W; x += range(rng, 30, 70)) {
    if (rng() < 0.35) {
      x += range(rng, 80, 220);
      continue;
    }
    const r = range(rng, 22, 44);
    scene += `<circle cx="${n(x)}" cy="${n(horizon - r * 0.5)}" r="${n(r)}" fill="${shade(style.green, -26)}"/>`;
  }

  scene += rect(0, horizon, W, H - horizon, 'url(#field)');

  const vx = W / 2;
  for (let i = 0; i < 10; i += 2) {
    const b0 = -500 + i * 290;
    const b1 = b0 + 290;
    scene += poly(
      [
        [vx + (i - 5) * 6, horizon],
        [vx + (i - 4) * 6, horizon],
        [b1, H],
        [b0, H],
      ],
      '#ffffff',
      'opacity="0.05"',
    );
  }

  if (rng() < 0.6) {
    scene += poly(
      [
        [W * 0.52, horizon],
        [W * 0.545, horizon],
        [W * 0.8, H],
        [W * 0.44, H],
      ],
      '#c7ab80',
      'opacity="0.85"',
    );
  }

  if (rng() < 0.7) scene += tree(range(rng, 950, 1400), horizon + 70, range(rng, 150, 210), shade(style.green, -12));

  const fenceY = range(rng, H - 230, H - 170);
  for (let x = -20; x < W + 20; x += 150) scene += rect(x, fenceY - 80, 12, 110, '#6b5440');
  scene += rect(0, fenceY - 62, W, 3, '#5a4636') + rect(0, fenceY - 28, W, 3, '#5a4636');

  return document(defs, sky.body + scene);
}

// ---------------------------------------------------------------------------
// Ambientes internos
// ---------------------------------------------------------------------------

type RoomKind = 'living' | 'kitchen' | 'bedroom' | 'bathroom' | 'office';

function livingRoom(style: Style, rng: Rng): string {
  const floorY = 720;
  const wx = range(rng, 960, 1060);
  const defs = skyDefs(style, 800) + lightDefs(wx + 220, 360);

  let s = rect(0, 0, W, floorY, style.wall) + rect(0, floorY - 16, W, 16, shade(style.wall, -10)) + woodFloor(style, floorY);
  s += roomWindow(style, wx, 120, 440, 500);
  s += rect(wx - 96, 90, 72, floorY - 106, shade(style.wall, -8));
  for (let x = wx - 84; x < wx - 30; x += 16) s += rect(x, 90, 3, floorY - 106, shade(style.wall, -18), 'opacity="0.6"');
  s += wallArt(style, rng, 300, 170, 380, 240);

  const sofa = style.fabric;
  s +=
    `<ellipse cx="560" cy="935" rx="540" ry="96" fill="${style.accent}" opacity="0.45"/>` +
    rect(170, 520, 760, 150, sofa, 'rx="22"') +
    rect(150, 640, 800, 120, shade(sofa, 8), 'rx="18"') +
    rect(120, 590, 80, 190, shade(sofa, -8), 'rx="20"') +
    rect(900, 590, 80, 190, shade(sofa, -8), 'rx="20"') +
    rect(190, 770, 14, 26, '#3a2f27') +
    rect(896, 770, 14, 26, '#3a2f27') +
    rect(240, 560, 170, 120, shade(sofa, 22), 'rx="16"') +
    rect(690, 560, 170, 120, style.accent, 'rx="16"') +
    rect(400, 836, 380, 22, shade(style.wood, -28), 'rx="6"') +
    rect(420, 858, 12, 70, shade(style.wood, -40)) +
    rect(748, 858, 12, 70, shade(style.wood, -40)) +
    rect(500, 812, 90, 24, style.accent, 'rx="3"') +
    rect(88, 380, 6, 400, '#2f2f2f') +
    poly(
      [
        [48, 386],
        [134, 386],
        [116, 320],
        [66, 320],
      ],
      '#efe8dc',
    ) +
    plant(1510, 880, style.green);

  s += rect(0, 0, W, H, 'url(#light)');
  return document(defs, s);
}

function kitchen(style: Style, rng: Rng): string {
  const floorY = 760;
  const defs =
    skyDefs(style, 1300) +
    lightDefs(1300, 330) +
    '<pattern id="tile" width="60" height="30" patternUnits="userSpaceOnUse">' +
    '<rect width="60" height="30" fill="#eceeee"/><path d="M0 0.5H60M0.5 0V30" stroke="#cdd3d3" stroke-width="2"/></pattern>';

  const cabinet = pick(rng, ['#f2f0ec', '#2f3a40', style.wood, '#7d8b84']);
  let s = rect(0, 0, W, floorY, style.wall) + woodFloor(style, floorY);
  s += roomWindow(style, 1120, 150, 360, 360);

  s += rect(100, 130, 900, 240, cabinet);
  for (let x = 250; x < 1000; x += 150) s += rect(x, 130, 3, 240, shade(cabinet, -18));
  s += rect(100, 370, 900, 190, 'url(#tile)');
  s += poly(
    [
      [430, 370],
      [670, 370],
      [620, 300],
      [480, 300],
    ],
    '#b9bec2',
  );
  s += rect(80, 556, 940, 28, '#dcdad5') + rect(100, 584, 900, 176, shade(cabinet, -4));
  for (let x = 250; x < 1000; x += 150) s += rect(x, 584, 3, 176, shade(cabinet, -20));
  for (let x = 160; x < 1000; x += 150) s += rect(x, 600, 40, 6, '#8a9096');
  s += rect(720, 548, 160, 10, '#9aa1a6') + `<path d="M800 548 V500 H840" stroke="#8a9096" stroke-width="8" fill="none"/>`;

  s += rect(300, 792, 1000, 30, '#e6e3de') + rect(330, 822, 940, 200, shade(cabinet, -8));
  for (const x of [460, 700, 940]) {
    s += rect(x + 10, 880, 6, 160, '#3a3a3a') + rect(x + 74, 880, 6, 160, '#3a3a3a') + rect(x, 866, 90, 18, style.accent, 'rx="8"');
  }
  for (const x of [520, 800, 1080]) {
    s +=
      rect(x - 1, 0, 2, 300, '#333333') +
      `<path d="M${x - 50} 332 A 50 50 0 0 1 ${x + 50} 332 Z" fill="#2f2f2f"/>` +
      `<ellipse cx="${x}" cy="338" rx="42" ry="10" fill="#fff3d6" opacity="0.8"/>`;
  }

  s += rect(0, 0, W, H, 'url(#light)');
  return document(defs, s);
}

function bedroom(style: Style, rng: Rng): string {
  const floorY = 740;
  const defs = skyDefs(style, 300) + lightDefs(240, 360);

  let s = rect(0, 0, W, floorY, style.wall) + rect(0, floorY - 14, W, 14, shade(style.wall, -10)) + woodFloor(style, floorY);
  s += roomWindow(style, 90, 130, 300, 480) + rect(410, 100, 60, floorY - 114, shade(style.wall, -8));
  s += wallArt(style, rng, 640, 170, 320, 200);

  s +=
    poly(
      [
        [360, 850],
        [1240, 850],
        [1420, 1045],
        [180, 1045],
      ],
      shade(style.accent, 40),
      'opacity="0.55"',
    ) +
    rect(420, 400, 760, 300, shade(style.fabric, 12), 'rx="18"');
  for (let x = 496; x < 1180; x += 76) s += rect(x, 410, 2, 280, shade(style.fabric, -10), 'opacity="0.5"');
  s +=
    rect(400, 700, 800, 110, shade(style.wood, -22), 'rx="10"') +
    rect(410, 600, 780, 130, '#f3f1ed', 'rx="18"') +
    rect(410, 672, 780, 70, style.accent, 'rx="12"') +
    rect(470, 556, 250, 90, '#ffffff', 'rx="30"') +
    rect(880, 556, 250, 90, '#fbfaf7', 'rx="30"') +
    rect(700, 584, 200, 70, shade(style.fabric, -12), 'rx="24"');

  for (const x of [250, 1210]) {
    s +=
      rect(x, 650, 140, 150, style.wood, 'rx="8"') +
      rect(x + 62, 580, 16, 70, '#3a3a3a') +
      poly(
        [
          [x + 30, 590],
          [x + 110, 590],
          [x + 94, 530],
          [x + 46, 530],
        ],
        '#efe8dc',
      );
  }

  s += rect(0, 0, W, H, 'url(#light)');
  return document(defs, s);
}

function bathroom(style: Style): string {
  const floorY = 780;
  const tone = shade(style.wall, 4);
  const defs =
    '<pattern id="wallTile" width="80" height="80" patternUnits="userSpaceOnUse">' +
    `<rect width="80" height="80" fill="${tone}"/><path d="M0 1H80M1 0V80" stroke="${shade(tone, -12)}" stroke-width="2"/></pattern>` +
    '<pattern id="floorTile" width="120" height="60" patternUnits="userSpaceOnUse">' +
    '<rect width="120" height="60" fill="#cfcac3"/><path d="M0 1H120M1 0V60" stroke="#b7b1a8" stroke-width="2"/></pattern>' +
    '<linearGradient id="mirror" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#f4f6f7"/><stop offset="1" stop-color="#c9d0d4"/></linearGradient>' +
    lightDefs(510, 200);

  let s = rect(0, 0, W, floorY, 'url(#wallTile)') + rect(0, floorY, W, H - floorY, 'url(#floorTile)');
  s +=
    rect(250, 170, 520, 360, shade(style.wall, -24), 'rx="12"') +
    rect(262, 182, 496, 336, 'url(#mirror)', 'rx="8"') +
    poly(
      [
        [330, 182],
        [430, 182],
        [290, 518],
        [262, 518],
        [262, 360],
      ],
      '#ffffff',
      'opacity="0.35"',
    ) +
    rect(300, 140, 420, 14, '#f7f3e8') +
    rect(200, 590, 620, 30, '#e6e3de') +
    rect(220, 620, 580, 190, style.wood, 'rx="6"') +
    rect(220, 712, 580, 3, shade(style.wood, -25)) +
    '<ellipse cx="510" cy="590" rx="120" ry="18" fill="#ffffff" stroke="#d6d4cf" stroke-width="3"/>' +
    rect(505, 545, 10, 45, '#8a9096') +
    plant(730, 590, style.green, 0.55) +
    rect(840, 290, 130, 10, '#8a9096') +
    rect(860, 300, 90, 260, style.accent, 'rx="8"') +
    rect(980, 120, 460, 740, '#cfe4ea', 'opacity="0.3" stroke="#9fb3bb" stroke-width="6"') +
    rect(1300, 170, 8, 120, '#8a9096') +
    rect(1250, 170, 110, 10, '#8a9096');

  s += rect(0, 0, W, H, 'url(#light)');
  return document(defs, s);
}

function office(style: Style, rng: Rng): string {
  const floorY = 760;
  const defs = skyDefs(style, 900) + lightDefs(800, 340);

  let s = rect(0, 0, W, floorY, style.wall) + rect(0, floorY, W, H - floorY, '#8d9296');
  for (let y = floorY + 20; y < H; y += 40) s += rect(0, y, W, 2, '#80858a', 'opacity="0.5"');

  s += rect(60, 110, 1480, 470, '#2f363b') + rect(76, 126, 1448, 438, 'url(#sky)');
  for (let x = 76; x < 1524; ) {
    const w = Math.min(range(rng, 70, 160), 1524 - x);
    const h = range(rng, 90, 300);
    s += rect(x, 564 - h, w, h, shade(style.sky.top, -32), 'opacity="0.45"');
    x += w + range(rng, 6, 24);
  }
  for (let x = 350; x < 1540; x += 290) s += rect(x - 6, 110, 12, 470, '#2f363b');
  s += rect(40, 580, 1520, 18, shade(style.wall, -16));

  for (const x0 of [180, 900]) {
    s +=
      rect(x0, 740, 560, 22, '#e9e7e2') +
      rect(x0 + 20, 762, 14, 170, '#3a3f44') +
      rect(x0 + 526, 762, 14, 170, '#3a3f44') +
      rect(x0 + 200, 606, 180, 110, '#23282c', 'rx="6"') +
      rect(x0 + 282, 716, 16, 24, '#3a3f44') +
      rect(x0 + 230, 800, 120, 110, '#2e3439', 'rx="16"') +
      rect(x0 + 286, 910, 8, 60, '#3a3f44') +
      rect(x0 + 240, 966, 100, 8, '#3a3f44');
  }
  s += plant(1500, 900, style.green) + rect(0, 0, W, H, 'url(#light)');
  return document(defs, s);
}

function room(style: Style, rng: Rng, kind: RoomKind): string {
  switch (kind) {
    case 'living':
      return livingRoom(style, rng);
    case 'kitchen':
      return kitchen(style, rng);
    case 'bedroom':
      return bedroom(style, rng);
    case 'bathroom':
      return bathroom(style);
    case 'office':
      return office(style, rng);
  }
}

// ---------------------------------------------------------------------------
// Entrada
// ---------------------------------------------------------------------------

const HOME_ROOMS: readonly RoomKind[] = ['living', 'kitchen', 'bedroom', 'bathroom', 'bedroom', 'living'];
const WORK_ROOMS: readonly RoomKind[] = ['office', 'office', 'bathroom'];

export interface DemoPhotoInput {
  propertyId: string;
  type: string;
  position: number;
}

export function renderDemoPhotoSvg({ propertyId, type, position }: DemoPhotoInput): string {
  const style = makeStyle(rngFrom(propertyId));
  const rng = rngFrom(`${propertyId}:${position}`);

  if (type === 'terreno' || type === 'sitio_chacara') return landScene(style, rng);

  if (type === 'sala_comercial' || type === 'loja' || type === 'galpao') {
    if (position === 0 || type === 'galpao') return commercialExterior(style, rng, type);
    return room(style, rng, WORK_ROOMS[(position - 1) % WORK_ROOMS.length] ?? 'office');
  }

  if (position === 0) {
    return type === 'casa' || type === 'casa_condominio'
      ? houseExterior(style, rng, type === 'casa_condominio')
      : apartmentExterior(style, rng);
  }
  return room(style, rng, HOME_ROOMS[(position - 1) % HOME_ROOMS.length] ?? 'living');
}

export async function renderDemoPhoto(
  input: DemoPhotoInput,
): Promise<{ buffer: Buffer; width: number; height: number; byteSize: number }> {
  const output = await sharp(Buffer.from(renderDemoPhotoSvg(input)))
    .webp({ quality: 80 })
    .toBuffer({ resolveWithObject: true });
  return {
    buffer: output.data,
    width: output.info.width,
    height: output.info.height,
    byteSize: output.data.byteLength,
  };
}
