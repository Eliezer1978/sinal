#!/usr/bin/env node
/**
 * Coletor de notícias.
 *
 * Busca todos os feeds do registro, normaliza RSS e Atom para um formato único,
 * remove duplicatas, agrupa matérias sobre o mesmo fato, classifica por tema
 * e ranqueia. Não depende de IA e não custa nada para rodar.
 *
 * Saída: site/data/latest.json
 */

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { XMLParser } from 'fast-xml-parser';
import { tokens as fingerprintTokens, clusterItems } from './cluster.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');

// ---------------------------------------------------------------- configuração

const CONFIG = {
  windowHours: num(process.env.WINDOW_HOURS, 48),   // idade máxima de uma matéria
  perSourceCap: num(process.env.PER_SOURCE_CAP, 25),// teto de itens por fonte
  globalCap: num(process.env.GLOBAL_CAP, 700),      // teto total
  concurrency: num(process.env.CONCURRENCY, 8),
  timeoutMs: num(process.env.TIMEOUT_MS, 20000),
  retries: num(process.env.RETRIES, 2),
  summaryChars: 420,
  userAgent:
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) ' +
    'Chrome/126.0 Safari/537.36 NewsDesk/1.0 (+feed reader for personal use)',
};

const WEIGHTS = { recency: 0.34, source: 0.26, topic: 0.28, cluster: 0.12 };

function num(v, d) { const n = Number(v); return Number.isFinite(n) && n > 0 ? n : d; }

// ---------------------------------------------------------------- utilidades de texto

const ENTITIES = {
  '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&apos;': "'", '&#39;': "'",
  '&nbsp;': ' ', '&ndash;': '–', '&mdash;': '—', '&hellip;': '…', '&rsquo;': '’',
  '&lsquo;': '‘', '&ldquo;': '“', '&rdquo;': '”', '&eacute;': 'é', '&aacute;': 'á',
  '&atilde;': 'ã', '&ccedil;': 'ç', '&oacute;': 'ó', '&uacute;': 'ú', '&iacute;': 'í',
  '&ecirc;': 'ê', '&ocirc;': 'ô', '&acirc;': 'â', '&agrave;': 'à', '&otilde;': 'õ',
};

function decodeEntities(s) {
  return String(s)
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => safeChar(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => safeChar(parseInt(d, 10)))
    .replace(/&[a-z]+;/gi, (m) => ENTITIES[m.toLowerCase()] ?? m);
}
function safeChar(code) {
  try { return String.fromCodePoint(code); } catch { return ''; }
}

function stripHtml(s) {
  return decodeEntities(
    String(s)
      .replace(/<script[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style[\s\S]*?<\/style>/gi, ' ')
      .replace(/<br\s*\/?>/gi, ' ')
      .replace(/<\/p>/gi, ' ')
      .replace(/<[^>]+>/g, ' ')
  ).replace(/\s+/g, ' ').trim();
}

/** minúsculas sem acento — base de toda comparação */
function fold(s) {
  return String(s).normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
}

function truncate(s, n) {
  if (!s || s.length <= n) return s || '';
  const cut = s.slice(0, n);
  const lastSpace = cut.lastIndexOf(' ');
  return (lastSpace > n * 0.6 ? cut.slice(0, lastSpace) : cut).trimEnd() + '…';
}

// ---------------------------------------------------------------- rede

async function fetchWithRetry(url, label) {
  let lastErr = 'erro desconhecido';
  for (let attempt = 0; attempt <= CONFIG.retries; attempt++) {
    if (attempt > 0) await sleep(700 * attempt + Math.floor(Math.random() * 400));
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), CONFIG.timeoutMs);
    try {
      const res = await fetch(url, {
        signal: ac.signal,
        redirect: 'follow',
        headers: {
          'User-Agent': CONFIG.userAgent,
          'Accept': 'application/rss+xml, application/atom+xml, application/xml, text/xml, */*;q=0.8',
          'Accept-Language': 'pt-BR,pt;q=0.9,en;q=0.8',
          'Cache-Control': 'no-cache',
        },
      });
      if (!res.ok) { lastErr = `HTTP ${res.status}`; continue; }
      const body = await res.text();
      if (!body || body.length < 80) { lastErr = 'resposta vazia'; continue; }
      return { ok: true, body };
    } catch (e) {
      lastErr = e.name === 'AbortError' ? `tempo esgotado (${CONFIG.timeoutMs}ms)` : (e.message || String(e));
    } finally {
      clearTimeout(timer);
    }
  }
  return { ok: false, error: lastErr };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function pool(items, limit, worker) {
  const results = new Array(items.length);
  let cursor = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (true) {
      const i = cursor++;
      if (i >= items.length) return;
      try { results[i] = await worker(items[i], i); }
      catch (e) { results[i] = { error: e?.message || String(e) }; }
    }
  });
  await Promise.all(runners);
  return results;
}

// ---------------------------------------------------------------- parsing de feeds

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  trimValues: true,
  processEntities: true,
  parseTagValue: false,
  parseAttributeValue: false,
  removeNSPrefix: false,
});

const asArray = (v) => (v == null ? [] : Array.isArray(v) ? v : [v]);

/** extrai texto de um nó que pode ser string, objeto com #text, ou array */
function txt(node) {
  if (node == null) return '';
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return txt(node.find((n) => txt(n)) ?? node[0]);
  if (typeof node === 'object') return String(node['#text'] ?? '');
  return '';
}

function pickLink(entry) {
  // RSS
  const rssLink = txt(entry.link);
  if (rssLink && /^https?:/i.test(rssLink)) return rssLink;
  // Atom: <link rel="alternate" href="...">
  const links = asArray(entry.link).filter((l) => l && typeof l === 'object');
  const alt = links.find((l) => (l['@_rel'] ?? 'alternate') === 'alternate' && l['@_href']);
  if (alt) return alt['@_href'];
  if (links[0]?.['@_href']) return links[0]['@_href'];
  const guid = txt(entry.guid);
  if (guid && /^https?:/i.test(guid)) return guid;
  const id = txt(entry.id);
  if (id && /^https?:/i.test(id)) return id;
  return '';
}

function pickDate(entry) {
  const raw =
    txt(entry.pubDate) || txt(entry.published) || txt(entry.updated) ||
    txt(entry['dc:date']) || txt(entry.date) || txt(entry['dc:created']);
  if (!raw) return null;
  const d = new Date(raw);
  return Number.isFinite(d.getTime()) ? d : null;
}

function pickSummary(entry) {
  const raw =
    txt(entry.description) || txt(entry.summary) ||
    txt(entry['content:encoded']) || txt(entry.content) || '';
  return stripHtml(raw);
}

function pickImage(entry) {
  const candidates = [
    ...asArray(entry['media:content']),
    ...asArray(entry['media:thumbnail']),
    ...asArray(entry.enclosure),
  ];
  for (const c of candidates) {
    if (!c || typeof c !== 'object') continue;
    const url = c['@_url'];
    const type = c['@_type'] || '';
    if (url && (!type || type.startsWith('image'))) return url;
  }
  // imagem embutida no HTML da descrição
  const html = txt(entry.description) || txt(entry['content:encoded']) || '';
  const m = html.match(/<img[^>]+src=["']([^"']+)["']/i);
  return m ? m[1] : '';
}

function extractEntries(doc) {
  if (doc?.rss?.channel) return asArray(doc.rss.channel.item);
  if (doc?.feed) return asArray(doc.feed.entry);
  if (doc?.['rdf:RDF']) return asArray(doc['rdf:RDF'].item);
  if (doc?.channel) return asArray(doc.channel.item);
  return [];
}

// ---------------------------------------------------------------- URLs

function gnewsUrl(source) {
  const lang = source.lang === 'pt' ? 'pt-BR' : source.lang === 'es' ? 'es-419' : 'en-US';
  const gl = source.gl || (source.lang === 'pt' ? 'BR' : 'US');
  const ceid = source.lang === 'pt' ? 'BR:pt-419' : source.lang === 'es' ? 'ES:es' : `${gl}:en`;
  const q = encodeURIComponent(`${source.query} when:2d`);
  return `https://news.google.com/rss/search?q=${q}&hl=${lang}&gl=${gl}&ceid=${ceid}`;
}

const TRACKING = /^(utm_|fbclid|gclid|mc_cid|mc_eid|ref|ref_src|smid|partner|CMP|cmp|ito|at_|guccounter)/;

/** Link limpo para exibir: tira só rastreamento, preserva o host como veio. */
function cleanUrl(raw) {
  try {
    const u = new URL(raw);
    u.hash = '';
    for (const k of [...u.searchParams.keys()]) {
      if (TRACKING.test(k)) u.searchParams.delete(k);
    }
    return u.toString();
  } catch {
    return raw;
  }
}

/** Chave de deduplicação: normaliza tudo o que não muda o destino. */
function canonicalUrl(raw) {
  try {
    const u = new URL(cleanUrl(raw));
    u.hostname = u.hostname.replace(/^www\./, '').toLowerCase();
    u.protocol = 'https:';
    u.pathname = u.pathname.replace(/\/+$/, '') || '/';
    return u.toString();
  } catch {
    return raw;
  }
}

/** Google Notícias devolve "Manchete - Veículo"; tira o sufixo */
function cleanGnewsTitle(title, sourceName) {
  const m = title.match(/^(.*?)\s+[-–—]\s+([^-–—]{2,40})$/);
  if (!m) return title;
  const tail = fold(m[2]).trim();
  const name = fold(sourceName).trim();
  if (tail === name || name.includes(tail) || tail.includes(name) || m[1].length > 25) return m[1].trim();
  return title;
}

// ---------------------------------------------------------------- classificação

function buildMatchers(topics) {
  return topics.map((t) => ({
    id: t.id,
    strong: t.strong.map(compileTerm),
    weak: (t.weak || []).map(compileTerm),
  }));
}

function compileTerm(term) {
  const f = fold(term);
  // expressões com espaço/pontuação: busca por substring com fronteira suave
  if (/[^a-z0-9]/.test(f)) {
    return { raw: f, phrase: true };
  }
  return { raw: f, phrase: false, re: new RegExp(`(^|[^a-z0-9])${escapeRe(f)}([^a-z0-9]|$)`) };
}
function escapeRe(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

function hits(term, hay) {
  return term.phrase ? hay.includes(term.raw) : term.re.test(hay);
}

function classify(item, matchers, source) {
  const hay = fold(`${item.title} ${item.summary}`);
  const scores = {};
  for (const m of matchers) {
    let s = 0;
    for (const t of m.strong) if (hits(t, hay)) s += 3;
    for (const t of m.weak) if (hits(t, hay)) s += 1;
    if (s > 0) scores[m.id] = s;
  }
  // a especialidade da fonte dá um empurrão, nunca cria tema do nada
  for (const h of source.hint || []) {
    if (scores[h]) scores[h] += 2;
  }
  let topics = Object.entries(scores).filter(([, s]) => s >= 3).sort((a, b) => b[1] - a[1]);
  if (topics.length === 0) {
    // sem sinal no texto: cai na especialidade declarada da fonte
    const fallback = (source.hint || []).slice(0, 1).map((h) => [h, 2]);
    topics = fallback;
  }
  topics = topics.slice(0, 4);
  const best = topics.length ? topics[0][1] : 0;
  return { topics: topics.map(([id]) => id), topicScores: Object.fromEntries(topics), relevance: best };
}

// ---------------------------------------------------------------- deduplicação e agrupamento

// ---------------------------------------------------------------- ranking

function scoreItem(item, source, now) {
  const ageHours = Math.max(0, (now - item.ts) / 3600000);
  const recency = Math.pow(0.5, ageHours / 12);            // meia-vida de 12h
  const src = source.weight ?? 0.7;
  const topic = Math.min(1, item.relevance / 9);
  const corroboration = Math.min(1, (item.clusterSize - 1) / 4);
  return (
    WEIGHTS.recency * recency +
    WEIGHTS.source * src +
    WEIGHTS.topic * topic +
    WEIGHTS.cluster * corroboration
  );
}

// ---------------------------------------------------------------- principal

async function main() {
  const t0 = Date.now();
  const feedsFile = process.env.FEEDS_FILE || join(__dirname, 'feeds.json');
  const [feedsRaw, topicsRaw] = await Promise.all([
    readFile(feedsFile, 'utf8'),
    readFile(join(__dirname, 'topics.json'), 'utf8'),
  ]);
  const registry = JSON.parse(feedsRaw);
  const taxonomy = JSON.parse(topicsRaw);
  const sources = registry.sources;
  const byId = new Map(sources.map((s) => [s.id, s]));
  const matchers = buildMatchers(taxonomy.topics);

  console.log(`→ ${sources.length} fontes, ${taxonomy.topics.length} temas, janela de ${CONFIG.windowHours}h`);

  const now = Date.now();
  const cutoff = now - CONFIG.windowHours * 3600000;

  const health = [];
  const raw = [];

  await pool(sources, CONFIG.concurrency, async (source) => {
    const url = source.type === 'gnews' ? gnewsUrl(source) : source.url;
    const res = await fetchWithRetry(url, source.id);
    if (!res.ok) {
      health.push({ id: source.id, name: source.name, section: source.section || '', ok: false, items: 0, error: res.error });
      console.log(`  ✗ ${source.id.padEnd(20)} ${res.error}`);
      return;
    }
    let entries = [];
    try {
      entries = extractEntries(parser.parse(res.body));
    } catch (e) {
      health.push({ id: source.id, name: source.name, section: source.section || '', ok: false, items: 0, error: `XML inválido: ${e.message}` });
      console.log(`  ✗ ${source.id.padEnd(20)} XML inválido`);
      return;
    }

    let kept = 0, stale = 0;
    for (const entry of entries) {
      const link = pickLink(entry);
      let title = stripHtml(txt(entry.title));
      if (!link || !title) continue;
      if (source.type === 'gnews') title = cleanGnewsTitle(title, source.name);

      const date = pickDate(entry);
      const ts = date ? date.getTime() : now;
      if (ts < cutoff) { stale++; continue; }
      if (ts > now + 6 * 3600000) continue; // data futura absurda

      raw.push({
        title,
        summary: truncate(pickSummary(entry), CONFIG.summaryChars),
        url: cleanUrl(link),
        canonical: canonicalUrl(link),
        image: pickImage(entry),
        ts,
        sourceId: source.id,
        hasDate: Boolean(date),
      });
      kept++;
    }
    health.push({
      id: source.id, name: source.name, section: source.section || '',
      ok: true, items: kept, skippedStale: stale, error: null,
    });
    console.log(`  ✓ ${source.id.padEnd(20)} ${String(kept).padStart(3)} itens${stale ? ` (${stale} fora da janela)` : ''}`);
  });

  console.log(`→ ${raw.length} itens brutos coletados`);

  // dedup exato por URL canônica, mantendo o mais antigo (primeira publicação)
  const byUrl = new Map();
  for (const it of raw) {
    const prev = byUrl.get(it.canonical);
    if (!prev || it.ts < prev.ts) byUrl.set(it.canonical, it);
  }
  let items = [...byUrl.values()];

  // dedup por título idêntico dentro da mesma fonte
  const seenTitle = new Set();
  items = items.filter((it) => {
    const k = `${it.sourceId}|${fold(it.title)}`;
    if (seenTitle.has(k)) return false;
    seenTitle.add(k);
    return true;
  });

  console.log(`→ ${items.length} após deduplicação`);

  // classificação
  for (const it of items) {
    const source = byId.get(it.sourceId);
    Object.assign(it, classify(it, matchers, source));
    it._tokens = fingerprintTokens(it.title);
  }

  // agrupamento por fato
  const groups = clusterItems(items);
  console.log(`→ ${groups.length} grupos de cobertura`);

  const final = [];
  for (const g of groups) {
    const members = g.map((i) => items[i]).sort((a, b) => {
      const wa = byId.get(a.sourceId)?.weight ?? 0.7;
      const wb = byId.get(b.sourceId)?.weight ?? 0.7;
      return wb - wa || a.ts - b.ts;
    });
    const lead = members[0];
    lead.clusterSize = members.length;
    lead.alsoIn = members.slice(1, 7).map((m) => ({
      source: byId.get(m.sourceId)?.name || m.sourceId,
      sourceId: m.sourceId,
      url: m.url,
      title: m.title,
    }));
    // o grupo herda todos os temas encontrados pelos membros
    const allTopics = new Set(members.flatMap((m) => m.topics));
    lead.topics = [...allTopics].slice(0, 5);
    lead.relevance = Math.max(...members.map((m) => m.relevance));
    final.push(lead);
  }

  // pontuação
  for (const it of final) {
    it.score = scoreItem(it, byId.get(it.sourceId) || {}, now);
  }
  final.sort((a, b) => b.score - a.score);

  // teto por fonte, para nenhum feed dominar a página
  const perSource = new Map();
  const capped = [];
  for (const it of final) {
    const n = perSource.get(it.sourceId) || 0;
    if (n >= CONFIG.perSourceCap) continue;
    perSource.set(it.sourceId, n + 1);
    capped.push(it);
    if (capped.length >= CONFIG.globalCap) break;
  }

  console.log(`→ ${capped.length} itens publicados`);

  // saída enxuta
  const out = {
    generatedAt: new Date().toISOString(),
    windowHours: CONFIG.windowHours,
    aiEnabled: false,
    briefing: null,
    stats: {
      sourcesTotal: sources.length,
      sourcesOk: health.filter((h) => h.ok).length,
      sourcesFailed: health.filter((h) => !h.ok).length,
      rawItems: raw.length,
      publishedItems: capped.length,
      clusters: groups.length,
      durationMs: Date.now() - t0,
    },
    topics: taxonomy.topics.map((t) => ({
      id: t.id, label: t.label, short: t.short, description: t.description,
      count: capped.filter((i) => i.topics.includes(t.id)).length,
    })),
    groups: registry.groups,
    sources: sources.map((s) => {
      const h = health.find((x) => x.id === s.id);
      return {
        id: s.id, name: s.name, group: s.group, section: s.section || '',
        lang: s.lang, site: s.site, paywall: !!s.paywall,
        ok: h?.ok ?? false, error: h?.error ?? null,
        count: capped.filter((i) => i.sourceId === s.id).length,
      };
    }),
    items: capped.map((it, idx) => ({
      id: `i${idx}`,
      title: it.title,
      summary: it.summary,
      url: it.url,
      image: it.image || undefined,
      ts: it.ts,
      hasDate: it.hasDate,
      sourceId: it.sourceId,
      topics: it.topics,
      score: Number(it.score.toFixed(4)),
      clusterSize: it.clusterSize,
      alsoIn: it.alsoIn?.length ? it.alsoIn : undefined,
    })),
  };

  const dataDir = join(ROOT, 'site', 'data');
  await mkdir(join(dataDir, 'archive'), { recursive: true });
  await writeFile(join(dataDir, 'latest.json'), JSON.stringify(out), 'utf8');

  // arquivo do dia, para consultar edições passadas
  const day = new Date().toISOString().slice(0, 10);
  await writeFile(join(dataDir, 'archive', `${day}.json`), JSON.stringify(out), 'utf8');

  const failed = health.filter((h) => !h.ok);
  if (failed.length) {
    console.log(`\n⚠ ${failed.length} fonte(s) falharam:`);
    for (const f of failed) console.log(`   ${f.id}: ${f.error}`);
  }
  console.log(`\n✓ pronto em ${((Date.now() - t0) / 1000).toFixed(1)}s → site/data/latest.json`);
}

main().catch((e) => { console.error('falha fatal:', e); process.exit(1); });
