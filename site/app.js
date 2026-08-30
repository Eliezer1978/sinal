/* ============================================================
   Sinal — lógica do cliente

   Tudo roda no navegador sobre os arquivos gerados na coleta diária.
   Nenhuma chave de API existe deste lado.

   O que você marca — favoritos, descartes, fontes esquecidas — fica
   guardado neste aparelho e não vai para lugar nenhum. Por isso existe
   exportar e importar: é como esse acervo pessoal atravessa de um
   aparelho para outro enquanto não houver sincronia de verdade.
   ============================================================ */

(function () {
  'use strict';

  var PAGE = 40;
  var K = {
    prefs: 'sinal.prefs.v2',
    fav: 'sinal.favoritos.v1',
    desc: 'sinal.descartes.v1',
    esq: 'sinal.esquecidas.v1',
    dica: 'sinal.dicaInstalar.v1',
  };

  // Períodos. 'dias' é quantos arquivos do acervo carregar; 'horas' é um
  // corte adicional por data de publicação, usado só no recorte de 24 horas.
  var PERIODOS = {
    '24h': { rotulo: 'Últimas 24 horas', dias: 1, horas: 24 },
    edicao: { rotulo: 'Edição de hoje', dias: 1, horas: 0 },
    '7d': { rotulo: 'Últimos 7 dias', dias: 7, horas: 0 },
    '30d': { rotulo: 'Últimos 30 dias', dias: 30, horas: 0 },
  };

  var MOTIVOS = [
    { id: 'fora-do-tema', rotulo: 'Não tem a ver com meus temas',
      ajuda: 'Erro de classificação. O site para de associar esse tipo de texto ao tema.' },
    { id: 'local-factual', rotulo: 'Notícia local ou factual demais',
      ajuda: 'Concurso regional, placar de mercado. Empurra a fonte para baixo.' },
    { id: 'sem-motivo', rotulo: 'Só remover, sem motivo',
      ajuda: 'Some da lista e não ensina nada ao site.' },
  ];

  var state = {
    topics: new Set(),
    offSources: new Set(),
    lang: 'pt',
    sort: 'score',
    periodo: '7d',
    vista: 'tudo',
    q: '',
    hidePaywall: false,
    compact: false,
    limit: PAGE,
    briefingOpen: false,
    mostrarDescartados: false,
  };

  var data = null;          // latest.json: metadados + edição atual
  var pool = new Map();     // id -> matéria, união do que estiver carregado
  var diasCarregados = new Set();
  var indice = { dias: [] };
  var srcById = new Map();
  var topicById = new Map();
  var carregando = false;

  var favoritos = {};
  var descartes = {};
  var esquecidas = new Set();

  // ---------------------------------------------------------- utilidades

  function $(s) { return document.querySelector(s); }
  function $$(s) { return Array.prototype.slice.call(document.querySelectorAll(s)); }

  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  function fold(s) {
    return String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
  }

  function ler(chave, padrao) {
    try {
      var v = localStorage.getItem(chave);
      return v ? JSON.parse(v) : padrao;
    } catch (e) { return padrao; }
  }
  function gravar(chave, valor) {
    try { localStorage.setItem(chave, JSON.stringify(valor)); return true; }
    catch (e) { return false; }   // aba anônima, cota cheia: seguimos sem guardar
  }

  function salvarPrefs() {
    gravar(K.prefs, {
      topics: Array.from(state.topics),
      offSources: Array.from(state.offSources),
      lang: state.lang, sort: state.sort, periodo: state.periodo,
      hidePaywall: state.hidePaywall, compact: state.compact,
      mostrarDescartados: state.mostrarDescartados,
      theme: document.documentElement.getAttribute('data-theme'),
    });
  }

  function carregarPrefs() {
    var p = ler(K.prefs, {});
    if (Array.isArray(p.topics)) state.topics = new Set(p.topics);
    if (Array.isArray(p.offSources)) state.offSources = new Set(p.offSources);
    if (p.lang) state.lang = p.lang;
    if (p.sort) state.sort = p.sort;
    if (p.periodo && PERIODOS[p.periodo]) state.periodo = p.periodo;
    if (typeof p.hidePaywall === 'boolean') state.hidePaywall = p.hidePaywall;
    if (typeof p.compact === 'boolean') state.compact = p.compact;
    if (typeof p.mostrarDescartados === 'boolean') state.mostrarDescartados = p.mostrarDescartados;
    if (p.theme === 'dark' || p.theme === 'light') {
      document.documentElement.setAttribute('data-theme', p.theme);
    }
    favoritos = ler(K.fav, {}) || {};
    descartes = ler(K.desc, {}) || {};
    esquecidas = new Set(ler(K.esq, []) || []);
  }

  // ---------------------------------------------------------- datas

  var RTF = (typeof Intl !== 'undefined' && Intl.RelativeTimeFormat)
    ? new Intl.RelativeTimeFormat('pt-BR', { numeric: 'auto' }) : null;

  function relTime(ts) {
    var min = Math.round((Date.now() - ts) / 60000);
    if (min < 1) return 'agora';
    if (!RTF) return new Date(ts).toLocaleString('pt-BR');
    if (min < 60) return RTF.format(-min, 'minute');
    var h = Math.round(min / 60);
    if (h < 24) return RTF.format(-h, 'hour');
    var d = Math.round(h / 24);
    if (d < 31) return RTF.format(-d, 'day');
    return new Date(ts).toLocaleDateString('pt-BR', { day: 'numeric', month: 'short' });
  }

  function dayKey(ts) {
    var d = new Date(ts);
    return d.getFullYear() + '-' + (d.getMonth() + 1) + '-' + d.getDate();
  }

  function dayLabel(ts) {
    var hoje = dayKey(Date.now());
    var ontem = dayKey(Date.now() - 86400000);
    var k = dayKey(ts);
    if (k === hoje) return 'Hoje';
    if (k === ontem) return 'Ontem';
    return new Date(ts).toLocaleDateString('pt-BR', { weekday: 'long', day: 'numeric', month: 'long' });
  }

  // ---------------------------------------------------------- carga

  function boot() {
    carregarPrefs();
    ligarControles();
    registrarServiceWorker();
    esqueletoInicial();

    if (window.__SINAL_DATA__) { pronto(window.__SINAL_DATA__); return; }

    fetch('data/latest.json', { cache: 'no-cache' })
      .then(function (r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
      .then(pronto)
      .catch(falhaAoCarregar);
  }

  function pronto(payload) {
    data = payload;
    srcById = new Map(data.sources.map(function (s) { return [s.id, s]; }));
    topicById = new Map(data.topics.map(function (t) { return [t.id, t]; }));
    if (!data.aiEnabled) state.lang = 'orig';

    absorver(data.items);

    montarCabecalho();
    montarChipsDeTema();
    montarListaDeFontes();
    montarCuradoria();
    montarSaude();
    sincronizarControles();
    render();

    // a prévia traz os dados embutidos e não tem acervo para consultar
    if (!data.demo) carregarIndice().then(garantirPeriodo);
    else atualizarRodapeAcervo();

    mostrarDicaDeInstalacao();
  }

  /** Junta matérias no acervo em memória, sem perder o que já é mais completo. */
  function absorver(itens) {
    for (var i = 0; i < itens.length; i++) {
      var it = itens[i];
      var antigo = pool.get(it.id);
      if (!antigo || (!antigo.title_pt && it.title_pt)) {
        it._fold = fold(it.title + ' ' + (it.title_pt || '') + ' ' + (it.summary || ''));
        pool.set(it.id, it);
      }
    }
  }

  function carregarIndice() {
    return fetch('data/indice.json', { cache: 'no-cache' })
      .then(function (r) { return r.ok ? r.json() : { dias: [] }; })
      .then(function (j) { indice = j || { dias: [] }; })
      .catch(function () { indice = { dias: [] }; });
  }

  /** Busca do acervo os dias que o período pede e ainda não estão carregados. */
  function garantirPeriodo() {
    var quantos = PERIODOS[state.periodo].dias;
    var querer = (indice.dias || []).slice(0, quantos).map(function (d) { return d.dia; });
    var faltando = querer.filter(function (d) { return !diasCarregados.has(d); });
    if (!faltando.length) { atualizarRodapeAcervo(); return Promise.resolve(); }

    carregando = true;
    atualizarRodapeAcervo();

    return Promise.all(faltando.map(function (dia) {
      return fetch('data/dias/' + dia + '.json', { cache: 'force-cache' })
        .then(function (r) { return r.ok ? r.json() : null; })
        .then(function (j) {
          diasCarregados.add(dia);
          if (j && j.itens) absorver(j.itens);
        })
        .catch(function () { diasCarregados.add(dia); });
    })).then(function () {
      carregando = false;
      montarChipsDeTema();
      montarListaDeFontes();
      render();
      atualizarRodapeAcervo();
    });
  }

  function falhaAoCarregar(err) {
    $('#results').innerHTML =
      '<div class="loadfail"><h2>Ainda não há edição publicada</h2>' +
      '<p>Não consegui abrir <code>data/latest.json</code> (' + esc(err.message) + ').</p>' +
      '<p>Se você acabou de publicar o site, rode a coleta uma vez: na aba <b>Actions</b> do repositório, ' +
      'escolha <b>Coleta diária</b> e clique em <b>Run workflow</b>.</p></div>';
    $('#statline').textContent = '';
  }

  // ---------------------------------------------------------- acervo pessoal

  function ehFavorito(id) { return Object.prototype.hasOwnProperty.call(favoritos, id); }
  function ehDescartado(id) { return Object.prototype.hasOwnProperty.call(descartes, id); }

  function alternarFavorito(id) {
    if (ehFavorito(id)) { delete favoritos[id]; }
    else {
      var it = pool.get(id);
      if (!it) return;
      var s = srcById.get(it.sourceId) || {};
      // guarda uma cópia própria: o favorito sobrevive à poda do acervo
      favoritos[id] = {
        id: id, url: it.url, title: it.title, title_pt: it.title_pt,
        summary: it.summary, summary_pt: it.summary_pt,
        sourceId: it.sourceId, sourceName: s.name || it.sourceId, section: s.section || '',
        site: s.site || '', paywall: !!s.paywall,
        ts: it.ts, topics: it.topics || [], salvoEm: Date.now(),
      };
      delete descartes[id];  // favoritar desfaz um descarte anterior
      gravar(K.desc, descartes);
    }
    gravar(K.fav, favoritos);
    render();
    atualizarPainelPessoal();
  }

  function descartar(id, motivo) {
    var it = pool.get(id);
    if (!it) return;
    descartes[id] = {
      motivo: motivo, em: Date.now(),
      sourceId: it.sourceId, topics: it.topics || [],
      title: it.title_pt || it.title,
    };
    delete favoritos[id];
    gravar(K.desc, descartes);
    gravar(K.fav, favoritos);
    render();
    atualizarPainelPessoal();
  }

  function restaurarDescarte(id) {
    delete descartes[id];
    gravar(K.desc, descartes);
    render();
    atualizarPainelPessoal();
  }

  function esquecerFonte(sourceId) {
    esquecidas.add(sourceId);
    gravar(K.esq, Array.from(esquecidas));
    montarListaDeFontes();
    render();
    atualizarPainelPessoal();
  }

  function lembrarFonte(sourceId) {
    esquecidas.delete(sourceId);
    gravar(K.esq, Array.from(esquecidas));
    montarListaDeFontes();
    render();
    atualizarPainelPessoal();
  }

  // ---------------------------------------------------------- aprendizado

  /**
   * O que o site aprendeu com os descartes, recalculado a partir deles.
   * Guardar só os descartes e derivar o resto evita que as duas coisas
   * fiquem em desacordo depois de um "desfazer".
   */
  function aprendizado() {
    var porFonte = {}, porFonteTema = {};
    var ids = Object.keys(descartes);
    for (var i = 0; i < ids.length; i++) {
      var d = descartes[ids[i]];
      if (!d || d.motivo === 'sem-motivo') continue;
      var temas = d.topics || [];
      if (d.motivo === 'fora-do-tema') {
        for (var t = 0; t < temas.length; t++) {
          var k = d.sourceId + '|' + temas[t];
          porFonteTema[k] = (porFonteTema[k] || 0) + 1;
        }
      } else if (d.motivo === 'local-factual') {
        porFonte[d.sourceId] = (porFonte[d.sourceId] || 0) + 1;
        for (var u = 0; u < temas.length; u++) {
          var k2 = d.sourceId + '|' + temas[u];
          porFonteTema[k2] = (porFonteTema[k2] || 0) + 0.5;
        }
      }
    }
    return { porFonte: porFonte, porFonteTema: porFonteTema };
  }

  var _apr = null;
  function penalidade(it) {
    if (!_apr) _apr = aprendizado();
    var p = (_apr.porFonte[it.sourceId] || 0) * 0.04;
    var temas = it.topics || [];
    for (var i = 0; i < temas.length; i++) {
      p += (_apr.porFonteTema[it.sourceId + '|' + temas[i]] || 0) * 0.05;
    }
    return Math.min(0.4, p);
  }

  // ---------------------------------------------------------- seleção

  function itensVisiveis() {
    _apr = aprendizado();

    if (state.vista === 'favoritos') {
      var favs = Object.keys(favoritos).map(function (id) { return favoritos[id]; });
      favs.sort(function (a, b) { return b.salvoEm - a.salvoEm; });
      return favs;
    }

    var per = PERIODOS[state.periodo];
    var corte = per.horas > 0 ? Date.now() - per.horas * 3600000 : 0;
    var q = fold(state.q.trim());
    var termos = q ? q.split(/\s+/).filter(Boolean) : [];

    var todos = Array.from(pool.values());

    var out = todos.filter(function (it) {
      var descartado = ehDescartado(it.id);
      if (state.vista === 'descartados') return descartado;
      if (descartado && !state.mostrarDescartados) return false;

      if (it.ts < corte) return false;
      if (esquecidas.has(it.sourceId)) return false;
      if (state.offSources.has(it.sourceId)) return false;
      if (state.topics.size && !(it.topics || []).some(function (t) { return state.topics.has(t); })) return false;
      if (state.hidePaywall) {
        var s = srcById.get(it.sourceId);
        if (s && s.paywall) return false;
      }
      if (termos.length) {
        var hay = it._fold + ' ' + fold((srcById.get(it.sourceId) || {}).name || '');
        for (var i = 0; i < termos.length; i++) if (hay.indexOf(termos[i]) === -1) return false;
      }
      return true;
    });

    if (state.sort === 'time') out.sort(function (a, b) { return b.ts - a.ts; });
    else if (state.sort === 'coverage') out.sort(function (a, b) { return (b.clusterSize - a.clusterSize) || (b.score - a.score); });
    else out.sort(function (a, b) { return (b.score - penalidade(b)) - (a.score - penalidade(a)); });

    return out;
  }

  // ---------------------------------------------------------- montagem

  function esqueletoInicial() {
    var html = '';
    for (var i = 0; i < 6; i++) {
      html += '<div class="skel"><div class="skel-line w1"></div><div class="skel-line w2"></div><div class="skel-line w3"></div></div>';
    }
    $('#results').innerHTML = html;
  }

  function montarCabecalho() {
    var d = new Date(data.generatedAt);
    $('#edition-date').textContent =
      d.toLocaleDateString('pt-BR', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' }) +
      ' · edição das ' + d.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' }) +
      (data.demo ? ' · PRÉVIA, manchetes fictícias' : '');

    var st = data.stats || {};
    var partes = [
      '<b>' + (st.publishedItems || 0) + '</b> nesta edição',
      '<b>' + (st.sourcesOk || 0) + '</b> de <b>' + (st.sourcesTotal || 0) + '</b> fontes responderam',
    ];
    if (data.aiEnabled) partes.push('curadoria por IA ativa');
    $('#statline').innerHTML = partes.join(' <span class="dot">·</span> ');

    if (data.briefing) $('#btn-ai').hidden = false;
    if (!data.aiEnabled) { var seg = $('.seg'); if (seg) seg.style.display = 'none'; }
  }

  function contarPorTema(id) {
    var n = 0;
    pool.forEach(function (it) {
      if (esquecidas.has(it.sourceId)) return;
      if (ehDescartado(it.id) && !state.mostrarDescartados) return;
      if ((it.topics || []).indexOf(id) !== -1) n++;
    });
    return n;
  }

  function montarChipsDeTema() {
    $('#topic-chips').innerHTML = data.topics.map(function (t) {
      var n = contarPorTema(t.id);
      return '<button class="chip' + (state.topics.has(t.id) ? ' is-on' : '') + (n ? '' : ' is-empty') +
        '" data-topic="' + esc(t.id) + '" title="' + esc(t.description) + '" aria-pressed="' +
        (state.topics.has(t.id) ? 'true' : 'false') + '">' +
        esc(t.short || t.label) + ' <span class="n">' + n + '</span></button>';
    }).join('');
  }

  function contarPorFonte(id) {
    var n = 0;
    pool.forEach(function (it) { if (it.sourceId === id) n++; });
    return n;
  }

  function montarListaDeFontes() {
    var grupos = data.groups || {};
    var ordem = Object.keys(grupos);
    var porGrupo = {};
    data.sources.forEach(function (s) {
      if (esquecidas.has(s.id)) return;
      (porGrupo[s.group] = porGrupo[s.group] || []).push(s);
    });

    $('#source-groups').innerHTML = ordem.filter(function (g) { return porGrupo[g]; }).map(function (g) {
      var lista = porGrupo[g];
      var ligadas = lista.filter(function (s) { return !state.offSources.has(s.id); }).length;
      return '<details class="sgroup"' + (ligadas < lista.length ? ' open' : '') + '>' +
        '<summary><span>' + esc(grupos[g]) + '</span>' +
        '<span class="sgroup-count" data-gcount="' + esc(g) + '">' + ligadas + '/' + lista.length + '</span></summary>' +
        '<div class="sgroup-body">' +
        '<div style="margin:0 0 5px"><button class="linkish" data-gtoggle="' + esc(g) + '">inverter grupo</button></div>' +
        lista.map(function (s) {
          return '<label class="src' + (s.ok ? '' : ' is-down') + '" title="' +
            esc(s.ok ? s.site : 'Não respondeu na última coleta: ' + (s.error || 'erro')) + '">' +
            '<input type="checkbox" data-src="' + esc(s.id) + '"' + (state.offSources.has(s.id) ? '' : ' checked') + '>' +
            '<span class="src-name">' + esc(s.name) +
            (s.section ? ' <span class="src-sec">' + esc(s.section) + '</span>' : '') +
            (s.paywall ? ' <span class="src-lock" title="assinatura">🔒</span>' : '') +
            '</span><span class="src-n">' + contarPorFonte(s.id) + '</span></label>';
        }).join('') +
        '</div></details>';
    }).join('');
  }

  function montarCuradoria() {
    var b = data.briefing, el = $('#briefing');
    if (!b) { el.hidden = true; return; }

    var blocos = (b.blocks || []).map(function (bl) {
      var refs = (bl.ids || []).map(function (id) {
        var it = pool.get(id);
        if (!it) return '';
        var s = srcById.get(it.sourceId);
        return '<a class="ref" href="#' + esc(id) + '" data-jump="' + esc(id) + '">' + esc((s && s.name) || it.sourceId) + '</a>';
      }).join('');
      return '<div class="bblock"><h3>' + esc(bl.title) + '</h3><p>' + esc(bl.body) + '</p>' +
        (refs ? '<div class="bblock-refs">' + refs + '</div>' : '') + '</div>';
    }).join('');

    var colunas = '';
    if ((b.connections || []).length || (b.watchlist || []).length) {
      colunas = '<div class="briefing-grid">' +
        ((b.connections || []).length ? '<div class="bcol"><h4>Linhas que se cruzam</h4><ul>' +
          b.connections.map(function (c) { return '<li>' + esc(c) + '</li>'; }).join('') + '</ul></div>' : '') +
        ((b.watchlist || []).length ? '<div class="bcol"><h4>De olho nos próximos dias</h4><ul>' +
          b.watchlist.map(function (c) { return '<li>' + esc(c) + '</li>'; }).join('') + '</ul></div>' : '') +
        '</div>';
    }

    var modelo = (data.ai && data.ai.models && data.ai.models.briefing) || 'modelo de IA';

    el.innerHTML =
      '<p class="briefing-kicker">Curadoria por IA</p>' +
      '<h2>' + esc(b.headline || 'O que importa hoje') + '</h2>' +
      (b.lede ? '<p class="briefing-lede">' + esc(b.lede) + '</p>' : '') +
      '<div class="briefing-blocks">' + blocos + '</div>' + colunas +
      '<p class="briefing-foot">Texto gerado por ' + esc(modelo) + ' a partir das manchetes desta edição, sem leitura das matérias completas. ' +
      'Serve para orientar a leitura, não para substituí-la — confirme na fonte antes de citar.</p>';

    el.hidden = !state.briefingOpen;
    $('#btn-ai').setAttribute('aria-expanded', state.briefingOpen ? 'true' : 'false');
  }

  function montarSaude() {
    var linhas = data.sources.slice().sort(function (a, b) {
      return (a.ok === b.ok) ? a.name.localeCompare(b.name, 'pt-BR') : (a.ok ? 1 : -1);
    }).map(function (s) {
      return '<div class="hrow"><span class="hdot ' + (s.ok ? 'up' : 'down') + '"></span>' +
        '<span class="hname">' + esc(s.name) + (s.section ? ' · ' + esc(s.section) : '') + '</span>' +
        (s.ok ? '<span class="herr">' + s.count + '</span>' : '<span class="herr">' + esc(s.error || 'falhou') + '</span>') +
        '</div>';
    }).join('');

    $('#health-body').innerHTML = '<div class="health-grid">' + linhas + '</div>';
    var fora = data.sources.filter(function (s) { return !s.ok; }).length;
    $('#health summary').textContent = fora
      ? 'Situação das fontes — ' + fora + ' não responderam na última coleta'
      : 'Situação das fontes — todas responderam';

    var st = data.stats || {};
    $('#foot-note').innerHTML =
      'Coletado em ' + esc(new Date(data.generatedAt).toLocaleString('pt-BR')) +
      ' · ' + (st.rawItems || 0) + ' itens brutos reduzidos a ' + (st.publishedItems || 0) +
      ' após deduplicação e agrupamento' +
      (data.ai ? ' · ' + (data.ai.translatedCount || 0) + ' traduzidas' : '') +
      '.<br>Este site indexa manchetes e resumos publicados nos feeds oficiais de cada veículo e sempre leva ao original. ' +
      'Os direitos são de quem publicou.';
  }

  function atualizarRodapeAcervo() {
    var el = $('#acervo-info');
    if (!el) return;
    var total = (indice.dias || []).length;
    if (carregando) { el.textContent = 'carregando acervo…'; return; }
    el.textContent = total
      ? diasCarregados.size + ' de ' + total + ' dia(s) do acervo em memória'
      : 'acervo começa a se formar a partir da próxima coleta';
  }

  // ---------------------------------------------------------- painel pessoal

  function atualizarPainelPessoal() {
    var nFav = Object.keys(favoritos).length;
    var nDesc = Object.keys(descartes).length;
    var nEsq = esquecidas.size;

    $('#conta-fav').textContent = nFav || '';
    $('#conta-desc').textContent = nDesc || '';

    $$('.vista-btn').forEach(function (b) {
      b.classList.toggle('is-on', b.dataset.vista === state.vista);
    });

    var apr = aprendizado();
    var linhas = [];
    Object.keys(apr.porFonteTema).sort(function (a, b) {
      return apr.porFonteTema[b] - apr.porFonteTema[a];
    }).slice(0, 8).forEach(function (k) {
      var p = k.split('|');
      var s = srcById.get(p[0]);
      var t = topicById.get(p[1]);
      if (!s || !t) return;
      linhas.push('<div class="apr-row"><span>' + esc(s.name) + ' em <b>' + esc(t.short || t.label) + '</b></span>' +
        '<span class="apr-n">−' + apr.porFonteTema[k] + '</span></div>');
    });

    var esqHtml = '';
    if (nEsq) {
      esqHtml = '<div class="esq-lista">' + Array.from(esquecidas).map(function (id) {
        var s = srcById.get(id);
        return '<div class="apr-row"><span>' + esc(s ? s.name + (s.section ? ' · ' + s.section : '') : id) + '</span>' +
          '<button class="linkish" data-lembrar="' + esc(id) + '">voltar a mostrar</button></div>';
      }).join('') + '</div>';
    }

    $('#aprendizado-body').innerHTML =
      (linhas.length
        ? '<p class="panel-hint">Quanto mais você descarta com motivo, mais o site desce essas combinações no ranking.</p>' + linhas.join('')
        : '<p class="panel-hint">Nada aprendido ainda. Descarte matérias com um motivo e as combinações aparecem aqui.</p>') +
      (nEsq ? '<h3 class="apr-sub">Fontes esquecidas (' + nEsq + ')</h3>' + esqHtml : '');
  }

  // ---------------------------------------------------------- matérias

  function acoesHtml(it, favorito, descartado) {
    if (state.vista === 'favoritos') {
      return '<div class="acoes">' +
        '<button class="acao is-fav" data-fav="' + esc(it.id) + '" title="Remover dos favoritos">★ favorita</button>' +
        '</div>';
    }
    if (descartado) {
      var m = descartes[it.id];
      var rot = (MOTIVOS.filter(function (x) { return x.id === m.motivo; })[0] || {}).rotulo || 'descartada';
      return '<div class="acoes"><span class="acao-nota">descartada: ' + esc(rot.toLowerCase()) + '</span>' +
        '<button class="acao" data-restaurar="' + esc(it.id) + '">restaurar</button></div>';
    }
    var s = srcById.get(it.sourceId) || {};
    return '<div class="acoes">' +
      '<button class="acao' + (favorito ? ' is-fav' : '') + '" data-fav="' + esc(it.id) + '" ' +
        'title="' + (favorito ? 'Remover dos favoritos' : 'Guardar nos favoritos') + '">' +
        (favorito ? '★ favorita' : '☆ favoritar') + '</button>' +
      '<button class="acao" data-descartar="' + esc(it.id) + '" title="Tirar da lista">✕ descartar</button>' +
      '<button class="acao acao-fonte" data-esquecer="' + esc(it.sourceId) + '" ' +
        'title="Não mostrar mais nada de ' + esc(s.name || it.sourceId) + '">esquecer fonte</button>' +
      '</div>';
  }

  function materiaHtml(it) {
    var s = srcById.get(it.sourceId) || { name: it.sourceName || it.sourceId, site: it.site || '#' };
    var usaPt = state.lang === 'pt';
    var titulo = (usaPt && it.title_pt) || it.title;
    var resumo = (usaPt && it.summary_pt) || it.summary;
    var favorito = ehFavorito(it.id);
    var descartado = ehDescartado(it.id);

    var cab = '<a class="art-source" href="' + esc(s.site || '#') + '" target="_blank" rel="noopener">' + esc(s.name) + '</a>';
    if (s.section) cab += '<span class="art-sec">' + esc(s.section) + '</span>';
    cab += '<span class="art-sep">·</span><span class="art-time" title="' +
      esc(new Date(it.ts).toLocaleString('pt-BR')) + '">' + esc(relTime(it.ts)) + '</span>';
    if (s.paywall) cab += '<span class="badge badge-pay">assinatura</span>';
    if (it.clusterSize > 2) cab += '<span class="badge badge-cov">' + it.clusterSize + ' veículos</span>';
    if (usaPt && it.title_pt) cab += '<span class="badge" title="Tradução automática do original">traduzido</span>';

    var tags = (it.topics || []).map(function (t) {
      var tt = topicById.get(t);
      return tt ? '<button class="ttag" data-topic="' + esc(t) + '">' + esc(tt.short || tt.label) + '</button>' : '';
    }).join('');

    var tambem = '';
    if (it.alsoIn && it.alsoIn.length) {
      tambem = '<details class="also"><summary>também em ' + it.alsoIn.length + ' outro' +
        (it.alsoIn.length > 1 ? 's' : '') + '</summary><div class="also-body">' +
        it.alsoIn.map(function (a) {
          return '<div class="also-item"><span class="also-src">' + esc(a.source) + '</span> ' +
            '<a href="' + esc(a.url) + '" target="_blank" rel="noopener">' + esc(a.title) + '</a></div>';
        }).join('') + '</div></details>';
    }

    return '<article class="art' + (descartado ? ' is-descartada' : '') + (favorito ? ' is-favorita' : '') +
      '" id="' + esc(it.id) + '">' +
      '<div class="art-head">' + cab + '</div>' +
      '<h2 class="art-title"><a href="' + esc(it.url) + '" target="_blank" rel="noopener">' + esc(titulo) + '</a></h2>' +
      (resumo ? '<p class="art-sum">' + esc(resumo) + '</p>' : '') +
      '<div class="art-foot">' + tags + '</div>' +
      acoesHtml(it, favorito, descartado) +
      tambem +
      '</article>';
  }

  function render() {
    var itens = itensVisiveis();
    var fatia = itens.slice(0, state.limit);
    var res = $('#results');
    res.classList.toggle('compact', state.compact);

    if (!itens.length) {
      res.innerHTML = '';
      $('#empty').hidden = false;
      $('#empty-title').textContent =
        state.vista === 'favoritos' ? 'Nenhuma matéria favoritada ainda'
        : state.vista === 'descartados' ? 'Nada descartado ainda'
        : 'Nenhuma matéria com esses filtros.';
      $('#empty-text').textContent =
        state.vista === 'favoritos' ? 'Toque em “favoritar” em qualquer matéria. Favoritos ficam guardados neste aparelho e nunca somem sozinhos.'
        : state.vista === 'descartados' ? 'Quando você descartar uma matéria, ela aparece aqui e pode voltar.'
        : 'Tente ampliar o período, limpar a busca ou desmarcar alguns temas.';
      $('#more').hidden = true;
      montarBarraDeFiltros();
      atualizarPainelPessoal();
      return;
    }
    $('#empty').hidden = true;

    var html = '';
    if (state.sort === 'time' && state.vista !== 'favoritos') {
      var ultimoDia = null;
      fatia.forEach(function (it) {
        var k = dayKey(it.ts);
        if (k !== ultimoDia) { html += '<div class="daymark">' + esc(dayLabel(it.ts)) + '</div>'; ultimoDia = k; }
        html += materiaHtml(it);
      });
    } else {
      html = fatia.map(materiaHtml).join('');
    }
    res.innerHTML = html;

    var mais = $('#more');
    mais.hidden = fatia.length >= itens.length;
    mais.textContent = 'Carregar mais ' + Math.min(PAGE, itens.length - fatia.length) +
      ' de ' + (itens.length - fatia.length) + ' restantes';

    montarBarraDeFiltros();
    atualizarPainelPessoal();
  }

  function montarBarraDeFiltros() {
    var bits = [];
    if (state.vista !== 'tudo') {
      bits.push('<span class="tag-active tag-vista">' +
        (state.vista === 'favoritos' ? 'Favoritas' : 'Descartadas') +
        '<button data-vista="tudo" aria-label="Voltar para tudo">×</button></span>');
    }
    state.topics.forEach(function (id) {
      var t = topicById.get(id);
      if (t) bits.push('<span class="tag-active">' + esc(t.label) +
        '<button data-untopic="' + esc(id) + '" aria-label="Remover tema">×</button></span>');
    });
    if (state.q.trim()) {
      bits.push('<span class="tag-active">busca: “' + esc(state.q.trim()) +
        '”<button data-unq="1" aria-label="Limpar busca">×</button></span>');
    }
    if (state.offSources.size) {
      bits.push('<span class="tag-active">' + state.offSources.size + ' fonte(s) oculta(s)' +
        '<button data-unsrc="1" aria-label="Reativar fontes">×</button></span>');
    }
    if (esquecidas.size) {
      bits.push('<span class="tag-active">' + esquecidas.size + ' esquecida(s)' +
        '<button data-unesq="1" aria-label="Lembrar todas as fontes">×</button></span>');
    }

    var bar = $('#chipbar');
    if (!bits.length) { bar.hidden = true; return; }
    bar.hidden = false;
    bar.innerHTML = '<span class="chipbar-label">Filtrando</span>' + bits.join('');
  }

  // ---------------------------------------------------------- exportar e importar

  function exportar() {
    var pacote = {
      formato: 'sinal-acervo-pessoal',
      versao: 1,
      exportadoEm: new Date().toISOString(),
      favoritos: favoritos,
      descartes: descartes,
      esquecidas: Array.from(esquecidas),
      preferencias: ler(K.prefs, {}),
    };
    var blob = new Blob([JSON.stringify(pacote, null, 2)], { type: 'application/json' });
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url;
    a.download = 'sinal-meus-dados-' + new Date().toISOString().slice(0, 10) + '.json';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
  }

  function importar(arquivo) {
    var leitor = new FileReader();
    leitor.onload = function () {
      var p;
      try { p = JSON.parse(leitor.result); } catch (e) { avisar('Arquivo inválido.'); return; }
      if (!p || p.formato !== 'sinal-acervo-pessoal') { avisar('Esse arquivo não é uma exportação do Sinal.'); return; }

      var antesFav = Object.keys(favoritos).length;
      Object.keys(p.favoritos || {}).forEach(function (id) {
        if (!favoritos[id]) favoritos[id] = p.favoritos[id];
      });
      Object.keys(p.descartes || {}).forEach(function (id) {
        if (!descartes[id]) descartes[id] = p.descartes[id];
      });
      (p.esquecidas || []).forEach(function (s) { esquecidas.add(s); });

      gravar(K.fav, favoritos);
      gravar(K.desc, descartes);
      gravar(K.esq, Array.from(esquecidas));

      var novos = Object.keys(favoritos).length - antesFav;
      montarListaDeFontes();
      render();
      avisar('Importado: ' + novos + ' favorito(s) novo(s). Nada foi sobrescrito.');
    };
    leitor.readAsText(arquivo);
  }

  function avisar(texto) {
    var el = $('#aviso');
    el.textContent = texto;
    el.hidden = false;
    clearTimeout(avisar._t);
    avisar._t = setTimeout(function () { el.hidden = true; }, 5000);
  }

  // ---------------------------------------------------------- aplicativo

  function registrarServiceWorker() {
    if (!('serviceWorker' in navigator)) return;
    if (location.protocol === 'file:') return;   // prévia local não registra
    window.addEventListener('load', function () {
      navigator.serviceWorker.register('sw.js').catch(function () { /* segue como site normal */ });
    });
  }

  function mostrarDicaDeInstalacao() {
    var ios = /iphone|ipad|ipod/i.test(navigator.userAgent);
    var instalado = window.navigator.standalone === true ||
      (window.matchMedia && window.matchMedia('(display-mode: standalone)').matches);
    if (!ios || instalado || ler(K.dica, false)) return;

    var el = $('#dica-instalar');
    el.hidden = false;
    el.querySelector('[data-fechar-dica]').addEventListener('click', function () {
      el.hidden = true;
      gravar(K.dica, true);
    });
  }

  // ---------------------------------------------------------- menu de descarte

  function abrirMenuDescarte(id, ancora) {
    fecharMenus();
    var menu = document.createElement('div');
    menu.className = 'menu-motivo';
    menu.innerHTML = '<p class="menu-titulo">Por que tirar esta da lista?</p>' +
      MOTIVOS.map(function (m) {
        return '<button class="menu-item" data-motivo="' + esc(m.id) + '" data-alvo="' + esc(id) + '">' +
          '<b>' + esc(m.rotulo) + '</b><small>' + esc(m.ajuda) + '</small></button>';
      }).join('') +
      '<button class="menu-cancelar" data-fechar-menu="1">cancelar</button>';
    ancora.parentNode.insertBefore(menu, ancora.nextSibling);
    var primeiro = menu.querySelector('.menu-item');
    if (primeiro) primeiro.focus();
  }

  function fecharMenus() {
    $$('.menu-motivo').forEach(function (m) { m.parentNode.removeChild(m); });
  }

  // ---------------------------------------------------------- controles

  function sincronizarControles() {
    $('#sort').value = state.sort;
    $('#periodo').value = state.periodo;
    $('#hide-paywall').checked = state.hidePaywall;
    $('#compact').checked = state.compact;
    $('#ver-descartados').checked = state.mostrarDescartados;
    $('#q').value = state.q;
    $$('.seg-btn').forEach(function (b) { b.classList.toggle('is-on', b.dataset.lang === state.lang); });
    var n = state.topics.size + state.offSources.size + esquecidas.size + (state.q.trim() ? 1 : 0);
    $('#filter-count').textContent = n ? String(n) : '';
  }

  function atualizar(zerarLimite) {
    if (zerarLimite !== false) state.limit = PAGE;
    sincronizarControles();
    render();
    salvarPrefs();
  }

  function atualizarContagensDeGrupo() {
    if (!data) return;
    var porGrupo = {};
    data.sources.forEach(function (s) {
      if (esquecidas.has(s.id)) return;
      (porGrupo[s.group] = porGrupo[s.group] || []).push(s);
    });
    Object.keys(porGrupo).forEach(function (g) {
      var el = document.querySelector('[data-gcount="' + g + '"]');
      if (!el) return;
      var on = porGrupo[g].filter(function (s) { return !state.offSources.has(s.id); }).length;
      el.textContent = on + '/' + porGrupo[g].length;
    });
  }

  function alternarGaveta(abrir) {
    var sb = $('#sidebar');
    var aberta = abrir === undefined ? !sb.classList.contains('is-open') : abrir;
    sb.classList.toggle('is-open', aberta);
    $('#scrim').hidden = !aberta;
    $('#btn-filters').setAttribute('aria-expanded', aberta ? 'true' : 'false');
    document.body.style.overflow = aberta && window.innerWidth <= 900 ? 'hidden' : '';
  }

  function irPara(id) {
    var el = document.getElementById(id);
    if (!el) {
      state.limit = Math.max(state.limit, 600);
      render();
      el = document.getElementById(id);
      if (!el) return;
    }
    el.scrollIntoView({ behavior: 'smooth', block: 'center' });
    el.classList.remove('is-hit');
    void el.offsetWidth;
    el.classList.add('is-hit');
  }

  function ligarControles() {
    $('#btn-theme').addEventListener('click', function () {
      var atual = document.documentElement.getAttribute('data-theme');
      var escuro = atual === 'dark' ||
        (atual !== 'light' && window.matchMedia('(prefers-color-scheme: dark)').matches);
      document.documentElement.setAttribute('data-theme', escuro ? 'light' : 'dark');
      salvarPrefs();
    });

    $$('.seg-btn').forEach(function (b) {
      b.addEventListener('click', function () { state.lang = b.dataset.lang; atualizar(false); });
    });

    $('#btn-ai').addEventListener('click', function () {
      state.briefingOpen = !state.briefingOpen;
      $('#briefing').hidden = !state.briefingOpen;
      this.setAttribute('aria-expanded', state.briefingOpen ? 'true' : 'false');
      if (state.briefingOpen) $('#briefing').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    });

    var t;
    $('#q').addEventListener('input', function (e) {
      clearTimeout(t);
      var v = e.target.value;
      t = setTimeout(function () { state.q = v; atualizar(); }, 180);
    });

    $('#sort').addEventListener('change', function (e) { state.sort = e.target.value; atualizar(); });
    $('#periodo').addEventListener('change', function (e) {
      state.periodo = e.target.value;
      salvarPrefs();
      garantirPeriodo().then(function () { atualizar(); });
      atualizar();
    });
    $('#hide-paywall').addEventListener('change', function (e) { state.hidePaywall = e.target.checked; atualizar(); });
    $('#compact').addEventListener('change', function (e) { state.compact = e.target.checked; atualizar(); });
    $('#ver-descartados').addEventListener('change', function (e) {
      state.mostrarDescartados = e.target.checked;
      montarChipsDeTema();
      atualizar();
    });

    $('#exportar').addEventListener('click', exportar);
    $('#importar').addEventListener('click', function () { $('#arquivo-import').click(); });
    $('#arquivo-import').addEventListener('change', function (e) {
      if (e.target.files && e.target.files[0]) importar(e.target.files[0]);
      e.target.value = '';
    });

    document.addEventListener('click', function (e) {
      var alvo;

      if ((alvo = e.target.closest('[data-fav]'))) { alternarFavorito(alvo.dataset.fav); return; }
      if ((alvo = e.target.closest('[data-descartar]'))) {
        abrirMenuDescarte(alvo.dataset.descartar, alvo.closest('.acoes'));
        return;
      }
      if ((alvo = e.target.closest('[data-motivo]'))) {
        descartar(alvo.dataset.alvo, alvo.dataset.motivo);
        fecharMenus();
        return;
      }
      if (e.target.closest('[data-fechar-menu]')) { fecharMenus(); return; }
      if ((alvo = e.target.closest('[data-restaurar]'))) { restaurarDescarte(alvo.dataset.restaurar); return; }
      if ((alvo = e.target.closest('[data-esquecer]'))) { esquecerFonte(alvo.dataset.esquecer); return; }
      if ((alvo = e.target.closest('[data-lembrar]'))) { lembrarFonte(alvo.dataset.lembrar); return; }
      if (e.target.closest('[data-unesq]')) {
        esquecidas.clear(); gravar(K.esq, []); montarListaDeFontes(); atualizar(); return;
      }

      if ((alvo = e.target.closest('.vista-btn'))) {
        state.vista = alvo.dataset.vista;
        state.limit = PAGE;
        atualizar();
        if (window.innerWidth <= 900) alternarGaveta(false);
        return;
      }
      if ((alvo = e.target.closest('[data-vista]'))) { state.vista = alvo.dataset.vista; atualizar(); return; }

      if ((alvo = e.target.closest('[data-topic]'))) {
        var id = alvo.dataset.topic;
        if (state.topics.has(id)) state.topics.delete(id); else state.topics.add(id);
        montarChipsDeTema();
        atualizar();
        return;
      }
      if ((alvo = e.target.closest('[data-untopic]'))) {
        state.topics.delete(alvo.dataset.untopic); montarChipsDeTema(); atualizar(); return;
      }
      if (e.target.closest('[data-unq]')) { state.q = ''; atualizar(); return; }
      if (e.target.closest('[data-unsrc]')) { state.offSources.clear(); montarListaDeFontes(); atualizar(); return; }

      if ((alvo = e.target.closest('[data-gtoggle]'))) {
        e.preventDefault();
        var g = alvo.dataset.gtoggle;
        var lista = data.sources.filter(function (s) { return s.group === g && !esquecidas.has(s.id); });
        var algumaLigada = lista.some(function (s) { return !state.offSources.has(s.id); });
        lista.forEach(function (s) {
          if (algumaLigada) state.offSources.add(s.id); else state.offSources.delete(s.id);
        });
        montarListaDeFontes(); atualizar(); return;
      }

      if ((alvo = e.target.closest('[data-jump]'))) { e.preventDefault(); irPara(alvo.dataset.jump); return; }

      if (!e.target.closest('.menu-motivo')) fecharMenus();
    });

    document.addEventListener('change', function (e) {
      var cb = e.target.closest('[data-src]');
      if (!cb) return;
      if (cb.checked) state.offSources.delete(cb.dataset.src);
      else state.offSources.add(cb.dataset.src);
      atualizarContagensDeGrupo();
      atualizar();
    });

    $('#topics-clear').addEventListener('click', function () { state.topics.clear(); montarChipsDeTema(); atualizar(); });
    $('#src-all').addEventListener('click', function () { state.offSources.clear(); montarListaDeFontes(); atualizar(); });
    $('#src-none').addEventListener('click', function () {
      data.sources.forEach(function (s) { state.offSources.add(s.id); });
      montarListaDeFontes(); atualizar();
    });

    $('#more').addEventListener('click', function () { state.limit += PAGE; render(); });

    function restaurarPadrao() {
      state.topics.clear(); state.offSources.clear();
      state.q = ''; state.sort = 'score'; state.periodo = '7d'; state.vista = 'tudo';
      state.hidePaywall = false; state.compact = false; state.mostrarDescartados = false;
      montarChipsDeTema(); montarListaDeFontes(); atualizar();
      garantirPeriodo();
    }
    $('#reset').addEventListener('click', restaurarPadrao);
    $('#empty-reset').addEventListener('click', restaurarPadrao);

    $('#btn-filters').addEventListener('click', function () { alternarGaveta(); });
    $('#scrim').addEventListener('click', function () { alternarGaveta(false); });
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape') { fecharMenus(); alternarGaveta(false); }
      if (e.key === '/' && document.activeElement !== $('#q')) { e.preventDefault(); $('#q').focus(); }
    });
    window.addEventListener('resize', function () {
      if (window.innerWidth > 900) { document.body.style.overflow = ''; $('#scrim').hidden = true; }
    });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
