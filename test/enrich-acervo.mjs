#!/usr/bin/env node
/**
 * Teste do enrich sobre o acervo, com a API simulada.
 *
 * O que precisa ficar provado:
 *   1. a tradução alcança dias anteriores, não só a janela de 48h;
 *   2. o que foi traduzido uma vez é reaplicado de graça, sem nova chamada;
 *   3. nenhuma matéria é traduzida duas vezes;
 *   4. os arquivos de dia são regravados com a tradução;
 *   5. o teto por dia e o teto total são respeitados;
 *   6. nenhum item do acervo se perde no caminho.
 */

import { readFile, writeFile, readdir, cp, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const exec = promisify(execFile);
const __dirname = dirname(fileURLToPath(import.meta.url));
const RAIZ = join(__dirname, '..');
const DATA = join(RAIZ, 'site', 'data');
const DIAS = join(DATA, 'dias');
const ORIGINAL = join(RAIZ, '.data-original');

let falhas = 0, checagens = 0;
function ok(cond, nome, detalhe) {
  checagens++;
  if (cond) { console.log(`  ✓ ${nome}`); return; }
  falhas++;
  console.log(`  ✗ ${nome}${detalhe ? ` — ${detalhe}` : ''}`);
}

const ler = async (p) => JSON.parse(await readFile(p, 'utf8'));

async function diasDoAcervo() {
  return (await readdir(DIAS)).filter((f) => /^\d{4}-\d{2}-\d{2}\.json$/.test(f)).sort().reverse();
}

async function retrato() {
  const r = { dias: {}, latest: null };
  for (const f of await diasDoAcervo()) {
    const j = await ler(join(DIAS, f));
    r.dias[f.slice(0, 10)] = {
      total: j.itens.length,
      ids: j.itens.map((i) => i.id).sort().join(','),
      traduzidos: j.itens.filter((i) => i.title_pt).length,
    };
  }
  const l = await ler(join(DATA, 'latest.json'));
  r.latest = { total: l.items.length, traduzidos: l.items.filter((i) => i.title_pt).length, ai: l.ai };
  return r;
}

/** Roda o enrich com a API simulada e devolve quantas chamadas de tradução houve. */
async function rodarEnrich(env = {}) {
  const { stdout } = await exec(process.execPath, [join(__dirname, 'stub-api.mjs')], {
    cwd: RAIZ,
    env: { ...process.env, ...env },
    maxBuffer: 64 * 1024 * 1024,
  });
  const m = stdout.match(/__CHAMADAS__ (\d+) __ITENS__ (\d+)/);
  return {
    saida: stdout,
    chamadas: m ? Number(m[1]) : 0,
    itensPedidos: m ? Number(m[2]) : 0,
  };
}

async function restaurar() {
  await rm(DATA, { recursive: true, force: true });
  await cp(ORIGINAL, DATA, { recursive: true });
}

console.log('\nEnrich sobre o acervo\n');

// guarda o estado original para poder restaurar no fim
await rm(ORIGINAL, { recursive: true, force: true });
await cp(DATA, ORIGINAL, { recursive: true });

try {
  const antes = await retrato();
  const diasLista = Object.keys(antes.dias).sort().reverse();
  console.log(`  (acervo: ${diasLista.length} dias, ${antes.latest.total} itens na edição atual)\n`);

  // ---------------------------------------------------------------- 1ª volta
  console.log('1. primeira tradução, varrendo 3 dias com teto de 10 por dia');
  const r1 = await rodarEnrich({
    ANTHROPIC_API_KEY: 'teste',
    DIAS_TRADUZIR: '3',
    MAX_TRANSLATE_DIA: '10',
    MAX_TRANSLATE_TOTAL: '100',
    BATCH_SIZE: '20',
  });

  const depois1 = await retrato();
  const memoria1 = await ler(join(DATA, 'traducoes.json'));
  const nMem1 = Object.keys(memoria1.itens).length;

  ok(r1.itensPedidos > 0, 'houve tradução', `pediu ${r1.itensPedidos}`);
  ok(r1.itensPedidos <= 30, 'respeitou 3 dias × teto de 10', `pediu ${r1.itensPedidos}`);
  ok(nMem1 === r1.itensPedidos, 'memória guardou tudo que foi traduzido', `${nMem1} guardadas / ${r1.itensPedidos} pedidas`);

  const diasTocados = diasLista.filter((d) => depois1.dias[d] && depois1.dias[d].traduzidos > (antes.dias[d]?.traduzidos || 0));
  ok(diasTocados.length >= 2, 'a tradução alcançou mais de um dia do acervo', `dias tocados: ${diasTocados.join(', ') || 'nenhum'}`);

  const anteriores = diasTocados.filter((d) => d !== diasLista[0]);
  ok(anteriores.length >= 1, 'alcançou pelo menos um dia anterior ao de hoje', `anteriores: ${anteriores.join(', ') || 'nenhum'}`);

  // ---------------------------------------------------------------- 2ª volta
  console.log('\n2. rodando de novo, nas mesmas condições');
  const r2 = await rodarEnrich({
    ANTHROPIC_API_KEY: 'teste',
    DIAS_TRADUZIR: '3',
    MAX_TRANSLATE_DIA: '10',
    MAX_TRANSLATE_TOTAL: '100',
    BATCH_SIZE: '20',
  });
  const memoria2 = await ler(join(DATA, 'traducoes.json'));

  ok(!r2.saida.includes('__REPETIDA__'), 'nenhuma matéria foi traduzida duas vezes');
  ok(Object.keys(memoria2.itens).length >= nMem1, 'a memória não encolheu', `${nMem1} → ${Object.keys(memoria2.itens).length}`);

  // ------------------------------------------------------- 3. sem chave
  console.log('\n3. execução seguinte sem chave de API');
  const r3 = await rodarEnrich({ SEM_CHAVE: '1' });
  const depois3 = await retrato();

  ok(r3.chamadas === 0, 'não houve nenhuma chamada de API', `houve ${r3.chamadas}`);
  ok(depois3.latest.traduzidos > 0, 'a edição continua em português', `${depois3.latest.traduzidos} traduzidas`);
  ok(depois3.latest.ai && depois3.latest.ai.traduzidasAgora === 0, 'registrou zero traduções novas');
  ok(depois3.latest.ai && depois3.latest.ai.pendentes > 0, 'registrou quantas ainda faltam', `pendentes=${depois3.latest.ai?.pendentes}`);

  // ------------------------------------------------- 4. nada se perdeu
  console.log('\n4. integridade do acervo');
  let idsIguais = true, detalhe = '';
  for (const d of diasLista) {
    if (d === diasLista[0]) continue;   // o dia de hoje é reescrito pelo gravarEdicao
    if (antes.dias[d].ids !== depois3.dias[d]?.ids) {
      idsIguais = false;
      detalhe = `dia ${d}: ${antes.dias[d].total} → ${depois3.dias[d]?.total}`;
      break;
    }
  }
  ok(idsIguais, 'nenhum item saiu ou entrou nos dias anteriores', detalhe);

  const totalHoje = depois3.dias[diasLista[0]]?.total || 0;
  ok(totalHoje > 0 && Math.abs(totalHoje - antes.dias[diasLista[0]].total) <= antes.dias[diasLista[0]].total * 0.05,
    'o dia de hoje manteve o tamanho', `${antes.dias[diasLista[0]].total} → ${totalHoje}`);

  // ------------------------------------------------- 5. teto total
  console.log('\n5. teto total da execução');
  await restaurar();
  const r5 = await rodarEnrich({
    ANTHROPIC_API_KEY: 'teste',
    DIAS_TRADUZIR: '7',
    MAX_TRANSLATE_DIA: '100',
    MAX_TRANSLATE_TOTAL: '25',
    BATCH_SIZE: '20',
  });
  ok(r5.itensPedidos <= 25, 'o teto total foi respeitado', `pediu ${r5.itensPedidos}`);
  ok(r5.itensPedidos >= 20, 'e foi de fato usado', `pediu ${r5.itensPedidos}`);

} finally {
  await restaurar();
  await rm(ORIGINAL, { recursive: true, force: true });
  console.log('\n  (acervo restaurado ao estado original)');
}

console.log(`\n${falhas ? '✗' : '✓'} ${checagens - falhas}/${checagens} checagens passaram\n`);
process.exit(falhas ? 1 : 0);
