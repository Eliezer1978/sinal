/**
 * Gravação da edição.
 *
 * O site guarda 30 dias de links, mas ninguém quer baixar 30 dias a cada vez
 * que abre a página no celular. Por isso a saída é dividida:
 *
 *   latest.json        edição atual, completa, com metadados. É o que abre primeiro.
 *   dias/AAAA-MM-DD    só os itens daquele dia. O site busca os que precisar.
 *   indice.json        que dias existem e quantos itens cada um tem.
 *
 * Um link aparece em vários arquivos de dia, porque as janelas se sobrepõem.
 * O site junta tudo pelo id, que é derivado do endereço e não muda.
 */

import { readdir, writeFile, mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
export const DATA = join(__dirname, '..', 'site', 'data');
export const DIAS = join(DATA, 'dias');

/** O dia da edição é o de Brasília, não o do servidor do GitHub. */
export function diaDaEdicao(date = new Date()) {
  return date.toLocaleDateString('sv-SE', { timeZone: 'America/Sao_Paulo' });
}

async function reconstruirIndice() {
  let arquivos = [];
  try {
    arquivos = (await readdir(DIAS)).filter((f) => /^\d{4}-\d{2}-\d{2}\.json$/.test(f));
  } catch {
    arquivos = [];
  }
  const dias = [];
  for (const f of arquivos.sort().reverse()) {
    dias.push({ dia: f.slice(0, 10) });
  }
  return dias;
}

export async function gravarEdicao(out) {
  await mkdir(DIAS, { recursive: true });

  const dia = diaDaEdicao();

  // arquivo do dia: só os itens, os metadados vêm do latest
  await writeFile(
    join(DIAS, `${dia}.json`),
    JSON.stringify({ dia, geradoEm: out.generatedAt, itens: out.items }),
    'utf8'
  );

  const dias = await reconstruirIndice();
  await writeFile(
    join(DATA, 'indice.json'),
    JSON.stringify({ atualizadoEm: out.generatedAt, dias }),
    'utf8'
  );

  out.acervo = { dias: dias.map((d) => d.dia), diaAtual: dia };
  await writeFile(join(DATA, 'latest.json'), JSON.stringify(out), 'utf8');

  return { dia, totalDias: dias.length };
}
