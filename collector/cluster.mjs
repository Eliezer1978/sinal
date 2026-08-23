/**
 * Agrupamento de matérias sobre o mesmo fato.
 *
 * Manchetes sobre um mesmo acontecimento raramente repetem as mesmas palavras:
 *   "Federal Reserve holds interest rates steady as inflation cools"
 *   "Fed keeps rates unchanged as inflation continues to cool"
 * Jaccard puro erra esses casos, porque cada veículo acrescenta palavras próprias.
 * Usamos contenção — quanto do texto menor cabe no maior — com um piso de
 * palavras em comum para não juntar manchetes curtas por acaso.
 *
 * Limite conhecido: a comparação é lexical, então não cruza idiomas.
 * A versão brasileira de uma notícia americana só se junta ao grupo depois
 * da tradução, no segundo passe feito em enrich.mjs.
 */

const STOPWORDS = new Set(
  ('a o as os um uma uns umas de do da dos das em no na nos nas por para com sem sobre entre ate apos ' +
   'e ou mas que se como quando onde qual quais ao aos pelo pela pelos pelas seu sua seus suas este esta ' +
   'isso esse essa mais menos muito pouco ja ainda apenas tambem entao assim porque pois desde contra ' +
   'the a an of in on at to for with by from and or but that this these those is are was were be been being ' +
   'as it its he she they we you not no than then so such have has had will would can could may might ' +
   'after over new says said say told according amid while about into their there here what which who ' +
   'diz disse afirma afirmou segundo aponta mostra teve tem ter foi ser sao esta estao novo nova apos')
  .split(' ')
);

export function tokens(title) {
  return [...new Set(
    String(title)
      .normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()
      .replace(/[^a-z0-9\s]/g, ' ')
      .split(/\s+/)
      .filter((w) => w.length >= 4 && !STOPWORDS.has(w) && !/^\d+$/.test(w))
  )];
}

/** Contenção: interseção sobre o menor dos dois conjuntos. */
export function similarity(a, b) {
  if (a.length < 3 || b.length < 3) return { score: 0, shared: 0 };
  const sa = new Set(a);
  let shared = 0;
  for (const w of b) if (sa.has(w)) shared++;
  const containment = shared / Math.min(a.length, b.length);
  const jac = shared / (a.length + b.length - shared);
  return { score: Math.max(containment, jac + 0.12), shared, containment, jaccard: jac };
}

export const DEFAULTS = {
  minScore: 0.5,      // metade do texto menor precisa coincidir
  minShared: 3,       // e ao menos três palavras de conteúdo
  maxHoursApart: 36,  // e as duas dentro da mesma janela noticiosa
};

/**
 * Recebe objetos com { _tokens, ts } e devolve arrays de índices agrupados.
 * Usa índice invertido por palavra para não comparar todos contra todos.
 */
export function clusterItems(items, opts = {}) {
  const cfg = { ...DEFAULTS, ...opts };
  const index = new Map();
  items.forEach((it, i) => {
    for (const tok of it._tokens) {
      let bucket = index.get(tok);
      if (!bucket) index.set(tok, (bucket = []));
      bucket.push(i);
    }
  });

  // palavras presentes em quase todo mundo não discriminam nada
  const maxDf = Math.max(15, Math.floor(items.length * 0.08));

  const parent = items.map((_, i) => i);
  const find = (x) => { while (parent[x] !== x) { parent[x] = parent[parent[x]]; x = parent[x]; } return x; };
  const union = (a, b) => { const ra = find(a), rb = find(b); if (ra !== rb) parent[rb] = ra; };

  const gap = cfg.maxHoursApart * 3600000;

  items.forEach((it, i) => {
    const candidates = new Set();
    for (const tok of it._tokens) {
      const bucket = index.get(tok);
      if (!bucket || bucket.length > maxDf) continue;
      for (const j of bucket) if (j > i) candidates.add(j);
    }
    for (const j of candidates) {
      const other = items[j];
      if (Math.abs(it.ts - other.ts) > gap) continue;
      const s = similarity(it._tokens, other._tokens);
      if (s.score >= cfg.minScore && s.shared >= cfg.minShared) union(i, j);
    }
  });

  const groups = new Map();
  items.forEach((_, i) => {
    const r = find(i);
    let g = groups.get(r);
    if (!g) groups.set(r, (g = []));
    g.push(i);
  });
  return [...groups.values()];
}

/**
 * Segundo passe, feito depois da tradução.
 *
 * Quando todas as manchetes estão no mesmo idioma, a versão brasileira de uma
 * notícia internacional finalmente coincide lexicalmente com as estrangeiras.
 * Este passe funde os grupos que sobraram separados, mantendo como matéria
 * principal a de maior pontuação e empurrando as demais para "também em".
 *
 * `titleOf` decide qual texto comparar — normalmente o título traduzido.
 */
export function regroup(items, titleOf, opts = {}) {
  const view = items.map((it) => ({ _tokens: tokens(titleOf(it)), ts: it.ts }));
  const groups = clusterItems(view, opts);
  const out = [];

  for (const g of groups) {
    if (g.length === 1) { out.push(items[g[0]]); continue; }

    const members = g.map((i) => items[i]).sort((a, b) => (b.score || 0) - (a.score || 0));
    const lead = members[0];

    const extras = [];
    for (const m of members.slice(1)) {
      extras.push({
        source: m._sourceName || m.sourceId,
        sourceId: m.sourceId,
        url: m.url,
        title: m.title_pt || m.title,
      });
      if (m.alsoIn) extras.push(...m.alsoIn);
    }

    const seen = new Set([lead.url]);
    const alsoIn = [...(lead.alsoIn || []), ...extras].filter((a) => {
      if (!a || seen.has(a.url)) return false;
      seen.add(a.url);
      return true;
    }).slice(0, 8);

    lead.alsoIn = alsoIn.length ? alsoIn : undefined;
    lead.clusterSize = 1 + alsoIn.length;
    lead.topics = [...new Set(members.flatMap((m) => m.topics || []))].slice(0, 5);
    out.push(lead);
  }

  return out;
}
