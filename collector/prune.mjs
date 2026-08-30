#!/usr/bin/env node
/**
 * Mantém apenas os últimos N dias do acervo e reconstrói o índice.
 *
 * Favoritos não dependem disto: o site guarda uma cópia própria de cada
 * matéria favoritada no aparelho, com título, fonte e link. Mesmo que o dia
 * saia do acervo, o favorito continua lá.
 */

import { readdir, unlink, stat, writeFile, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { DATA, DIAS } from './saida.mjs';

const KEEP_DAYS = parseInt(process.env.KEEP_DAYS || '30', 10);
const corte = new Date(Date.now() - KEEP_DAYS * 86400000)
  .toLocaleDateString('sv-SE', { timeZone: 'America/Sao_Paulo' });

let arquivos;
try {
  arquivos = (await readdir(DIAS)).filter((f) => /^\d{4}-\d{2}-\d{2}\.json$/.test(f));
} catch {
  console.log('acervo ainda não existe — nada a podar');
  process.exit(0);
}

let removidos = 0, bytes = 0;
for (const f of arquivos) {
  if (f.slice(0, 10) >= corte) continue;
  try {
    bytes += (await stat(join(DIAS, f))).size;
    await unlink(join(DIAS, f));
    removidos++;
  } catch { /* ignora */ }
}

const mantidos = arquivos.filter((f) => f.slice(0, 10) >= corte).sort().reverse();

// o índice precisa refletir a poda, senão o site pede dias que não existem mais
let atualizadoEm = new Date().toISOString();
try {
  atualizadoEm = JSON.parse(await readFile(join(DATA, 'indice.json'), 'utf8')).atualizadoEm || atualizadoEm;
} catch { /* primeira execução */ }

await writeFile(
  join(DATA, 'indice.json'),
  JSON.stringify({ atualizadoEm, dias: mantidos.map((f) => ({ dia: f.slice(0, 10) })) }),
  'utf8'
);

console.log(
  `acervo: ${mantidos.length} dia(s) mantido(s), ${removidos} removido(s)` +
  (bytes ? ` (${(bytes / 1048576).toFixed(1)} MB liberados)` : '')
);
