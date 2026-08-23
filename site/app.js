/* ============================================================
   Sinal — lógica do cliente
   Tudo roda no navegador sobre o JSON gerado na coleta diária.
   Nenhuma chave de API existe deste lado.
   ============================================================ */

(function () {
  'use strict';

  var PAGE = 40;
  var STORE = 'sinal.prefs.v1';

  var state = {
    topics: new Set(),      // vazio = todos os temas
    offSources: new Set(),  // fontes desmarcadas
    lang: 'pt',
    sort: 'score',
    windowH: 48,
    q: '',
    hidePaywall: false,
    compact: false,
    limit: PAGE,
    briefingOpen: false,
  };

  var data = null;
  var srcById = new Map();
  var topicById = new Map();

  // ---------------------------------------------------------- utilidades

  function $(sel) { return document.querySelector(sel); }
  function $$(sel) { return Array.prototype.slice.call(document.querySelectorAll(sel)); }

  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  function fold(s) {
    return String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
  }

  function safeGet() {
    try { return JSON.parse(localStorage.getItem(STORE) || '{}'); } catch (e) { return {}; }
  }
  function safeSet(obj) {
    try { localStorage.setItem(STORE, JSON.stringify(obj)); } catch (e) { /* modo privado, tudo bem */ }
  }

  function savePrefs() {
    safeSet({
      topics: Array.from(state.topics),
      offSources: Array.from(state.offSources),
      lang: state.lang, sort: state.sort, windowH: state.windowH,
      hidePaywall: state.hidePaywall, compact: state.compact,
      theme: document.documentElement.getAttribute('data-theme'),
    });
  }

  function loadPrefs() {
    var p = safeGet();
    if (Array.isArray(p.topics)) state.topics = new Set(p.topics);
    if (Array.isArray(p.offSources)) state.offSources = new Set(p.offSources);
    if (p.lang) state.lang = p.lang;
    if (p.sort) state.sort = p.sort;
    if (typeof p.windowH === 'number') state.windowH = p.windowH;
    if (typeof p.hidePaywall === 'boolean') state.hidePaywall = p.hidePaywall;
    if (typeof p.compact === 'boolean') state.compact = p.compact;
    if (p.theme === 'dark' || p.theme === 'light') {
      document.documentElement.setAttribute('data-theme', p.theme);
    }
  }

  // ---------------------------------------------------------- datas

  var RTF = typeof Intl !== 'undefined' && Intl.RelativeTimeFormat
    ? new Intl.RelativeTimeFormat('pt-BR', { numeric: 'auto' }) : null;

  function relTime(ts) {
    var diffMin = Math.round((Date.now() - ts) / 60000);
    if (diffMin < 1) return 'agora';
    if (!RTF) return new Date(ts).toLocaleString('pt-BR');
    if (diffMin < 60) return RTF.format(-diffMin, 'minute');
    var h = Math.round(diffMin / 60);
    if (h < 24) return RTF.format(-h, 'hour');
    return RTF.format(-Math.round(h / 24), 'day');
  }

  function dayKey(ts) {
    var d = new Date(ts);
    return d.getFullYear() + '-' + (d.getMonth() + 1) + '-' + d.getDate();
  }

  function dayLabel(ts) {
    var today = dayKey(Date.now());
    var yest = dayKey(Date.now() - 86400000);
    var k = dayKey(ts);
    if (k === today) return 'Hoje';
    if (k === yest) return 'Ontem';
    return new Date(ts).toLocaleDateString('pt-BR', { weekday: 'long', day: 'numeric', month: 'long' });
  }

  // ---------------------------------------------------------- carga

  function boot() {
    loadPrefs();
    wireStaticUI();
    renderSkeleton();

    if (window.__SINAL_DATA__) { ready(window.__SINAL_DATA__); return; }

    fetch('data/latest.json?t=' + Date.now())
      .then(function (r) {
        if (!r.ok) throw new Error('HTTP ' + r.status);
        return r.json();
      })
      .then(ready)
      .catch(function (err) { renderLoadFailure(err); });
  }

  function ready(payload) {
    data = payload;
    data.items.forEach(function (it) { it._fold = fold(it.title + ' ' + (it.summary || '')); });
    srcById = new Map(data.sources.map(function (s) { return [s.id, s]; }));
    topicById = new Map(data.topics.map(function (t) { return [t.id, t]; }));

    // fontes que falharam hoje: desmarca visualmente, mas não guarda como preferência
    if (!data.aiEnabled) state.lang = 'orig';

    renderMasthead();
    renderTopicChips();
    renderSourceGroups();
    renderBriefing();
    renderHealth();
    syncControls();
    render();
  }

  // ---------------------------------------------------------- filtragem

  function visibleItems() {
    var cutoff = state.windowH > 0 ? Date.now() - state.windowH * 3600000 : 0;
    var q = fold(state.q.trim());
    var terms = q ? q.split(/\s+/).filter(Boolean) : [];

    var out = data.items.filter(function (it) {
      if (it.ts < cutoff) return false;
      if (state.offSources.has(it.sourceId)) return false;
      if (state.topics.size && !it.topics.some(function (t) { return state.topics.has(t); })) return false;
      if (state.hidePaywall) {
        var s = srcById.get(it.sourceId);
        if (s && s.paywall) return false;
      }
      if (terms.length) {
        var hay = it._fold + ' ' + fold((srcById.get(it.sourceId) || {}).name || '');
        for (var i = 0; i < terms.length; i++) if (hay.indexOf(terms[i]) === -1) return false;
      }
      return true;
    });

    if (state.sort === 'time') out.sort(function (a, b) { return b.ts - a.ts; });
    else if (state.sort === 'coverage') out.sort(function (a, b) { return (b.clusterSize - a.clusterSize) || (b.score - a.score); });
    else out.sort(function (a, b) { return b.score - a.score; });

    return out;
  }

  // ---------------------------------------------------------- renderização

  function renderSkeleton() {
    var html = '';
    for (var i = 0; i < 6; i++) {
      html += '<div class="skel"><div class="skel-line w1"></div><div class="skel-line w2"></div><div class="skel-line w3"></div></div>';
    }
    $('#results').innerHTML = html;
  }

  function renderLoadFailure(err) {
    $('#results').innerHTML =
      '<div class="loadfail"><h2>Ainda não há edição publicada</h2>' +
      '<p>Não consegui abrir <code>data/latest.json</code> (' + esc(err.message) + ').</p>' +
      '<p>Se você acabou de publicar o site, rode a coleta uma vez: na aba <b>Actions</b> do repositório, ' +
      'escolha <b>Coleta diária</b> e clique em <b>Run workflow</b>. A primeira edição aparece em poucos minutos.</p></div>';
    $('#statline').textContent = '';
  }

  function renderMasthead() {
    var d = new Date(data.generatedAt);
    $('#edition-date').textContent =
      d.toLocaleDateString('pt-BR', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' }) +
      ' · edição das ' + d.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' }) +
      (data.demo ? ' · PRÉVIA, manchetes fictícias' : '');

    var st = data.stats || {};
    var parts = [
      '<b>' + (st.publishedItems || 0) + '</b> matérias',
      '<b>' + (st.sourcesOk || 0) + '</b> de <b>' + (st.sourcesTotal || 0) + '</b> fontes responderam',
      '<b>' + (data.topics || []).length + '</b> temas',
    ];
    if (data.aiEnabled) parts.push('curadoria por IA ativa');
    $('#statline').innerHTML = parts.join(' <span class="dot">·</span> ');

    if (data.briefing) $('#btn-ai').hidden = false;

    // sem IA: o seletor de idioma não tem o que alternar
    if (!data.aiEnabled) {
      var seg = $('.seg');
      if (seg) seg.style.display = 'none';
    }
  }

  function renderTopicChips() {
    $('#topic-chips').innerHTML = data.topics.map(function (t) {
      return '<button class="chip' + (state.topics.has(t.id) ? ' is-on' : '') + (t.count ? '' : ' is-empty') +
        '" data-topic="' + esc(t.id) + '" title="' + esc(t.description) + '" aria-pressed="' +
        (state.topics.has(t.id) ? 'true' : 'false') + '">' +
        esc(t.short || t.label) + ' <span class="n">' + t.count + '</span></button>';
    }).join('');
  }

  function renderSourceGroups() {
    var groups = data.groups || {};
    var order = Object.keys(groups);
    var byGroup = {};
    data.sources.forEach(function (s) {
      (byGroup[s.group] = byGroup[s.group] || []).push(s);
    });

    $('#source-groups').innerHTML = order.filter(function (g) { return byGroup[g]; }).map(function (g) {
      var list = byGroup[g];
      var on = list.filter(function (s) { return !state.offSources.has(s.id); }).length;
      return '<details class="sgroup"' + (on < list.length ? ' open' : '') + '>' +
        '<summary><span>' + esc(groups[g]) + '</span>' +
        '<span class="sgroup-count" data-gcount="' + esc(g) + '">' + on + '/' + list.length + '</span></summary>' +
        '<div class="sgroup-body">' +
        '<div style="margin:0 0 5px"><button class="linkish" data-gtoggle="' + esc(g) + '">inverter grupo</button></div>' +
        list.map(function (s) {
          return '<label class="src' + (s.ok ? '' : ' is-down') + '" title="' +
            esc(s.ok ? s.site : 'Não respondeu nesta coleta: ' + (s.error || 'erro')) + '">' +
            '<input type="checkbox" data-src="' + esc(s.id) + '"' + (state.offSources.has(s.id) ? '' : ' checked') + '>' +
            '<span class="src-name">' + esc(s.name) +
            (s.section ? ' <span class="src-sec">' + esc(s.section) + '</span>' : '') +
            (s.paywall ? ' <span class="src-lock" title="assinatura">🔒</span>' : '') +
            '</span><span class="src-n">' + s.count + '</span></label>';
        }).join('') +
        '</div></details>';
    }).join('');
  }

  function renderBriefing() {
    var b = data.briefing;
    var el = $('#briefing');
    if (!b) { el.hidden = true; return; }

    var blocks = (b.blocks || []).map(function (bl) {
      var refs = (bl.ids || []).map(function (id) {
        var it = data.items.find(function (x) { return x.id === id; });
        if (!it) return '';
        var s = srcById.get(it.sourceId);
        return '<a class="ref" href="#' + esc(id) + '" data-jump="' + esc(id) + '">' + esc((s && s.name) || it.sourceId) + '</a>';
      }).join('');
      return '<div class="bblock"><h3>' + esc(bl.title) + '</h3><p>' + esc(bl.body) + '</p>' +
        (refs ? '<div class="bblock-refs">' + refs + '</div>' : '') + '</div>';
    }).join('');

    var cols = '';
    if ((b.connections || []).length || (b.watchlist || []).length) {
      cols = '<div class="briefing-grid">' +
        ((b.connections || []).length ? '<div class="bcol"><h4>Linhas que se cruzam</h4><ul>' +
          b.connections.map(function (c) { return '<li>' + esc(c) + '</li>'; }).join('') + '</ul></div>' : '') +
        ((b.watchlist || []).length ? '<div class="bcol"><h4>De olho nos próximos dias</h4><ul>' +
          b.watchlist.map(function (c) { return '<li>' + esc(c) + '</li>'; }).join('') + '</ul></div>' : '') +
        '</div>';
    }

    var model = (data.ai && data.ai.models && data.ai.models.briefing) || 'modelo de IA';

    el.innerHTML =
      '<p class="briefing-kicker">Curadoria por IA</p>' +
      '<h2>' + esc(b.headline || 'O que importa hoje') + '</h2>' +
      (b.lede ? '<p class="briefing-lede">' + esc(b.lede) + '</p>' : '') +
      '<div class="briefing-blocks">' + blocks + '</div>' + cols +
      '<p class="briefing-foot">Texto gerado por ' + esc(model) + ' a partir das manchetes desta edição, sem leitura das matérias completas. ' +
      'Serve para orientar a leitura, não para substituí-la — confirme na fonte antes de citar.</p>';

    el.hidden = !state.briefingOpen;
    $('#btn-ai').setAttribute('aria-expanded', state.briefingOpen ? 'true' : 'false');
  }

  function renderHealth() {
    var rows = data.sources.slice().sort(function (a, b) {
      return (a.ok === b.ok) ? a.name.localeCompare(b.name, 'pt-BR') : (a.ok ? 1 : -1);
    }).map(function (s) {
      return '<div class="hrow"><span class="hdot ' + (s.ok ? 'up' : 'down') + '"></span>' +
        '<span class="hname">' + esc(s.name) + (s.section ? ' · ' + esc(s.section) : '') + '</span>' +
        (s.ok ? '<span class="herr">' + s.count + '</span>' : '<span class="herr">' + esc(s.error || 'falhou') + '</span>') +
        '</div>';
    }).join('');

    $('#health-body').innerHTML = '<div class="health-grid">' + rows + '</div>';
    var down = data.sources.filter(function (s) { return !s.ok; }).length;
    $('#health summary').textContent = down
      ? 'Situação das fontes — ' + down + ' não responderam nesta coleta'
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

  function renderChipbar() {
    var bits = [];
    state.topics.forEach(function (id) {
      var t = topicById.get(id);
      if (t) bits.push('<span class="tag-active">' + esc(t.label) +
        '<button data-untopic="' + esc(id) + '" aria-label="Remover tema">×</button></span>');
    });
    if (state.q.trim()) {
      bits.push('<span class="tag-active">busca: “' + esc(state.q.trim()) +
        '”<button data-unq="1" aria-label="Limpar busca">×</button></span>');
    }
    var off = state.offSources.size;
    if (off) {
      bits.push('<span class="tag-active">' + off + ' fonte' + (off > 1 ? 's' : '') +
        ' oculta' + (off > 1 ? 's' : '') + '<button data-unsrc="1" aria-label="Reativar fontes">×</button></span>');
    }

    var bar = $('#chipbar');
    if (!bits.length) { bar.hidden = true; return; }
    bar.hidden = false;
    bar.innerHTML = '<span class="chipbar-label">Filtrando</span>' + bits.join('');
  }

  function articleHtml(it) {
    var s = srcById.get(it.sourceId) || { name: it.sourceId, site: '#' };
    var usePt = state.lang === 'pt';
    var title = (usePt && it.title_pt) || it.title;
    var summary = (usePt && it.summary_pt) || it.summary;

    var head = '<a class="art-source" href="' + esc(s.site || '#') + '" target="_blank" rel="noopener">' + esc(s.name) + '</a>';
    if (s.section) head += '<span class="art-sec">' + esc(s.section) + '</span>';
    head += '<span class="art-sep">·</span><span class="art-time" title="' +
      esc(new Date(it.ts).toLocaleString('pt-BR')) + '">' + esc(relTime(it.ts)) + '</span>';
    if (s.paywall) head += '<span class="badge badge-pay">assinatura</span>';
    if (it.clusterSize > 2) head += '<span class="badge badge-cov">' + it.clusterSize + ' veículos</span>';
    if (usePt && it.title_pt) head += '<span class="badge" title="Tradução automática do original">traduzido</span>';

    var tags = (it.topics || []).map(function (t) {
      var tt = topicById.get(t);
      return tt ? '<button class="ttag" data-topic="' + esc(t) + '">' + esc(tt.short || tt.label) + '</button>' : '';
    }).join('');

    var also = '';
    if (it.alsoIn && it.alsoIn.length) {
      also = '<details class="also"><summary>também em ' + it.alsoIn.length + ' outro' +
        (it.alsoIn.length > 1 ? 's' : '') + '</summary><div class="also-body">' +
        it.alsoIn.map(function (a) {
          return '<div class="also-item"><span class="also-src">' + esc(a.source) + '</span> ' +
            '<a href="' + esc(a.url) + '" target="_blank" rel="noopener">' + esc(a.title) + '</a></div>';
        }).join('') + '</div></details>';
    }

    return '<article class="art" id="' + esc(it.id) + '">' +
      '<div class="art-head">' + head + '</div>' +
      '<h2 class="art-title"><a href="' + esc(it.url) + '" target="_blank" rel="noopener">' + esc(title) + '</a></h2>' +
      (summary ? '<p class="art-sum">' + esc(summary) + '</p>' : '') +
      '<div class="art-foot">' + tags + '</div>' + also +
      '</article>';
  }

  function render() {
    var items = visibleItems();
    var slice = items.slice(0, state.limit);

    var res = $('#results');
    res.classList.toggle('compact', state.compact);

    if (!items.length) {
      res.innerHTML = '';
      $('#empty').hidden = false;
      $('#more').hidden = true;
      renderChipbar();
      return;
    }
    $('#empty').hidden = true;

    var html = '';
    if (state.sort === 'time') {
      var lastDay = null;
      slice.forEach(function (it) {
        var k = dayKey(it.ts);
        if (k !== lastDay) { html += '<div class="daymark">' + esc(dayLabel(it.ts)) + '</div>'; lastDay = k; }
        html += articleHtml(it);
      });
    } else {
      html = slice.map(articleHtml).join('');
    }
    res.innerHTML = html;

    var more = $('#more');
    more.hidden = slice.length >= items.length;
    more.textContent = 'Carregar mais ' + Math.min(PAGE, items.length - slice.length) +
      ' de ' + (items.length - slice.length) + ' restantes';

    renderChipbar();
  }

  // ---------------------------------------------------------- controles

  function syncControls() {
    $('#sort').value = state.sort;
    $('#window').value = String(state.windowH);
    $('#hide-paywall').checked = state.hidePaywall;
    $('#compact').checked = state.compact;
    $('#q').value = state.q;
    $$('.seg-btn').forEach(function (b) {
      b.classList.toggle('is-on', b.dataset.lang === state.lang);
    });
    var n = state.topics.size + state.offSources.size + (state.q.trim() ? 1 : 0);
    $('#filter-count').textContent = n ? String(n) : '';
  }

  function refresh(resetLimit) {
    if (resetLimit !== false) state.limit = PAGE;
    syncControls();
    render();
    savePrefs();
  }

  function updateGroupCounts() {
    if (!data) return;
    var byGroup = {};
    data.sources.forEach(function (s) { (byGroup[s.group] = byGroup[s.group] || []).push(s); });
    Object.keys(byGroup).forEach(function (g) {
      var el = document.querySelector('[data-gcount="' + g + '"]');
      if (!el) return;
      var on = byGroup[g].filter(function (s) { return !state.offSources.has(s.id); }).length;
      el.textContent = on + '/' + byGroup[g].length;
    });
  }

  function toggleSidebar(open) {
    var sb = $('#sidebar');
    var isOpen = open === undefined ? !sb.classList.contains('is-open') : open;
    sb.classList.toggle('is-open', isOpen);
    $('#scrim').hidden = !isOpen;
    $('#btn-filters').setAttribute('aria-expanded', isOpen ? 'true' : 'false');
    document.body.style.overflow = isOpen && window.innerWidth <= 900 ? 'hidden' : '';
  }

  function jumpTo(id) {
    var el = document.getElementById(id);
    if (!el) {
      // pode estar além da página atual
      state.limit = Math.max(state.limit, 500);
      render();
      el = document.getElementById(id);
      if (!el) return;
    }
    el.scrollIntoView({ behavior: 'smooth', block: 'center' });
    el.classList.remove('is-hit');
    void el.offsetWidth;
    el.classList.add('is-hit');
  }

  function wireStaticUI() {
    // tema
    $('#btn-theme').addEventListener('click', function () {
      var cur = document.documentElement.getAttribute('data-theme');
      var isDark = cur === 'dark' ||
        (cur !== 'light' && window.matchMedia('(prefers-color-scheme: dark)').matches);
      document.documentElement.setAttribute('data-theme', isDark ? 'light' : 'dark');
      savePrefs();
    });

    // idioma
    $$('.seg-btn').forEach(function (b) {
      b.addEventListener('click', function () { state.lang = b.dataset.lang; refresh(false); });
    });

    // curadoria IA
    $('#btn-ai').addEventListener('click', function () {
      state.briefingOpen = !state.briefingOpen;
      $('#briefing').hidden = !state.briefingOpen;
      this.setAttribute('aria-expanded', state.briefingOpen ? 'true' : 'false');
      if (state.briefingOpen) $('#briefing').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    });

    // busca
    var timer;
    $('#q').addEventListener('input', function (e) {
      clearTimeout(timer);
      var v = e.target.value;
      timer = setTimeout(function () { state.q = v; refresh(); }, 180);
    });

    // selects e caixas
    $('#sort').addEventListener('change', function (e) { state.sort = e.target.value; refresh(); });
    $('#window').addEventListener('change', function (e) { state.windowH = Number(e.target.value); refresh(); });
    $('#hide-paywall').addEventListener('change', function (e) { state.hidePaywall = e.target.checked; refresh(); });
    $('#compact').addEventListener('change', function (e) { state.compact = e.target.checked; refresh(); });

    // temas: delegação cobre a barra lateral e as etiquetas nas matérias
    document.addEventListener('click', function (e) {
      var chip = e.target.closest('[data-topic]');
      if (chip) {
        var id = chip.dataset.topic;
        if (state.topics.has(id)) state.topics.delete(id); else state.topics.add(id);
        renderTopicChips();
        refresh();
        return;
      }
      var untopic = e.target.closest('[data-untopic]');
      if (untopic) { state.topics.delete(untopic.dataset.untopic); renderTopicChips(); refresh(); return; }
      if (e.target.closest('[data-unq]')) { state.q = ''; refresh(); return; }
      if (e.target.closest('[data-unsrc]')) {
        state.offSources.clear(); renderSourceGroups(); refresh(); return;
      }
      var gt = e.target.closest('[data-gtoggle]');
      if (gt) {
        e.preventDefault();
        var g = gt.dataset.gtoggle;
        var list = data.sources.filter(function (s) { return s.group === g; });
        var anyOn = list.some(function (s) { return !state.offSources.has(s.id); });
        list.forEach(function (s) {
          if (anyOn) state.offSources.add(s.id); else state.offSources.delete(s.id);
        });
        renderSourceGroups(); refresh(); return;
      }
      var jump = e.target.closest('[data-jump]');
      if (jump) { e.preventDefault(); jumpTo(jump.dataset.jump); return; }
    });

    // fontes
    document.addEventListener('change', function (e) {
      var cb = e.target.closest('[data-src]');
      if (!cb) return;
      if (cb.checked) state.offSources.delete(cb.dataset.src);
      else state.offSources.add(cb.dataset.src);
      updateGroupCounts();
      refresh();
    });

    $('#topics-clear').addEventListener('click', function () { state.topics.clear(); renderTopicChips(); refresh(); });
    $('#src-all').addEventListener('click', function () { state.offSources.clear(); renderSourceGroups(); refresh(); });
    $('#src-none').addEventListener('click', function () {
      data.sources.forEach(function (s) { state.offSources.add(s.id); });
      renderSourceGroups(); refresh();
    });

    $('#more').addEventListener('click', function () { state.limit += PAGE; render(); });

    function resetAll() {
      state.topics.clear(); state.offSources.clear();
      state.q = ''; state.sort = 'score'; state.windowH = 48;
      state.hidePaywall = false; state.compact = false;
      renderTopicChips(); renderSourceGroups(); refresh();
    }
    $('#reset').addEventListener('click', resetAll);
    $('#empty-reset').addEventListener('click', resetAll);

    // gaveta no celular
    $('#btn-filters').addEventListener('click', function () { toggleSidebar(); });
    $('#scrim').addEventListener('click', function () { toggleSidebar(false); });
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape') toggleSidebar(false);
      if (e.key === '/' && document.activeElement !== $('#q')) { e.preventDefault(); $('#q').focus(); }
    });
    window.addEventListener('resize', function () {
      if (window.innerWidth > 900) { document.body.style.overflow = ''; $('#scrim').hidden = true; }
    });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
