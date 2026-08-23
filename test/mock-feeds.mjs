#!/usr/bin/env node
/**
 * Servidor de feeds falsos.
 *
 * Como o ambiente onde o projeto foi construído não alcança sites de notícia,
 * este servidor recria as condições reais: RSS 2.0, Atom, RDF, CDATA, HTML no
 * resumo, datas em formatos diferentes, matérias repetidas entre veículos,
 * item sem data, item velho demais e um feed que devolve erro.
 *
 * Serve para provar que o coletor aguenta o mundo real antes do primeiro deploy.
 */

import { createServer } from 'node:http';

const now = Date.now();
const H = 3600000;
const rfc = (ms) => new Date(ms).toUTCString();
const iso = (ms) => new Date(ms).toISOString();

/* Um mesmo fato coberto por cinco veículos — o agrupador tem de juntar. */
const FED = [
  'Federal Reserve holds interest rates steady as inflation cools',
  'Fed holds interest rates steady amid cooling inflation',
  'Federal Reserve keeps rates unchanged as inflation continues to cool',
  'Fed mantém juros estáveis com inflação em desaceleração',
  'Federal Reserve leaves interest rates untouched, citing cooling inflation',
];

/* Outro fato repetido, para testar agrupamento em português. */
const COPOM = [
  'Copom mantém Selic em patamar elevado e sinaliza cautela',
  'Banco Central mantém a Selic e sinaliza cautela à frente',
];

const rss = (title, items) => `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:media="http://search.yahoo.com/mrss/" xmlns:dc="http://purl.org/dc/elements/1.1/">
<channel><title>${title}</title><link>https://exemplo.test</link><description>feed de teste</description>
${items.map((i) => `<item>
  <title><![CDATA[${i.t}]]></title>
  <link>${i.u}</link>
  <description><![CDATA[<p>${i.d}</p><img src="https://exemplo.test/img/${i.id}.jpg">]]></description>
  ${i.ts ? `<pubDate>${rfc(i.ts)}</pubDate>` : ''}
  <guid isPermaLink="false">${i.id}</guid>
  ${i.img ? `<media:content url="${i.img}" type="image/jpeg"/>` : ''}
</item>`).join('\n')}
</channel></rss>`;

const atom = (title, items) => `<?xml version="1.0" encoding="utf-8"?>
<feed xmlns="http://www.w3.org/2005/Atom"><title>${title}</title>
${items.map((i) => `<entry>
  <title>${i.t.replace(/&/g, '&amp;')}</title>
  <link rel="alternate" href="${i.u}"/>
  <id>${i.id}</id>
  <published>${iso(i.ts)}</published>
  <summary type="html">&lt;p&gt;${i.d}&lt;/p&gt;</summary>
</entry>`).join('\n')}
</feed>`;

const rdf = (title, items) => `<?xml version="1.0"?>
<rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#" xmlns="http://purl.org/rss/1.0/" xmlns:dc="http://purl.org/dc/elements/1.1/">
<channel rdf:about="https://exemplo.test"><title>${title}</title></channel>
${items.map((i) => `<item rdf:about="${i.u}">
  <title>${i.t}</title><link>${i.u}</link>
  <description>${i.d}</description><dc:date>${iso(i.ts)}</dc:date>
</item>`).join('\n')}
</rdf:RDF>`;

const FEEDS = {
  '/agencia.xml': () => rss('Agência Teste', [
    { id: 'a1', t: FED[0], u: 'https://exemplo.test/fed-1?utm_source=rss&utm_medium=feed', ts: now - 3 * H,
      d: 'The US central bank left its benchmark rate unchanged, saying inflation has cooled but remains above target. Officials signalled patience on future cuts.' },
    { id: 'a2', t: 'Global leaders gather for climate finance summit as carbon market talks stall', u: 'https://exemplo.test/climate-1', ts: now - 5 * H,
      d: 'Negotiators from more than 90 countries met to discuss climate finance and the future of the international carbon market ahead of COP.' },
    { id: 'a3', t: 'AI regulation advances in Europe as companies scramble to comply', u: 'https://exemplo.test/ai-eu', ts: now - 8 * H,
      d: 'The European Union moved ahead with enforcement of its artificial intelligence rules, forcing large technology companies to audit their models.' },
    { id: 'a4', t: 'Item sem data nenhuma para testar o fallback', u: 'https://exemplo.test/nodate', ts: null,
      d: 'Este item não traz pubDate. O coletor deve assumir a hora da coleta e não descartar.' },
    { id: 'a5', t: 'Notícia velha que deve ficar de fora da janela', u: 'https://exemplo.test/velha', ts: now - 200 * H,
      d: 'Publicada há mais de oito dias, precisa ser descartada pelo corte de janela.' },
  ]),

  '/diario.xml': () => rss('Diário Teste', [
    { id: 'b1', t: FED[1], u: 'https://exemplo.test/fed-2', ts: now - 2.5 * H,
      d: 'Policymakers voted unanimously to keep rates on hold. The decision was widely expected by investors on Wall Street.' },
    { id: 'b2', t: 'Four-day week trial shows productivity gains, researchers say', u: 'https://exemplo.test/4day', ts: now - 6 * H,
      d: 'A large trial of the four-day week found that productivity held steady or improved while burnout fell sharply among employees.' },
    { id: 'b3', t: 'Companies quietly retreat from diversity equity and inclusion targets', u: 'https://exemplo.test/dei-retreat', ts: now - 9 * H,
      d: 'Several large employers have dropped public diversity and inclusion goals, citing legal risk. Advocates warn of a chilling effect on racial equity work.' },
    { id: 'b4', t: 'Leadership development budgets survive the cuts, survey finds', u: 'https://exemplo.test/leader-budget', ts: now - 14 * H,
      d: 'Corporate learning and leadership development spending proved resilient, with chief learning officers reporting flat or rising budgets.' },
  ]),

  '/negocios.atom': () => atom('Negócios Teste', [
    { id: 'c1', t: FED[2], u: 'https://exemplo.test/fed-3', ts: now - 2 * H,
      d: 'The central bank held rates, pointing to a labour market that is cooling without cracking.' },
    { id: 'c2', t: 'Chipmaker announces $12bn data centre expansion to meet AI demand', u: 'https://exemplo.test/chips', ts: now - 4 * H,
      d: 'The semiconductor group said it would build new data centre capacity, betting that demand for artificial intelligence compute keeps climbing.' },
    { id: 'c3', t: 'Merger of two logistics groups creates continent-wide supply chain player', u: 'https://exemplo.test/merger', ts: now - 11 * H,
      d: 'The acquisition combines two mid-size logistics companies and will be reviewed by antitrust regulators.' },
  ]),

  '/gestao.xml': () => rss('Gestão Teste', [
    { id: 'd1', t: 'What high performing teams do differently, according to new research', u: 'https://exemplo.test/teams', ts: now - 7 * H,
      d: 'A study of team performance found that psychological safety and deliberate practice explained more variance than individual talent.' },
    { id: 'd2', t: 'The manager squeeze: why middle managers are burning out', u: 'https://exemplo.test/middle', ts: now - 16 * H,
      d: 'Middle managers report the highest burnout of any level, caught between executive demands and employee expectations about hybrid work.' },
    { id: 'd3', t: 'Reskilling at scale: what actually works in corporate learning', u: 'https://exemplo.test/reskill', ts: now - 20 * H,
      d: 'Companies that tied upskilling programmes to real internal mobility saw far better completion than those offering course catalogues alone.' },
  ]),

  '/brasil.xml': () => rss('Brasil Teste', [
    { id: 'e1', t: COPOM[0], u: 'https://exemplo.test/copom-1', ts: now - 3.5 * H,
      d: 'O Comitê de Política Monetária do Banco Central manteve a taxa Selic e afirmou que seguirá vigilante diante da inflação de serviços.' },
    { id: 'e2', t: 'Congresso avança em relatório da reforma administrativa', u: 'https://exemplo.test/reforma', ts: now - 6.5 * H,
      d: 'O relator apresentou o texto na Câmara dos Deputados. A proposta muda regras de carreira do funcionalismo e enfrenta resistência de servidores.' },
    { id: 'e3', t: 'Empresas brasileiras ampliam programas de educação corporativa, aponta levantamento', u: 'https://exemplo.test/edu-corp', ts: now - 13 * H,
      d: 'Pesquisa com 300 companhias mostra crescimento no investimento em treinamento e capacitação de lideranças, com foco em habilidades socioemocionais.' },
    { id: 'e4', t: FED[3], u: 'https://exemplo.test/fed-br', ts: now - 2.8 * H,
      d: 'A decisão do Federal Reserve foi acompanhada de perto por investidores brasileiros, com impacto sobre o câmbio e a bolsa de valores.' },
  ]),

  '/mercado.rdf': () => rdf('Mercado Teste', [
    { id: 'f1', t: COPOM[1], u: 'https://exemplo.test/copom-2', ts: now - 3.2 * H,
      d: 'A autoridade monetária manteve os juros e o comunicado indicou cautela, segundo analistas de mercado ouvidos pela reportagem.' },
    { id: 'f2', t: 'Ibovespa fecha em alta com exterior favorável e commodities', u: 'https://exemplo.test/ibov', ts: now - 5.5 * H,
      d: 'O índice acompanhou o exterior. O dólar recuou frente ao real após a decisão de política monetária nos Estados Unidos.' },
  ]),

  '/ensaio.xml': () => rss('Ensaio Teste', [
    { id: 'g1', t: 'The loneliness of the remote worker, and what it costs us', u: 'https://exemplo.test/lonely', ts: now - 25 * H,
      d: 'An essay on how remote work reshaped friendship, belonging and the texture of professional life, drawing on sociology and memoir.' },
    { id: 'g2', t: FED[4], u: 'https://exemplo.test/fed-5', ts: now - 2.2 * H,
      d: 'Rates were left untouched, an outcome that markets had priced in with near certainty.' },
  ]),

  // feed que morre, para provar que uma fonte quebrada não derruba a coleta
  '/quebrado.xml': () => { throw new Error('500'); },
  // XML inválido, mesmo motivo
  '/lixo.xml': () => '<rss><channel><item><title>sem fechar',
};

export function startMockServer(port = 0) {
  return new Promise((resolve) => {
    const server = createServer((req, res) => {
      const path = req.url.split('?')[0];
      const make = FEEDS[path];
      if (!make) { res.writeHead(404); res.end('não encontrado'); return; }
      try {
        const body = make();
        res.writeHead(200, { 'content-type': 'application/rss+xml; charset=utf-8' });
        res.end(body);
      } catch {
        res.writeHead(500); res.end('erro do servidor');
      }
    });
    server.listen(port, '127.0.0.1', () => resolve({ server, port: server.address().port }));
  });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const { port } = await startMockServer(8099);
  console.log(`feeds falsos em http://127.0.0.1:${port}/`);
}
