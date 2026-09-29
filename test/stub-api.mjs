#!/usr/bin/env node
/**
 * Roda o enrich.mjs com a API da Anthropic simulada.
 *
 * Substitui o fetch global antes de importar o enrich, então nenhuma chamada
 * sai para a rede e o teste roda em qualquer lugar. Conta o que foi pedido e
 * denuncia, no fim, qualquer id traduzido mais de uma vez.
 */

const pedidos = [];      // todos os ids enviados para tradução
let chamadas = 0;

const real = globalThis.fetch;

globalThis.fetch = async (url, init = {}) => {
  const u = String(url);

  if (u.includes('/models')) {
    return resposta({
      data: [
        { id: 'claude-haiku-4-5-20251001' },
        { id: 'claude-sonnet-4-5-20250929' },
      ],
    });
  }

  if (u.includes('/messages')) {
    chamadas++;
    const body = JSON.parse(init.body);
    const system = body.system || '';

    if (system.includes('tradutor')) {
      const entrada = JSON.parse(body.messages[0].content);
      for (const e of entrada) pedidos.push(e.id);
      return resposta({
        content: [{
          type: 'text',
          text: JSON.stringify(entrada.map((e) => ({
            id: e.id,
            t: '[pt] ' + e.t,
            s: e.s ? '[pt] ' + e.s : '',
          }))),
        }],
        usage: { input_tokens: 100, output_tokens: 100 },
      });
    }

    // análise do dia
    return resposta({
      content: [{
        type: 'text',
        text: JSON.stringify({
          headline: 'Dia de teste',
          lede: 'Resumo simulado para o teste automatizado.',
          blocks: [{ title: 'Bloco', body: 'Corpo do bloco.', ids: [] }],
          connections: ['uma conexão'],
          watchlist: ['algo a acompanhar'],
        }),
      }],
      usage: { input_tokens: 100, output_tokens: 100 },
    });
  }

  return real(url, init);
};

function resposta(obj) {
  return {
    ok: true,
    status: 200,
    json: async () => obj,
  };
}

if (process.env.SEM_CHAVE) delete process.env.ANTHROPIC_API_KEY;

process.on('exit', () => {
  const vistos = new Set();
  const repetidos = pedidos.filter((id) => vistos.has(id) || (vistos.add(id), false));
  if (repetidos.length) {
    console.log(`__REPETIDA__ ${[...new Set(repetidos)].join(' ')}`);
  }
  console.log(`__CHAMADAS__ ${chamadas} __ITENS__ ${pedidos.length}`);
});

await import('../collector/enrich.mjs');
