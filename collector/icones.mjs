#!/usr/bin/env node
/**
 * Gera os ícones do aplicativo, sem depender de nenhuma biblioteca.
 *
 * A marca é um medidor de sinal: quatro barras ascendentes sobre o verde do
 * site. Funciona bem em 60 pixels na tela do iPhone, que é o tamanho em que
 * o ícone vai ser visto de verdade.
 *
 * Desenha em resolução tripla e reduz depois, para as bordas saírem suaves.
 */

import { deflateSync } from 'node:zlib';
import { writeFile, mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DEST = join(__dirname, '..', 'site', 'icones');

const VERDE = [29, 92, 71];      // #1d5c47
const CLARO = [244, 250, 247];   // #f4faf7

// ---------------------------------------------------------------- PNG

const TABELA = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = TABELA[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function bloco(tipo, dados) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(dados.length, 0);
  const t = Buffer.from(tipo, 'ascii');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([t, dados])), 0);
  return Buffer.concat([len, t, dados, crc]);
}

function png(largura, altura, rgba) {
  const linha = largura * 4 + 1;
  const cru = Buffer.alloc(linha * altura);
  for (let y = 0; y < altura; y++) {
    cru[y * linha] = 0;                       // filtro: nenhum
    rgba.copy(cru, y * linha + 1, y * largura * 4, (y + 1) * largura * 4);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(largura, 0);
  ihdr.writeUInt32BE(altura, 4);
  ihdr[8] = 8;   // 8 bits por canal
  ihdr[9] = 6;   // RGBA
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    bloco('IHDR', ihdr),
    bloco('IDAT', deflateSync(cru, { level: 9 })),
    bloco('IEND', Buffer.alloc(0)),
  ]);
}

// ---------------------------------------------------------------- desenho

function dentroDoRetanguloArredondado(x, y, x0, y0, x1, y1, r) {
  if (x < x0 || x > x1 || y < y0 || y > y1) return false;
  const cx = Math.min(Math.max(x, x0 + r), x1 - r);
  const cy = Math.min(Math.max(y, y0 + r), y1 - r);
  const dx = x - cx, dy = y - cy;
  return dx * dx + dy * dy <= r * r;
}

/**
 * @param {number} lado   tamanho final em pixels
 * @param {boolean} recortavel  deixa margem para o Android cortar em círculo
 * @param {boolean} fundo  false gera a marca sem o quadrado, para uso solto
 */
function desenhar(lado, { recortavel = false, fundo = true } = {}) {
  const S = 3;                    // supersampling
  const L = lado * S;
  const acc = new Float64Array(lado * lado * 4);

  // área útil: no ícone recortável a marca encolhe para caber no círculo
  const margem = recortavel ? L * 0.26 : L * 0.20;
  const raioFundo = L * 0.22;

  const barras = 4;
  const larguraTotal = L - margem * 2;
  const vao = larguraTotal * 0.085;
  const larguraBarra = (larguraTotal - vao * (barras - 1)) / barras;
  const alturas = [0.34, 0.56, 0.78, 1.0];
  const baseY = L - margem;
  const raioBarra = larguraBarra * 0.32;

  for (let y = 0; y < L; y++) {
    for (let x = 0; x < L; x++) {
      let r = 0, g = 0, b = 0, a = 0;

      if (fundo && dentroDoRetanguloArredondado(x, y, 0, 0, L - 1, L - 1, raioFundo)) {
        r = VERDE[0]; g = VERDE[1]; b = VERDE[2]; a = 255;
      }

      for (let i = 0; i < barras; i++) {
        const bx0 = margem + i * (larguraBarra + vao);
        const bx1 = bx0 + larguraBarra;
        const alturaBarra = (L - margem * 2) * alturas[i];
        const by0 = baseY - alturaBarra;
        if (dentroDoRetanguloArredondado(x, y, bx0, by0, bx1, baseY, raioBarra)) {
          r = fundo ? CLARO[0] : VERDE[0];
          g = fundo ? CLARO[1] : VERDE[1];
          b = fundo ? CLARO[2] : VERDE[2];
          a = 255;
          break;
        }
      }

      const dx = Math.floor(x / S), dy = Math.floor(y / S);
      const p = (dy * lado + dx) * 4;
      acc[p] += r; acc[p + 1] += g; acc[p + 2] += b; acc[p + 3] += a;
    }
  }

  const n = S * S;
  const saida = Buffer.alloc(lado * lado * 4);
  for (let i = 0; i < lado * lado; i++) {
    const p = i * 4;
    const alfa = acc[p + 3] / n;
    // as cores foram acumuladas já multiplicadas pelo alfa; desfaz para não escurecer a borda
    saida[p] = alfa > 0 ? Math.round(acc[p] / n / (alfa / 255)) : 0;
    saida[p + 1] = alfa > 0 ? Math.round(acc[p + 1] / n / (alfa / 255)) : 0;
    saida[p + 2] = alfa > 0 ? Math.round(acc[p + 2] / n / (alfa / 255)) : 0;
    saida[p + 3] = Math.round(alfa);
  }
  return png(lado, lado, saida);
}

// ---------------------------------------------------------------- principal

await mkdir(DEST, { recursive: true });

const arquivos = [
  ['icone-32.png', desenhar(32)],
  ['icone-180.png', desenhar(180)],           // tela de início do iPhone
  ['icone-192.png', desenhar(192)],
  ['icone-512.png', desenhar(512)],
  ['icone-512-recortavel.png', desenhar(512, { recortavel: true })],
];

for (const [nome, buf] of arquivos) {
  await writeFile(join(DEST, nome), buf);
  console.log(`  ${nome.padEnd(26)} ${(buf.length / 1024).toFixed(1)} KB`);
}
console.log(`${arquivos.length} ícones gerados em site/icones/`);
