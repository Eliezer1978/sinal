#!/usr/bin/env node
/**
 * Camada de IA — opcional e isolada de propósito.
 *
 * Faz duas coisas sobre o JSON que o coletor já produziu:
 *   1. traduz título e resumo das matérias estrangeiras para português;
 *   2. escreve a análise do dia, conectando os assuntos entre si.
 *
 * Se não houver ANTHROPIC_API_KEY, sai em silêncio sem quebrar nada:
 * o site continua funcionando no modo sem IA, no idioma original.
 *
 * Roda uma vez por dia, na coleta. O site é estático: nenhuma chave
 * de API chega ao navegador.
 */

import { readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { regroup } from './cluster.mjs';
import { gravarEdicao } from './saida.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA = join(__dirname, '..', 'site', 'data', 'latest.json');

const API_KEY = process.env.ANTHROPIC_API_KEY;
const API = 'https://api.anthropic.com/v1';
const VERSION = '2023-06-01';

const CFG = {
  maxTranslate: int(process.env.MAX_TRANSLATE, 400),  // teto de matérias traduzidas por dia
  batchSize: int(process.env.BATCH_SIZE, 20),
  concurrency: int(process.env.AI_CONCURRENCY, 4),
  briefingItems: int(process.env.BRIEFING_ITEMS, 60),
  translateModel: process.env.TRANSLATE_MODEL || '',   // vazio = descoberta automática
  briefingModel: process.env.BRIEFING_MODEL || '',
};

function int(v, d) { const n = parseInt(v, 10); return Number.isFinite(n) && n >= 0 ? n : d; }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------- API

async function callApi(path, init = {}, tries = 4) {
  let lastErr;
  for (let i = 0; i < tries; i++) {
    if (i > 0) await sleep(1500 * Math.pow(2, i - 1) + Math.random() * 500);
    try {
      const res = await fetch(`${API}${path}`, {
        ...init,
        headers: {
          'x-api-key': API_KEY,
          'anthropic-version': VERSION,
          'content-type': 'application/json',
          ...(init.headers || {}),
        },
      });
      if (res.status === 429 || res.status >= 500) { lastErr = `HTTP ${res.status}`; continue; }
      const body = await res.json();
      if (!res.ok) throw new Error(`HTTP ${res.status}: ${body?.error?.message || JSON.stringify(body).slice(0, 300)}`);
      return body;
    } catch (e) {
      lastErr = e.message || String(e);
      if (!/HTTP (429|5\d\d)/.test(lastErr) && i >= 1) throw e;
    }
  }
  throw new Error(lastErr);
}

/** Descobre os modelos disponíveis, para o site não quebrar quando os nomes mudarem. */
async function pickModels() {
  if (CFG.translateModel && CFG.briefingModel) {
    return { translate: CFG.translateModel, briefing: CFG.briefingModel };
  }
  let ids = [];
  try {
    const list = await callApi('/models?limit=100', { method: 'GET' }, 2);
    ids = (list.data || []).map((m) => m.id);
  } catch (e) {
    console.log(`  aviso: não consegui listar modelos (${e.message}); usando os nomes padrão`);
  }
  const newest = (kind) =>
    ids.filter((id) => id.includes(kind)).sort().reverse()[0] || null;

  const translate = CFG.translateModel || newest('haiku') || newest('sonnet') || 'claude-haiku-4-5';
  const briefing = CFG.briefingModel || newest('sonnet') || newest('opus') || translate;
  return { translate, briefing };
}

function textOf(msg) {
  return (msg.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('');
}

/** Aceita JSON puro ou embrulhado em cerca de código. */
function parseJson(raw) {
  let s = raw.trim();
  const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fence) s = fence[1].trim();
  const start = s.search(/[[{]/);
  if (start > 0) s = s.slice(start);
  const lastArr = s.lastIndexOf(']'), lastObj = s.lastIndexOf('}');
  const end = Math.max(lastArr, lastObj);
  if (end > 0) s = s.slice(0, end + 1);
  try {
    return JSON.parse(s);
  } catch (e) {
    // sem um pedaço do texto recebido, a próxima investigação vira adivinhação
    const amostra = raw.trim().slice(0, 160).replace(/\s+/g, ' ');
    throw new Error(`JSON inválido (${e.message}) — veio: "${amostra}…"`);
  }
}

async function pool(items, limit, worker) {
  const out = new Array(items.length);
  let cursor = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (true) {
      const i = cursor++;
      if (i >= items.length) return;
      try { out[i] = await worker(items[i], i); }
      catch (e) { out[i] = { __error: e.message || String(e) }; }
    }
  }));
  return out;
}

// ---------------------------------------------------------------- tradução

const TRANSLATE_SYSTEM = `Você é tradutor de uma redação brasileira. Traduz manchetes e resumos de notícias do inglês, francês, alemão ou espanhol para o português do Brasil.

Regras:
- Português do Brasil, registro jornalístico, direto. Nada de linguagem empolada.
- Traduza o sentido, não palavra por palavra. Uma manchete traduzida deve soar como manchete escrita em português.
- Preserve nomes próprios, empresas, siglas e cargos na forma consagrada em português (Federal Reserve vira Federal Reserve; European Union vira União Europeia).
- Preserve números, datas, moedas e unidades exatamente como estão. Não converta valores.
- Não acrescente informação que não está no original. Não opine. Não suavize nem dramatize.
- Se o texto já estiver em português, devolva-o inalterado.
- Mantenha o comprimento próximo ao do original.

Devolva SOMENTE um array JSON, sem comentários e sem cerca de código, no formato:
[{"id":"i12","t":"título traduzido","s":"resumo traduzido"}]
Inclua todos os ids recebidos, na mesma ordem.`;

async function translateBatch(batch, model) {
  const payload = batch.map((it) => ({ id: it.id, t: it.title, s: it.summary || '' }));
  const res = await callApi('/messages', {
    method: 'POST',
    body: JSON.stringify({
      model,
      max_tokens: 8000,
      temperature: 0,
      system: TRANSLATE_SYSTEM,
      messages: [{ role: 'user', content: JSON.stringify(payload) }],
    }),
  });
  const parsed = parseJson(textOf(res));
  const map = new Map(parsed.map((r) => [r.id, r]));
  return { map, usage: res.usage };
}

// ---------------------------------------------------------------- análise do dia

function briefingSystem(topicLabels) {
  return `Você é o editor-chefe de um clipping executivo diário, escrito em português do Brasil para um único leitor: um profissional brasileiro que trabalha com educação corporativa, desenvolvimento de lideranças, performance humana, DEI e ESG, e que precisa entender o mundo para conversar com clientes grandes.

Você recebe as manchetes do dia de dezenas de veículos nacionais e internacionais. Sua tarefa é dizer o que importa e por quê.

Como escrever:
- Português do Brasil, frases curtas, voz ativa. Sem jargão de consultoria, sem "num mundo cada vez mais".
- Vá ao ponto: comece pelo fato, depois a implicação.
- Conecte assuntos que o leitor não conectaria sozinho. É esse o valor do texto.
- Quando um assunto tocar o campo dele (trabalho, aprendizagem, liderança, equidade, sustentabilidade), diga explicitamente o que muda na prática.
- Não invente fato que não esteja nas manchetes. Não atribua declarações que você não viu.
- Se o dia for fraco em algum tema, diga que foi fraco em vez de inflar.

Temas que o leitor acompanha: ${topicLabels}.

Devolva SOMENTE um objeto JSON, sem cerca de código:
{
  "headline": "uma frase que resume o dia, no máximo 90 caracteres",
  "lede": "dois a três períodos situando o dia como um todo",
  "blocks": [
    {"title":"título curto do assunto","body":"dois a quatro períodos com o fato e a implicação","ids":["i3","i17"]}
  ],
  "connections": ["uma frase ligando dois assuntos distintos do dia", "outra"],
  "watchlist": ["algo a acompanhar nos próximos dias", "outro"]
}
Use de 4 a 7 blocos, ordenados por importância. Em "ids", liste os identificadores das matérias que sustentam o bloco (use os ids exatamente como recebidos).`;
}

async function makeBriefing(items, topicLabels, model, maxTokens = 8000) {
  const digest = items.map((it) => ({
    id: it.id,
    fonte: it._sourceName,
    tema: it.topics,
    titulo: it.title_pt || it.title,
    resumo: (it.summary_pt || it.summary || '').slice(0, 240),
    cobertura: it.clusterSize > 1 ? `${it.clusterSize} veículos` : undefined,
  }));
  const res = await callApi('/messages', {
    method: 'POST',
    body: JSON.stringify({
      model,
      max_tokens: maxTokens,
      temperature: 0.3,
      system: briefingSystem(topicLabels),
      messages: [{
        role: 'user',
        content: `Manchetes de hoje (${new Date().toLocaleDateString('pt-BR', { dateStyle: 'full', timeZone: 'America/Sao_Paulo' })}):\n\n${JSON.stringify(digest, null, 0)}`,
      }],
    }),
  });
  return { briefing: parseJson(textOf(res)), usage: res.usage };
}

// ---------------------------------------------------------------- contagens

/** Depois de fundir grupos, os contadores de tema e fonte precisam bater de novo. */
function recount(data) {
  data.stats.publishedItems = data.items.length;
  for (const t of data.topics) {
    t.count = data.items.filter((i) => i.topics.includes(t.id)).length;
  }
  for (const s of data.sources) {
    s.count = data.items.filter((i) => i.sourceId === s.id).length;
  }
}

// ---------------------------------------------------------------- principal

async function main() {
  const data = JSON.parse(await readFile(DATA, 'utf8'));

  if (!API_KEY) {
    console.log('ANTHROPIC_API_KEY ausente — pulando a camada de IA.');
    console.log('O site vai funcionar normalmente, no idioma original e sem a análise do dia.');
    data.aiEnabled = false;
    data.aiNote = 'Camada de IA desligada: nenhuma chave de API configurada.';
    await writeFile(DATA, JSON.stringify(data), 'utf8');
    return;
  }

  const t0 = Date.now();
  const models = await pickModels();
  console.log(`→ modelos: tradução=${models.translate} análise=${models.briefing}`);

  const sourceName = new Map(data.sources.map((s) => [s.id, s.name]));
  const sourceLang = new Map(data.sources.map((s) => [s.id, s.lang]));
  for (const it of data.items) it._sourceName = sourceName.get(it.sourceId) || it.sourceId;

  // --- tradução -------------------------------------------------------------
  const needsTranslation = data.items
    .filter((it) => (sourceLang.get(it.sourceId) || 'en') !== 'pt')
    .slice(0, CFG.maxTranslate);

  console.log(`→ traduzindo ${needsTranslation.length} de ${data.items.length} matérias`);

  const batches = [];
  for (let i = 0; i < needsTranslation.length; i += CFG.batchSize) {
    batches.push(needsTranslation.slice(i, i + CFG.batchSize));
  }

  const usage = { input: 0, output: 0, calls: 0 };
  let translated = 0, failedBatches = 0;

  const results = await pool(batches, CFG.concurrency, async (batch, i) => {
    const r = await translateBatch(batch, models.translate);
    process.stdout.write(`  lote ${i + 1}/${batches.length}\r`);
    return r;
  });

  results.forEach((r, i) => {
    if (!r || r.__error) {
      failedBatches++;
      console.log(`\n  ✗ lote ${i + 1} falhou: ${r?.__error || 'sem resposta'}`);
      return;
    }
    usage.input += r.usage?.input_tokens || 0;
    usage.output += r.usage?.output_tokens || 0;
    usage.calls++;
    for (const it of batches[i]) {
      const t = r.map.get(it.id);
      if (t?.t) { it.title_pt = t.t; if (t.s) it.summary_pt = t.s; translated++; }
    }
  });

  console.log(`\n→ ${translated} matérias traduzidas${failedBatches ? ` (${failedBatches} lote(s) falharam, ficam no original)` : ''}`);

  // --- segundo passe de agrupamento, agora que tudo está em português --------
  if (translated > 0) {
    const before = data.items.length;
    data.items = regroup(data.items, (it) => it.title_pt || it.title);
    data.items.sort((a, b) => b.score - a.score);
    const fused = before - data.items.length;
    if (fused > 0) console.log(`→ ${fused} matéria(s) reconhecida(s) como cobertura da mesma notícia em outro idioma`);
    recount(data);
  }

  // --- análise do dia -------------------------------------------------------
  const topicLabels = data.topics.map((t) => t.label).join(', ');
  const topItems = data.items.slice(0, CFG.briefingItems);

  // Duas tentativas com modelos diferentes. Um modelo indisponível na conta,
  // ou uma resposta cortada, não podem custar a análise do dia inteira — e o
  // motivo da falha precisa sobrar registrado, senão vira adivinhação.
  const tentativas = [models.briefing];
  if (models.translate !== models.briefing) tentativas.push(models.translate);

  const erros = [];
  for (const modelo of tentativas) {
    try {
      const { briefing, usage: bu } = await makeBriefing(topItems, topicLabels, modelo);
      if (!briefing || !briefing.headline || !Array.isArray(briefing.blocks)) {
        throw new Error('resposta sem manchete ou sem blocos');
      }
      data.briefing = briefing;
      usage.input += bu?.input_tokens || 0;
      usage.output += bu?.output_tokens || 0;
      usage.calls++;
      models.briefingUsado = modelo;
      console.log(`→ análise do dia pronta com ${modelo}: "${briefing.headline}"`);
      break;
    } catch (e) {
      const msg = `${modelo}: ${e.message}`;
      erros.push(msg);
      console.log(`✗ análise do dia falhou com ${msg}`);
      data.briefing = null;
    }
  }
  if (!data.briefing) data.briefingErro = erros.join(' | ');

  // --- fecha ----------------------------------------------------------------
  for (const it of data.items) delete it._sourceName;

  data.aiEnabled = translated > 0 || Boolean(data.briefing);
  data.ai = {
    translatedCount: translated,
    models,
    usage,
    ranAt: new Date().toISOString(),
    durationMs: Date.now() - t0,
  };

  // regrava latest e o arquivo do dia, agora com tradução e curadoria
  await gravarEdicao(data);

  console.log(`✓ IA concluída em ${((Date.now() - t0) / 1000).toFixed(1)}s — ${usage.calls} chamadas, ${usage.input.toLocaleString('pt-BR')} tokens de entrada, ${usage.output.toLocaleString('pt-BR')} de saída`);
}

main().catch((e) => {
  console.error('camada de IA falhou:', e.message);
  console.error('o site segue publicável no modo sem IA.');
  process.exit(0); // nunca derruba o build
});
