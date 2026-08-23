#!/usr/bin/env node
/**
 * Teste ponta a ponta do pipeline, contra os feeds falsos.
 * Roda com: npm test
 */

import { spawn } from 'node:child_process';
import { readFile, writeFile, mkdir, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startMockServer } from './mock-feeds.mjs';
import { regroup } from '../collector/cluster.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');

let pass = 0, fail = 0;
function check(label, cond, detail) {
  if (cond) { pass++; console.log(`  ✓ ${label}`); }
  else { fail++; console.log(`  ✗ ${label}${detail ? `\n      ${detail}` : ''}`); }
}

function run(script, env) {
  return new Promise((resolve) => {
    const p = spawn('node', [script], { cwd: ROOT, env: { ...process.env, ...env } });
    let out = '';
    p.stdout.on('data', (d) => { out += d; });
    p.stderr.on('data', (d) => { out += d; });
    p.on('close', (code) => resolve({ code, out }));
  });
}

const { server, port } = await startMockServer(0);
const base = `http://127.0.0.1:${port}`;

const feeds = {
  groups: { teste: 'Fontes de teste', brasil: 'Brasil' },
  sources: [
    { id: 'agencia',  name: 'Agência Teste',  group: 'teste',  type: 'rss', url: `${base}/agencia.xml`,   section: 'Geral',    lang: 'en', weight: 1.0,  paywall: false, site: base, hint: ['geopolitica'] },
    { id: 'diario',   name: 'Diário Teste',   group: 'teste',  type: 'rss', url: `${base}/diario.xml`,    section: 'Geral',    lang: 'en', weight: 0.9,  paywall: true,  site: base, hint: ['futuro-trabalho'] },
    { id: 'negocios', name: 'Negócios Teste', group: 'teste',  type: 'rss', url: `${base}/negocios.atom`, section: 'Empresas', lang: 'en', weight: 0.85, paywall: false, site: base, hint: ['negocios-inovacao'] },
    { id: 'gestao',   name: 'Gestão Teste',   group: 'teste',  type: 'rss', url: `${base}/gestao.xml`,    section: 'Geral',    lang: 'en', weight: 0.95, paywall: true,  site: base, hint: ['lideranca-gestao'] },
    { id: 'ensaio',   name: 'Ensaio Teste',   group: 'teste',  type: 'rss', url: `${base}/ensaio.xml`,    section: 'Geral',    lang: 'en', weight: 0.8,  paywall: false, site: base, hint: ['cultura-comportamento'] },
    { id: 'brasil',   name: 'Brasil Teste',   group: 'brasil', type: 'rss', url: `${base}/brasil.xml`,    section: 'Geral',    lang: 'pt', weight: 0.85, paywall: false, site: base, hint: ['brasil-politica'] },
    { id: 'mercado',  name: 'Mercado Teste',  group: 'brasil', type: 'rss', url: `${base}/mercado.rdf`,   section: 'Mercados', lang: 'pt', weight: 0.8,  paywall: false, site: base, hint: ['economia-mercados'] },
    { id: 'quebrado', name: 'Fonte Quebrada', group: 'teste',  type: 'rss', url: `${base}/quebrado.xml`,  section: '',         lang: 'en', weight: 0.5,  paywall: false, site: base, hint: [] },
    { id: 'lixo',     name: 'Fonte Corrompida','group': 'teste','type': 'rss', url: `${base}/lixo.xml`,   section: '',         lang: 'en', weight: 0.5,  paywall: false, site: base, hint: [] },
  ],
};

const tmpFeeds = join(__dirname, '.feeds.test.json');
await writeFile(tmpFeeds, JSON.stringify(feeds), 'utf8');

console.log('\n── Coleta ────────────────────────────────────────────');
const res = await run('collector/collect.mjs', {
  FEEDS_FILE: tmpFeeds, WINDOW_HOURS: '48', RETRIES: '0', TIMEOUT_MS: '5000',
});
console.log(res.out.split('\n').map((l) => '  ' + l).join('\n').trimEnd());

console.log('\n── Verificações ──────────────────────────────────────');
check('a coleta terminou sem erro fatal', res.code === 0, `código de saída ${res.code}`);

const data = JSON.parse(await readFile(join(ROOT, 'site/data/latest.json'), 'utf8'));
const items = data.items;
const byUrl = (frag) => items.find((i) => i.url.includes(frag));

check('7 fontes boas responderam', data.stats.sourcesOk === 7, `foram ${data.stats.sourcesOk}`);
check('2 fontes com defeito foram isoladas sem derrubar a coleta',
  data.stats.sourcesFailed === 2 && items.length > 0, `falhas: ${data.stats.sourcesFailed}`);

const fed = items.find((i) => /fed|federal reserve/i.test(i.title) && i.clusterSize > 1);
check('as 4 versões em inglês da decisão do Fed viraram uma matéria só',
  fed && fed.clusterSize === 4, fed ? `agrupou ${fed.clusterSize}` : 'nenhum grupo do Fed encontrado');
check('a matéria líder do grupo é a do veículo de maior peso',
  fed && fed.sourceId === 'agencia', fed && `líder: ${fed.sourceId}`);
check('as outras versões ficaram acessíveis em "também em"',
  fed && fed.alsoIn && fed.alsoIn.length === 3, fed && fed.alsoIn ? `${fed.alsoIn.length} extras` : 'sem alsoIn');
check('sem tradução, a versão em português fica separada (limite conhecido)',
  Boolean(byUrl('/fed-br')) && !(fed.alsoIn || []).some((a) => a.sourceId === 'brasil'));

const copom = items.find((i) => /copom|selic/i.test(i.title));
check('as 2 versões do Copom viraram uma só',
  copom && copom.clusterSize === 2, copom ? `agrupou ${copom.clusterSize}` : 'nenhuma');

check('matéria fora da janela de 48h foi descartada', !byUrl('/velha'));
check('matéria sem data foi mantida com a hora da coleta',
  byUrl('/nodate') && byUrl('/nodate').hasDate === false);

check('parâmetros de rastreamento sumiram da deduplicação',
  fed && !JSON.stringify(fed).includes('utm_source'));
check('HTML do resumo foi limpo',
  items.every((i) => !/<[a-z/]/i.test(i.summary || '')), 'sobrou tag em algum resumo');
check('imagem foi extraída quando existia',
  byUrl('/climate-1') && typeof byUrl('/climate-1').image === 'string');
check('feed Atom foi lido igual ao RSS', Boolean(byUrl('/chips')));
check('feed RDF foi lido igual ao RSS', Boolean(byUrl('/ibov')));

const has = (frag, topic) => {
  const it = byUrl(frag);
  return it && it.topics.includes(topic);
};
console.log('');
check('decisão do Fed → economia e mercados', fed && fed.topics.includes('economia-mercados'), fed && fed.topics.join(','));
check('cúpula do clima → ESG e clima', has('/climate-1', 'esg-clima'), byUrl('/climate-1')?.topics.join(','));
check('regulação europeia → IA e tecnologia', has('/ai-eu', 'ia-tecnologia'), byUrl('/ai-eu')?.topics.join(','));
check('semana de quatro dias → futuro do trabalho', has('/4day', 'futuro-trabalho'), byUrl('/4day')?.topics.join(','));
check('recuo em metas de diversidade → DEI', has('/dei-retreat', 'dei-equidade'), byUrl('/dei-retreat')?.topics.join(','));
check('times de alta performance → performance humana', has('/teams', 'performance-humana'), byUrl('/teams')?.topics.join(','));
check('reskilling → educação e aprendizagem', has('/reskill', 'educacao-aprendizagem'), byUrl('/reskill')?.topics.join(','));
check('reforma administrativa → política nacional', has('/reforma', 'brasil-politica'), byUrl('/reforma')?.topics.join(','));
check('educação corporativa no Brasil → educação e aprendizagem', has('/edu-corp', 'educacao-aprendizagem'), byUrl('/edu-corp')?.topics.join(','));
check('ensaio sobre solidão → cultura e comportamento', has('/lonely', 'cultura-comportamento'), byUrl('/lonely')?.topics.join(','));
check('burnout de gestores → liderança ou performance',
  has('/middle', 'lideranca-gestao') || has('/middle', 'performance-humana'), byUrl('/middle')?.topics.join(','));
check('fusão de logística → negócios e inovação', has('/merger', 'negocios-inovacao'), byUrl('/merger')?.topics.join(','));

console.log('');
check('toda matéria recebeu ao menos um tema',
  items.every((i) => i.topics.length > 0), 'alguma ficou sem tema');
check('resultado veio ordenado por pontuação',
  items.every((i, n) => n === 0 || items[n - 1].score >= i.score));
check('matéria mais recente e corroborada ficou no topo',
  items[0] && (items[0].clusterSize > 1 || (Date.now() - items[0].ts) < 6 * 3600000),
  items[0] && `topo: "${items[0].title.slice(0, 50)}" (grupo de ${items[0].clusterSize})`);
check('contagem por tema bate com os itens',
  data.topics.every((t) => t.count === items.filter((i) => i.topics.includes(t.id)).length));
check('contagem por fonte bate com os itens',
  data.sources.every((s) => s.count === items.filter((i) => i.sourceId === s.id).length));
check('fontes quebradas aparecem com o motivo do erro',
  data.sources.filter((s) => !s.ok).every((s) => typeof s.error === 'string' && s.error.length > 0));

console.log('\n── Segundo passe: agrupar depois de traduzir ─────────');
{
  // Simula o que a tradução devolveria, sem gastar chamada de API.
  const PT = {
    '/fed-1': 'Federal Reserve mantém os juros estáveis com a inflação em desaceleração',
    '/fed-2': 'Fed mantém os juros estáveis diante da inflação em desaceleração',
    '/fed-3': 'Federal Reserve mantém juros inalterados enquanto a inflação continua em desaceleração',
    '/fed-5': 'Federal Reserve deixa os juros intocados, citando inflação em desaceleração',
  };
  const traduzidos = items.map((it) => {
    const key = Object.keys(PT).find((k) => it.url.includes(k));
    return key ? { ...it, title_pt: PT[key] } : { ...it };
  });

  const antes = traduzidos.length;
  const depois = regroup(traduzidos, (it) => it.title_pt || it.title);
  const fedPt = depois.find((i) => /fed|juros/i.test(i.title_pt || i.title) && i.clusterSize > 1);

  check('traduzido, o grupo do Fed absorve a versão brasileira',
    fedPt && (fedPt.alsoIn || []).some((a) => a.sourceId === 'brasil'),
    fedPt ? `grupo de ${fedPt.clusterSize}: ${(fedPt.alsoIn || []).map((a) => a.sourceId).join(', ')}` : 'grupo não encontrado');
  check('o segundo passe reduz a contagem de matérias', depois.length < antes, `${antes} → ${depois.length}`);
  check('nenhuma matéria some no caminho, só vira cobertura de outra',
    depois.reduce((n, i) => n + 1 + ((i.alsoIn || []).length), 0) >= antes,
    'a soma de líderes e coberturas ficou menor que o total original');
  check('não há link repetido dentro de um mesmo grupo',
    depois.every((i) => {
      const urls = [i.url, ...((i.alsoIn || []).map((a) => a.url))];
      return new Set(urls).size === urls.length;
    }));
}

console.log('\n── Camada de IA sem chave ────────────────────────────');
const ai = await run('collector/enrich.mjs', { ANTHROPIC_API_KEY: '' });
console.log(ai.out.split('\n').map((l) => '  ' + l).join('\n').trimEnd());
const after = JSON.parse(await readFile(join(ROOT, 'site/data/latest.json'), 'utf8'));
check('sem chave de API, sai limpo sem quebrar o build', ai.code === 0);
check('o JSON continua válido e marcado como sem IA',
  after.aiEnabled === false && after.items.length === items.length);

await rm(tmpFeeds, { force: true });
server.close();

console.log('\n──────────────────────────────────────────────────────');
console.log(`${pass} passaram, ${fail} falharam\n`);
process.exit(fail ? 1 : 0);
