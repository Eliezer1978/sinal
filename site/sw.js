/* ============================================================
   Sinal — service worker

   Serve para duas coisas: abrir instantâneo quando o aplicativo já foi
   usado antes, e continuar mostrando a última edição quando não há rede.

   Regra por tipo de pedido:
     navegação   → tenta a rede, cai para a cópia guardada da página
     dados       → tenta a rede e guarda; sem rede, entrega a última cópia
     estático    → entrega a cópia e atualiza por baixo
   ============================================================ */

var VERSAO = 'sinal-v1';
var CASCA = VERSAO + '-casca';
var DADOS = VERSAO + '-dados';

var ESSENCIAIS = [
  './',
  './index.html',
  './styles.css',
  './app.js',
  './manifest.webmanifest',
  './icones/icone-192.png',
  './icones/icone-512.png',
];

self.addEventListener('install', function (e) {
  e.waitUntil(
    caches.open(CASCA)
      .then(function (c) { return c.addAll(ESSENCIAIS); })
      .then(function () { return self.skipWaiting(); })
      .catch(function () { return self.skipWaiting(); })
  );
});

self.addEventListener('activate', function (e) {
  e.waitUntil(
    caches.keys().then(function (nomes) {
      return Promise.all(nomes.map(function (n) {
        if (n.indexOf(VERSAO) !== 0) return caches.delete(n);
      }));
    }).then(function () { return self.clients.claim(); })
  );
});

function daRedeComCopia(req, cacheNome) {
  return fetch(req).then(function (res) {
    if (res && res.ok) {
      var clone = res.clone();
      caches.open(cacheNome).then(function (c) { c.put(req, clone); }).catch(function () {});
    }
    return res;
  }).catch(function () {
    return caches.match(req).then(function (guardada) {
      if (guardada) return guardada;
      throw new Error('sem rede e sem cópia');
    });
  });
}

self.addEventListener('fetch', function (e) {
  var req = e.request;
  if (req.method !== 'GET') return;

  var url;
  try { url = new URL(req.url); } catch (err) { return; }

  // páginas: sempre tenta a rede, para pegar a edição nova
  if (req.mode === 'navigate') {
    e.respondWith(
      fetch(req).catch(function () {
        return caches.match('./index.html').then(function (r) {
          return r || caches.match('./');
        });
      })
    );
    return;
  }

  var mesmaOrigem = url.origin === self.location.origin;

  // edição e acervo: rede primeiro, cópia como rede de segurança
  if (mesmaOrigem && url.pathname.indexOf('/data/') !== -1) {
    e.respondWith(daRedeComCopia(req, DADOS));
    return;
  }

  // arquivos do site e fontes: cópia primeiro, atualiza em segundo plano
  if (mesmaOrigem || /fonts\.(googleapis|gstatic)\.com/.test(url.hostname)) {
    e.respondWith(
      caches.match(req).then(function (guardada) {
        var daRede = fetch(req).then(function (res) {
          if (res && (res.ok || res.type === 'opaque')) {
            var clone = res.clone();
            caches.open(CASCA).then(function (c) { c.put(req, clone); }).catch(function () {});
          }
          return res;
        }).catch(function () { return guardada; });
        return guardada || daRede;
      })
    );
  }
});
