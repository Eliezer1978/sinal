#!/usr/bin/env node
/**
 * Camada de IA — tradução e análise do dia.
 *
 * Faz duas coisas:
 *   1. traduz título e resumo das matérias estrangeiras para português;
 *   2. escreve a análise do dia, conectando os assuntos entre si.
 *
 * Como a tradução deixou de depender da coleta
 * --------------------------------------------
 * Antes este arquivo só enxergava a janela de 48 horas que o coletor acabara
 * de montar. Isso amarrava as duas etapas: um dia sem tradução ficava sem
 * tradução para sempre, porque no dia seguinte aquelas matérias já tinham
 * saído da janela.
 *
 * Agora existe uma memória de traduções (data/traducoes.json), guardada pelo
 * id estável de cada matéria. Com ela:
 *
 *   - aplicar o que já foi traduzido é de graça e acontece sempre, mesmo sem
 *     chave de API. Uma matéria traduzida ontem continua em português hoje;
 *   - traduzir de verdade varre os últimos dias do acervo e preenche só o que
 *     falta, gravando de volta nos arquivos de dia;
 *   - nada é traduzido duas vezes.
 *
 * Resultado prático: a coleta pode rodar todo dia (é gratuita e é a única
 * chance de capturar aquele dia) e a tradução pode rodar na frequência que
 * você quiser, inclusive só quando for ler, sem deixar buraco nenhum.
 *
 * Sem ANTHROPIC_API_KEY o arquivo não quebra: entra no modo "só aplicar",
 * usa a memória e segue. O site é estático — nenhuma chave chega ao navegador.
 */

import { readFile, writeFile, readdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { regroup } from './cluster.mjs';
import { gravarEdicao, diaDaEdicao, DATA, DIAS } from './saida.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const LATEST = join(DATA, 'latest.json');
const MEMORIA = join(DATA, 'traducoes.json');
const FEEDS = join(__dirname, 'feeds.json');

const API_KEY = process.env.ANTHROPIC_API_KEY;
const API = 'https://api.anthropic.com/v1';
const VERSION = '2023-06-01';

const CFG = {
  // quantos dias do acervo entram na varredura por matéria sem tradução
  diasParaTraduzir: int(process.env.DIAS_TRADUZIR, 7),
  // teto por dia: garante que um dia antigo não consuma a cota toda
  maxPorDia: int(process.env.MAX_TRANSLATE_DIA || process.env.MAX_TRANSLATE, 150),
  // Teto da execução inteira. Precisa comportar diasParaTraduzir × maxPorDia,
  // senão uma volta depois de uma semana fora para no meio do caminho e os
  // dias mais antigos ficam sem tradução para sempre. Serve como válvula de
  // segurança contra uma recuperação absurda, não como economia do dia a dia:
  // quem controla o custo é o teto por dia.
  maxTotal: int(process.env.MAX_TRANSLATE_TOTAL, 1000),
  batchSize: int(process.env.BATCH_SIZE, 20),
  concurrency: int(process.env.AI_CONCURRENCY, 4),
  briefingItems: int(process.env.BRIEFING_ITEMS, 60),
  translateModel: process.env.TRANSLATE_MODEL || '',   // vazio = descoberta automática
  briefingModel: process.env.BRIEFING_MODEL || '',
};

function int(v, d) { const n = parseInt(v, 10); return Number.isFinite(n) && n >= 0 ? n : d; }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------- arquivos

async function lerJson(caminho, padrao) {
  try { return JSON.parse(await readFile(caminho, 'utf8')); } catch { return padrao; }
}

/** Lê o acervo inteiro, do dia mais recente para o mais antigo. */
async function lerAcervo() {
  let arquivos = [];
  try {
    arquivos = (await readdir(DIAS)).filter((f) => /^\d{4}-\d{2}-\d{2}\.json$/.test(f));
  } catch {
    return [];
  }
  const dias = [];
  for (const f of arquivos.sort().reverse()) {
    const json = await lerJson(join(DIAS, f), null);
    if (json && Array.isArray(json.itens)) dias.push({ dia: f.slice(0, 10), json });
  }
  return dias;
}

/**
 * Escreve a tradução conhecida em cada item e diz se algo mudou — só dias que
 * realmente mudaram são regravados, para não encher o histórico de commits.
 */
function aplicarMemoria(memoria, itens) {
  let mudou = false, comTraducao = 0;
  for (const it of itens) {
    const m = memoria[it.id];
    if (m) {
      if (m.t && it.title_pt !== m.t) { it.title_pt = m.t; mudou = true; }
      if (m.s && it.summary_pt !== m.s) { it.summary_pt = m.s; mudou = true; }
    }
    if (it.title_pt) comTraducao++;
  }
  return { mudou, comTraducao };
}

/** Tira da memória o que já saiu do acervo, para o arquivo não crescer sem fim. */
function podarMemoria(memoria, dias, latest) {
  const vivos = new Set((latest.items || []).map((i) => i.id));
  for (const d of dias) for (const it of d.json.itens) vivos.add(it.id);
  let removidas = 0;
  for (const id of Object.keys(memoria)) {
    if (!vivos.has(id)) { delete memoria[id]; removidas++; }
  }
  return removidas;
}

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
  // Prefere versões datadas às apelidadas. O apelido pode aparecer na lista da
  // conta e mesmo assim recusar a chamada — foi o que aconteceu com
  // "claude-sonnet-5" aqui. A versão datada sempre existe de verdade.
  const newest = (kind) => {
    const candidatos = ids.filter((id) => id.includes(kind));
    const datados = candidatos.filter((id) => /-\d{8}$/.test(id));
    return (datados.length ? datados : candidatos).sort().reverse()[0] || null;
  };

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

/**
 * Escolhe o que traduzir: percorre os dias do mais recente para o mais antigo,
 * pega as primeiras de cada dia que ainda não têm tradução e respeita os dois
 * tetos. Assim uma volta depois de uma semana fora cobre a semana inteira em
 * vez de gastar tudo no dia mais antigo.
 *
 * A ordem dentro do dia é a da publicação, não a da relevância, porque é
 * assim que o site passou a exibir. Escolher por relevância deixava buracos
 * logo no alto da tela: numa medição, só 11 das 25 matérias mais recentes
 * tinham tradução, porque as outras 14 pontuavam um pouco menos. A pontuação
 * fica como critério de desempate.
 */
function escolherCandidatos(fontesDeItens, memoria, precisaTraducao) {
  const vistos = new Set();
  const fila = [];
  for (const { dia, itens } of fontesDeItens.slice(0, CFG.diasParaTraduzir)) {
    const doDia = itens
      .filter((it) => it.title && !it.title_pt && !memoria[it.id] && !vistos.has(it.id) && precisaTraducao(it))
      .sort((a, b) => (b.ts || 0) - (a.ts || 0) || (b.score || 0) - (a.score || 0))
      .slice(0, CFG.maxPorDia);
    for (const it of doDia) {
      vistos.add(it.id);
      fila.push({ item: it, dia });
      if (fila.length >= CFG.maxTotal) return fila;
    }
  }
  return fila;
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
  const t0 = Date.now();

  const data = await lerJson(LATEST, null);
  if (!data || !Array.isArray(data.items)) {
    console.log('latest.json ausente ou inválido — nada a enriquecer.');
    return;
  }

  const memoriaArquivo = await lerJson(MEMORIA, { versao: 1, itens: {} });
  const memoria = memoriaArquivo.itens || {};
  const dias = await lerAcervo();
  const diaDeHoje = diaDaEdicao(new Date(data.generatedAt || Date.now()));

  const feeds = await lerJson(FEEDS, { sources: [] });
  const langPorFonte = new Map((feeds.sources || []).map((s) => [s.id, s.lang || 'en']));
  for (const s of (data.sources || [])) {
    if (!langPorFonte.has(s.id)) langPorFonte.set(s.id, s.lang || 'en');
  }
  const precisaTraducao = (it) => (langPorFonte.get(it.sourceId) || 'en') !== 'pt';

  const estrangeirasHoje = data.items.filter(precisaTraducao).length;

  // --- 1. aplicar o que já se sabe (de graça, sempre) -----------------------
  const aplicadoNoLatest = aplicarMemoria(memoria, data.items);
  console.log(`→ memória: ${Object.keys(memoria).length} tradução(ões) guardada(s); ` +
    `${aplicadoNoLatest.comTraducao} das ${data.items.length} matérias de hoje já em português`);

  let traduzidasAgora = 0;
  let failedBatches = 0;
  const usage = { input: 0, output: 0, calls: 0 };
  let models = null;

  if (!API_KEY) {
    console.log('ANTHROPIC_API_KEY ausente — sem chamadas de API nesta execução.');
    console.log('A memória de traduções foi aplicada; o que ainda não foi traduzido fica no idioma original.');
    data.aiNote = 'Sem chamadas de IA nesta execução: nenhuma chave de API configurada.';
  } else {
    models = await pickModels();
    console.log(`→ modelos: tradução=${models.translate} análise=${models.briefing}`);

    // --- 2. escolher o que falta, do dia mais recente para trás -------------
    const fontesDeItens = [{ dia: diaDeHoje, itens: data.items }].concat(
      dias.filter((d) => d.dia !== diaDeHoje).map((d) => ({ dia: d.dia, itens: d.json.itens }))
    );
    const candidatos = escolherCandidatos(fontesDeItens, memoria, precisaTraducao);

    const porDia = {};
    for (const c of candidatos) porDia[c.dia] = (porDia[c.dia] || 0) + 1;
    const resumoDias = Object.entries(porDia).map(([d, n]) => `${d}: ${n}`).join(', ');
    console.log(`→ traduzindo ${candidatos.length} matéria(s) sem tradução` +
      (resumoDias ? ` (${resumoDias})` : ''));

    // --- 3. traduzir --------------------------------------------------------
    const pendentes = candidatos.map((c) => c.item);
    const batches = [];
    for (let i = 0; i < pendentes.length; i += CFG.batchSize) {
      batches.push(pendentes.slice(i, i + CFG.batchSize));
    }

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
        if (t?.t) {
          memoria[it.id] = { t: t.t, s: t.s || undefined };
          traduzidasAgora++;
        }
      }
    });

    if (batches.length) {
      console.log(`\n→ ${traduzidasAgora} matéria(s) traduzida(s)` +
        (failedBatches ? ` (${failedBatches} lote(s) falharam, ficam no original)` : ''));
    }
  }

  // --- 4. aplicar de novo, agora com o que acabou de chegar ------------------
  const finalNoLatest = aplicarMemoria(memoria, data.items);

  // --- 5. gravar de volta nos dias que mudaram ------------------------------
  let diasRegravados = 0;
  for (const d of dias) {
    if (d.dia === diaDeHoje) continue;           // o de hoje é escrito por gravarEdicao
    const r = aplicarMemoria(memoria, d.json.itens);
    if (!r.mudou) continue;
    await writeFile(join(DIAS, `${d.dia}.json`), JSON.stringify(d.json), 'utf8');
    diasRegravados++;
  }
  if (diasRegravados) console.log(`→ ${diasRegravados} dia(s) do acervo atualizados com tradução`);

  // --- 6. segundo passe de agrupamento, agora que há português --------------
  if (traduzidasAgora > 0) {
    const before = data.items.length;
    data.items = regroup(data.items, (it) => it.title_pt || it.title);
    data.items.sort((a, b) => b.score - a.score);
    const fused = before - data.items.length;
    if (fused > 0) console.log(`→ ${fused} matéria(s) reconhecida(s) como cobertura da mesma notícia em outro idioma`);
    recount(data);
  }

  // --- 7. análise do dia ----------------------------------------------------
  if (API_KEY) {
    const sourceName = new Map(data.sources.map((s) => [s.id, s.name]));
    for (const it of data.items) it._sourceName = sourceName.get(it.sourceId) || it.sourceId;

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
        data.briefingErro = undefined;
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

    for (const it of data.items) delete it._sourceName;
  }

  // --- 8. fechar ------------------------------------------------------------
  const removidasDaMemoria = podarMemoria(memoria, dias, data);
  if (removidasDaMemoria) console.log(`→ memória podada: ${removidasDaMemoria} entrada(s) fora do acervo`);

  await writeFile(MEMORIA, JSON.stringify({
    versao: 1,
    atualizadoEm: new Date().toISOString(),
    itens: memoria,
  }), 'utf8');

  const pendentes = Math.max(0, estrangeirasHoje - finalNoLatest.comTraducao);

  // A camada conta como ativa quando há português na tela, venha ele da
  // tradução de agora ou da memória. É isso que o botão de idioma precisa.
  data.aiEnabled = finalNoLatest.comTraducao > 0 || Boolean(data.briefing);
  data.ai = {
    translatedCount: finalNoLatest.comTraducao,   // total em português na edição
    estrangeiras: estrangeirasHoje,               // quantas não nasceram em português
    traduzidasAgora,                              // quantas custaram API nesta execução
    pendentes,                                    // estrangeiras ainda no original
    memoria: Object.keys(memoria).length,
    diasRegravados,
    models: models || undefined,
    usage,
    ranAt: new Date().toISOString(),
    durationMs: Date.now() - t0,
  };
  if (data.aiEnabled) data.aiNote = undefined;

  // regrava latest e o arquivo do dia, agora com tradução e curadoria
  await gravarEdicao(data);

  console.log(`✓ concluído em ${((Date.now() - t0) / 1000).toFixed(1)}s — ` +
    `${finalNoLatest.comTraducao} em português, ${pendentes} no original, ` +
    `${usage.calls} chamada(s) de API`);
}

main().catch((e) => {
  console.error('camada de IA falhou:', e.message);
  console.error('o site segue publicável no modo sem IA.');
  process.exit(0); // nunca derruba o build
});
