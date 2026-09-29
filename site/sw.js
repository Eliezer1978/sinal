/* Sinal — service worker.
 *
 * Por que a versão mudou para v2: na v1 a casca do site (index.html, app.js,
 * styles.css) era servida do cache antes da rede. Isso deixa o site instantâneo,
 * mas tem um efeito colateral sério: uma correção publicada no app.js só chegava
 * ao aparelho que já tinha visitado o site depois de limpar o cache à mão. Foi
 * exatamente o que aconteceu com a correção da ordem cronológica.
 *
 * Agora a casca é "rede primeiro, cache como rede de segurança": o aparelho
 * tenta buscar a versão nova, e só cai no cache se a rede demorar mais que
 * alguns segundos ou não houver conexão. O site continua funcionando offline —
 * apenas deixa de ficar preso a uma versão antiga.
 *
 * Trocar o nome dos caches (v1 → v2) também apaga, na ativação, a casca velha
 * que ficou guardada nos aparelhos.
 */

var VERSAO = 'v2';
var CACHE_CASCA = 'sinal-' + VERSAO + '-casca';
var CACHE_DADOS = 'sinal-' + VERSAO + '-dados';
var ATUAIS = [CACHE_CASCA, CACHE_DADOS];

// Quanto esperar pela rede antes de usar o que está guardado. Curto o bastante
// para não travar a abertura num sinal ruim de celular.
var ESPERA_REDE_MS = 4000;

var CASCA = [
  './',
  './index.html',
  './app.js',
  './styles.css',
  './manifest.webmanifest',
  './icones/icone-32.png',
  './icones/icone-180.png',
  './icones/icone-192.png',
  './icones/icone-512.png',
  './icones/icone-512-recortavel.png',
];

self.addEventListener('install', function (evento) {
  evento.waitUntil(
    caches.open(CACHE_CASCA)
      .then(function (cache) {
        // addAll falha inteiro se um único arquivo faltar; guardar um a um é
        // mais tolerante e não impede a instalação por causa de um ícone.
        return Promise.all(CASCA.map(function (url) {
          return cache.add(new Request(url, { cache: 'reload' })).catch(function () {});
        }));
      })
      .then(function () { return self.skipWaiting(); })
  );
});

self.addEventListener('activate', function (evento) {
  evento.waitUntil(
    caches.keys()
      .then(function (nomes) {
        return Promise.all(nomes.map(function (nome) {
          if (nome.indexOf('sinal-') === 0 && ATUAIS.indexOf(nome) === -1) {
            return caches.delete(nome);
          }
        }));
      })
      .then(function () { return self.clients.claim(); })
  );
});

function guardar(nomeDoCache, requisicao, resposta) {
  if (!resposta || !resposta.ok || resposta.type === 'opaque') return resposta;
  var copia = resposta.clone();
  caches.open(nomeDoCache).then(function (cache) {
    cache.put(requisicao, copia).catch(function () {});
  });
  return resposta;
}

// Rede primeiro, com prazo. Se a rede responder a tempo, ela vence e o cache é
// atualizado. Se demorar ou falhar, entrega o que está guardado.
function redePrimeiro(nomeDoCache, requisicao, prazo) {
  return new Promise(function (resolve) {
    var resolvido = false;
    function entregar(r) {
      if (resolvido || !r) return;
      resolvido = true;
      resolve(r);
    }

    var relogio = prazo ? setTimeout(function () {
      caches.match(requisicao).then(function (guardado) {
        if (guardado) entregar(guardado);
      });
    }, prazo) : null;

    fetch(requisicao)
      .then(function (resposta) {
        if (relogio) clearTimeout(relogio);
        guardar(nomeDoCache, requisicao, resposta.clone());
        entregar(resposta);
      })
      .catch(function () {
        if (relogio) clearTimeout(relogio);
        caches.match(requisicao).then(function (guardado) {
          if (guardado) { entregar(guardado); return; }
          // Sem rede e sem cópia guardada: numa navegação, devolve a casca.
          if (requisicao.mode === 'navigate') {
            caches.match('./index.html').then(function (casca) {
              entregar(casca || Response.error());
            });
            return;
          }
          entregar(Response.error());
        });
      });
  });
}

self.addEventListener('fetch', function (evento) {
  var requisicao = evento.request;
  if (requisicao.method !== 'GET') return;

  var url;
  try { url = new URL(requisicao.url); } catch (e) { return; }
  if (url.origin !== self.location.origin) return;

  // As edições do dia: rede primeiro, sem prazo curto, porque uma edição
  // desatualizada é pior do que uma espera de alguns segundos.
  if (url.pathname.indexOf('/data/') !== -1) {
    evento.respondWith(redePrimeiro(CACHE_DADOS, requisicao, 0));
    return;
  }

  evento.respondWith(redePrimeiro(CACHE_CASCA, requisicao, ESPERA_REDE_MS));
});

// Permite que a página peça a troca imediata depois de um deploy.
self.addEventListener('message', function (evento) {
  if (evento.data === 'assumir-agora') self.skipWaiting();
});
