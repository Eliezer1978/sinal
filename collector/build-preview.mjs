#!/usr/bin/env node
/**
 * Monta uma prévia de arquivo único (HTML + CSS + JS + dados embutidos).
 *
 * Serve para olhar e mexer na interface antes do primeiro deploy, sem
 * depender de rede. As manchetes daqui são INVENTADAS — a prévia avisa
 * isso na tela o tempo todo, e nenhum link leva a lugar nenhum.
 */

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const SITE = join(ROOT, 'site');

const H = 3600000;
const now = Date.now();

/* Manchetes fictícias, escritas para exercitar os 12 temas, os dois idiomas,
   o agrupamento por cobertura, paywall e resumo longo. */
const DEMO = [
  { s: 'reuters', h: 1.5, t: 'Banco central americano mantém juros e sinaliza cautela com a inflação de serviços',
    o: 'Federal Reserve holds rates, flags caution on services inflation',
    d: 'O comitê votou por unanimidade pela manutenção da taxa básica. No comunicado, os dirigentes disseram que a inflação de serviços segue resistente e que não há pressa para cortar juros.',
    tp: ['economia-mercados', 'geopolitica'],
    also: [['bloomberg', 'Fed keeps rates on hold as officials preach patience'], ['ft-home', 'Fed holds rates steady, citing sticky services inflation'], ['valor', 'Fed mantém juros e mercado brasileiro reage'], ['wsj-markets', 'Federal Reserve leaves rates unchanged']] },

  { s: 'hbr', h: 3, t: 'O que separa equipes de alta performance não é talento individual, mostra estudo',
    o: 'What separates high-performing teams isn’t individual talent',
    d: 'Pesquisa com 1.200 equipes em sete países aponta que segurança psicológica e prática deliberada explicam mais variação no desempenho do que a soma dos talentos individuais. Times que erravam em público melhoravam mais rápido.',
    tp: ['performance-humana', 'lideranca-gestao'], pay: true },

  { s: 'ft-home', h: 2, t: 'Empresas europeias recuam de metas públicas de diversidade diante de risco jurídico',
    o: 'European companies retreat from public diversity targets',
    d: 'Ao menos 40 companhias do índice Stoxx 600 removeram metas numéricas de diversidade de seus relatórios anuais. Consultores dizem que os programas continuam internamente, mas sem divulgação.',
    tp: ['dei-equidade', 'negocios-inovacao'], pay: true,
    also: [['economist-latest', 'The quiet retreat from corporate diversity targets'], ['fortune', 'Companies drop DEI language but keep the programs']] },

  { s: 'mitsmr', h: 4, t: 'Programas de requalificação só funcionam quando abrem porta para mobilidade interna',
    o: 'Reskilling only works when it opens a real internal door',
    d: 'Análise de 60 programas corporativos de requalificação mostra que catálogos de cursos têm conclusão média de 12%. Quando o programa é atrelado a vagas internas reais, a conclusão sobe para 68%.',
    tp: ['educacao-aprendizagem', 'futuro-trabalho', 'performance-humana'], pay: true },

  { s: 'guardian-env', h: 2.5, t: 'Negociações sobre mercado global de carbono travam a semanas da COP',
    o: 'Global carbon market talks stall weeks before COP',
    d: 'Delegações de mais de 90 países não chegaram a acordo sobre regras de contabilidade de créditos. A disputa central é sobre como evitar dupla contagem entre países compradores e vendedores.',
    tp: ['esg-clima', 'geopolitica'],
    also: [['reuters', 'Carbon market negotiations hit impasse'], ['spiegel', 'Kohlenstoffmarkt: Verhandlungen festgefahren']] },

  { s: 'mittr', h: 5, t: 'Modelos de IA começam a ser auditados sob as novas regras europeias',
    o: 'AI models face first audits under Europe’s new rules',
    d: 'As primeiras auditorias obrigatórias de modelos de uso geral começaram nesta semana. Empresas precisam documentar dados de treino, avaliações de risco e medidas de mitigação.',
    tp: ['ia-tecnologia', 'geopolitica'], pay: true },

  { s: 'bersin', h: 7, t: 'Orçamentos de desenvolvimento de lideranças resistem ao corte, aponta levantamento',
    o: 'Leadership development budgets are surviving the cuts',
    d: 'Pesquisa com 900 diretores de aprendizagem mostra orçamentos estáveis ou em alta para desenvolvimento de líderes, mesmo em empresas que cortaram outras áreas de RH.',
    tp: ['lideranca-gestao', 'educacao-aprendizagem'] },

  { s: 'g1-politica', h: 1, t: 'Relator apresenta texto da reforma administrativa e prevê votação no mês que vem',
    d: 'A proposta muda regras de estabilidade e avaliação de desempenho no funcionalismo. Centrais sindicais anunciaram mobilização; o governo evitou se posicionar sobre o mérito.',
    tp: ['brasil-politica'], pt: true,
    also: [['folha-poder', 'Relator entrega parecer da reforma administrativa'], ['uol', 'Reforma administrativa: relatório prevê avaliação de desempenho']] },

  { s: 'econ-business', h: 6, t: 'A economia do gestor intermediário: por que essa camada está queimando',
    o: 'The middle manager squeeze',
    d: 'Gestores de nível médio relatam o maior índice de esgotamento de toda a hierarquia. Presos entre metas da diretoria e expectativas das equipes sobre trabalho híbrido, muitos pedem para voltar a ser especialistas.',
    tp: ['lideranca-gestao', 'futuro-trabalho', 'performance-humana'], pay: true },

  { s: 'valor', h: 3.5, t: 'Copom mantém a Selic e comunicado reforça tom cauteloso',
    d: 'A decisão veio em linha com as projeções do mercado. O comunicado retirou a referência a cortes futuros e destacou a resiliência do mercado de trabalho como fator de atenção.',
    tp: ['economia-mercados', 'brasil-politica'], pt: true, pay: true,
    also: [['infomoney', 'Copom mantém Selic; veja a reação do mercado'], ['estadao-eco', 'BC mantém juros e sinaliza cautela']] },

  { s: 'nyt-tech', h: 8, t: 'Corrida por data centers pressiona redes elétricas e reabre debate sobre energia',
    o: 'The data center boom is straining power grids',
    d: 'A demanda de energia para treinar e operar modelos de IA levou concessionárias a adiar o fechamento de usinas térmicas. Reguladores discutem quem paga a conta da expansão.',
    tp: ['ia-tecnologia', 'esg-clima', 'economia-mercados'], pay: true },

  { s: 'wef', h: 11, t: 'Relatório aponta que metade dos trabalhadores precisará de requalificação até 2030',
    o: 'Half of workers will need reskilling by 2030, report says',
    d: 'O levantamento com 1.000 empregadores estima que 39% das habilidades atuais ficarão obsoletas. Pensamento analítico e resiliência aparecem no topo das competências mais buscadas.',
    tp: ['futuro-trabalho', 'educacao-aprendizagem', 'dei-equidade'] },

  { s: 'restofworld', h: 9, t: 'Como escolas do Sudeste Asiático estão usando IA sem conexão estável',
    o: 'How Southeast Asian schools use AI without reliable internet',
    d: 'Modelos pequenos rodando em aparelhos baratos permitem tutoria em regiões sem banda larga. Professores relatam ganho de tempo, e pesquisadores alertam para a falta de avaliação de aprendizagem.',
    tp: ['ia-tecnologia', 'educacao-aprendizagem'] },

  { s: 'atlantic', h: 20, t: 'A solidão do trabalho remoto e o que ela custa',
    o: 'The loneliness of remote work',
    d: 'Ensaio sobre como o trabalho remoto reorganizou amizades, pertencimento e a textura da vida profissional, apoiado em sociologia e memória pessoal.',
    tp: ['cultura-comportamento', 'futuro-trabalho', 'performance-humana'], pay: true },

  { s: 'mckinsey', h: 13, t: 'Empresas que ligam aprendizagem a mobilidade retêm o dobro de talentos',
    o: 'Firms linking learning to mobility retain twice as many people',
    d: 'Análise de dados de 300 companhias indica que a retenção dobra quando a trilha de aprendizagem está formalmente ligada a movimentações internas.',
    tp: ['educacao-aprendizagem', 'futuro-trabalho', 'lideranca-gestao'] },

  { s: 'foreignaffairs', h: 14, t: 'A nova geografia das cadeias de suprimento',
    o: 'The new geography of supply chains',
    d: 'Ensaio argumenta que a realocação produtiva em curso é menos sobre trazer fábricas de volta e mais sobre diversificar rotas, com efeitos duradouros sobre alianças políticas.',
    tp: ['geopolitica', 'negocios-inovacao'], pay: true },

  { s: 'exame', h: 5.5, t: 'Investimento em educação corporativa cresce 18% no Brasil, diz pesquisa',
    d: 'Levantamento com 300 companhias mostra crescimento concentrado em capacitação de lideranças e habilidades socioemocionais. Empresas de serviços lideram a expansão.',
    tp: ['educacao-aprendizagem', 'lideranca-gestao', 'brasil-politica'], pt: true, pay: true },

  { s: 'hrdive', h: 10, t: 'Semana de quatro dias: novo teste mostra produtividade estável e menos esgotamento',
    o: 'Four-day week trial: steady productivity, less burnout',
    d: 'Entre 61 empresas que testaram a jornada reduzida, 54 mantiveram o formato após o piloto. Indicadores de receita ficaram estáveis e o afastamento por saúde mental caiu 39%.',
    tp: ['futuro-trabalho', 'performance-humana'] },

  { s: 'guardian-world', h: 4.5, t: 'Cúpula sobre migração termina sem acordo de repartição entre países europeus',
    o: 'Migration summit ends without a burden-sharing deal',
    d: 'Os países do sul da Europa pediam distribuição obrigatória de solicitantes de asilo. O texto final ficou em compromissos voluntários e mecanismos de financiamento.',
    tp: ['geopolitica', 'cultura-comportamento'] },

  { s: 'nexo', h: 16, t: 'O que muda na avaliação de desempenho quando a IA entra no processo',
    d: 'Reportagem examina empresas que passaram a usar modelos para sintetizar feedback. Especialistas em trabalho apontam risco de reforço de vieses e de perda do vínculo entre avaliação e conversa.',
    tp: ['performance-humana', 'ia-tecnologia', 'dei-equidade'], pt: true, pay: true },

  { s: 'econ-finance', h: 12, t: 'Mercados emergentes atraem fluxo recorde com juros altos e câmbio estável',
    o: 'Emerging markets draw record inflows',
    d: 'O diferencial de juros e a estabilidade cambial levaram fundos globais a ampliar posições. Analistas alertam que o movimento é sensível a qualquer reversão na política monetária americana.',
    tp: ['economia-mercados', 'geopolitica'], pay: true },

  { s: 'fastcompany', h: 18, t: 'As empresas que trocaram o organograma por redes de projeto',
    o: 'Companies replacing the org chart with project networks',
    d: 'Reportagem acompanha três organizações que dissolveram níveis hierárquicos em favor de times temporários. Ganhos de velocidade vieram com atrito na avaliação de carreira.',
    tp: ['lideranca-gestao', 'futuro-trabalho', 'negocios-inovacao'] },

  { s: 'noema', h: 26, t: 'Quem decide o que a máquina considera mérito',
    o: 'Who decides what the machine counts as merit',
    d: 'Ensaio sobre como sistemas de triagem automatizada codificam noções de mérito, e o que isso significa para equidade em processos seletivos e promoções.',
    tp: ['dei-equidade', 'ia-tecnologia', 'cultura-comportamento'] },

  { s: 'bbc-business', h: 7.5, t: 'Fusão de dois grupos de logística cria operador continental',
    o: 'Logistics merger creates continent-wide operator',
    d: 'A aquisição une duas empresas de porte médio e será analisada por autoridades de concorrência em três jurisdições.',
    tp: ['negocios-inovacao', 'economia-mercados'] },

  { s: 'oecd', h: 22, t: 'Relatório da OCDE mostra queda no desempenho de leitura entre adolescentes',
    o: 'OECD report shows falling reading performance among teens',
    d: 'A queda aparece na maioria dos países avaliados e é mais acentuada entre estudantes de menor renda. O relatório associa parte do resultado ao tempo de tela não estruturado.',
    tp: ['educacao-aprendizagem', 'dei-equidade'] },

  { s: 'piaui', h: 30, t: 'A engrenagem invisível dos cursos de liderança',
    d: 'Perfil de um mercado que movimenta bilhões e quase não é avaliado. A reportagem acompanha turmas, entrevista participantes um ano depois e procura evidência de efeito.',
    tp: ['lideranca-gestao', 'educacao-aprendizagem', 'cultura-comportamento'], pt: true },

  { s: 'wsj-management', h: 15, t: 'Executivos voltam a exigir presença, e a negociação migra para o nível do time',
    o: 'Executives push for office presence; teams negotiate locally',
    d: 'Grandes empregadores endureceram políticas de presença, mas a aplicação ficou a cargo de gestores diretos, criando regras diferentes dentro da mesma empresa.',
    tp: ['futuro-trabalho', 'lideranca-gestao'], pay: true },

  { s: 'aeon', h: 34, t: 'O hábito como arquitetura: por que a força de vontade explica tão pouco',
    o: 'Habit as architecture: why willpower explains so little',
    d: 'Ensaio reúne pesquisa em ciência comportamental para argumentar que ambientes, e não disposição individual, determinam a maior parte da mudança de comportamento sustentada.',
    tp: ['performance-humana', 'cultura-comportamento'] },

  { s: 'politico-eu', h: 9.5, t: 'Bruxelas prepara revisão das regras de relatório de sustentabilidade',
    o: 'Brussels prepares to revise sustainability reporting rules',
    d: 'A proposta reduziria o número de empresas obrigadas a reportar e simplificaria indicadores. Investidores institucionais reagiram pedindo manutenção da comparabilidade.',
    tp: ['esg-clima', 'geopolitica', 'negocios-inovacao'] },

  { s: 'lemonde', h: 17, t: 'França debate cotas de gênero nos conselhos das empresas de médio porte',
    o: 'France debates gender quotas for mid-size company boards',
    d: 'A extensão da lei atingiria cerca de 6 mil companhias. Federações patronais pedem prazo mais longo; pesquisadoras citam ganho de desempenho em conselhos mais diversos.',
    tp: ['dei-equidade', 'lideranca-gestao'], pay: true },
];

const BRIEFING = {
  headline: 'Juros parados lá fora, requalificação em pauta aqui dentro',
  lede: 'O dia foi de política monetária sem novidade e de trabalho em transformação. O Fed e o Copom mantiveram juros, o que tira pressão do câmbio mas adia decisões de investimento. Em paralelo, três levantamentos independentes chegaram à mesma conclusão sobre requalificação — e ela contraria como a maioria das empresas faz.',
  blocks: [
    { title: 'Juros parados dos dois lados', ids: ['i0', 'i9'],
      body: 'Fed e Copom mantiveram as taxas e ambos retiraram do comunicado qualquer sinalização de corte. Para quem vende projetos de longo prazo, isso significa mais um trimestre de orçamento aprovado com cautela e ciclo de decisão esticado.' },
    { title: 'Requalificação: o consenso mudou', ids: ['i3', 'i11', 'i14'],
      body: 'MIT Sloan, McKinsey e o Fórum Econômico Mundial publicaram na mesma semana achados convergentes: catálogo de cursos não funciona. O que muda o resultado é amarrar a trilha de aprendizagem a vaga interna real — a conclusão sai de 12% para 68%, e a retenção dobra. É um argumento de venda melhor do que qualquer discurso sobre cultura de aprendizagem.' },
    { title: 'DEI sai do relatório, não da empresa', ids: ['i2', 'i29'],
      body: 'Quarenta companhias europeias tiraram metas numéricas de diversidade dos relatórios anuais por receio jurídico, enquanto a França discute ampliar cotas de gênero em conselhos. Os programas seguem existindo; o que sumiu foi a divulgação. Quem trabalha com o tema precisa se preparar para clientes que querem o trabalho sem o rótulo.' },
    { title: 'A conta energética da IA', ids: ['i10', 'i5'],
      body: 'A expansão de data centers está adiando o fechamento de térmicas e reabrindo a discussão sobre quem paga a infraestrutura. Ao mesmo tempo, as primeiras auditorias obrigatórias de modelos começaram na Europa. IA deixou de ser pauta de tecnologia e virou pauta de energia e de conformidade.' },
    { title: 'Gestor do meio, ponto de ruptura', ids: ['i8', 'i26'],
      body: 'Duas reportagens tratam da mesma fratura: a diretoria endureceu regras de presença, mas delegou a aplicação ao gestor direto. O resultado é regra diferente em cada time e a camada intermediária absorvendo o conflito. É onde o esgotamento aparece primeiro.' },
  ],
  connections: [
    'A retração pública em DEI e a alta de investimento em educação corporativa no Brasil apontam para o mesmo movimento: o tema sobrevive quando entra como desenvolvimento, e recua quando entra como meta divulgada.',
    'Juros parados prolongam o ciclo de aprovação de orçamento, e é justamente aí que programas de requalificação atrelados a vaga interna se defendem melhor do que catálogo de curso.',
  ],
  watchlist: [
    'A revisão das regras europeias de relatório de sustentabilidade deve sair nas próximas semanas e muda o que empresas com operação na Europa precisam medir.',
    'Se a queda de leitura da OCDE se confirmar nos dados nacionais, muda a base de quem chega ao primeiro emprego nos próximos cinco anos.',
  ],
};

// fontes que "falharam" na coleta, para mostrar como o painel de saúde se comporta
const DOWN = { bloomberg: 'HTTP 403', 'wsj-tech': 'tempo esgotado (20000ms)', ilo: 'resposta vazia' };

async function main() {
  const registry = JSON.parse(await readFile(join(__dirname, 'feeds.json'), 'utf8'));
  const taxonomy = JSON.parse(await readFile(join(__dirname, 'topics.json'), 'utf8'));
  const byId = new Map(registry.sources.map((s) => [s.id, s]));

  const items = DEMO.map((d, i) => {
    const src = byId.get(d.s) || { name: d.s, weight: 0.8, paywall: false };
    const item = {
      id: 'i' + i,
      title: d.pt ? d.t : (d.o || d.t),
      summary: d.d,
      url: '#',
      ts: now - d.h * H,
      hasDate: true,
      sourceId: d.s,
      topics: d.tp,
      score: Number((0.95 - i * 0.021 + (d.also ? 0.05 : 0)).toFixed(4)),
      clusterSize: 1 + (d.also ? d.also.length : 0),
    };
    if (!d.pt) item.title_pt = d.t;
    if (!d.pt) item.summary_pt = d.d;
    if (d.also) {
      item.alsoIn = d.also.map(([sid, title]) => ({
        source: (byId.get(sid) || {}).name || sid, sourceId: sid, url: '#', title,
      }));
    }
    return item;
  });

  const data = {
    generatedAt: new Date(now).toISOString(),
    windowHours: 48,
    aiEnabled: true,
    demo: true,
    briefing: BRIEFING,
    stats: {
      sourcesTotal: registry.sources.length,
      sourcesOk: registry.sources.length - Object.keys(DOWN).length,
      sourcesFailed: Object.keys(DOWN).length,
      rawItems: 1184, publishedItems: items.length, clusters: items.length, durationMs: 41200,
    },
    topics: taxonomy.topics.map((t) => ({
      id: t.id, label: t.label, short: t.short, description: t.description,
      count: items.filter((i) => i.topics.includes(t.id)).length,
    })),
    groups: registry.groups,
    sources: registry.sources.map((s) => ({
      id: s.id, name: s.name, group: s.group, section: s.section || '',
      lang: s.lang, site: s.site, paywall: !!s.paywall,
      ok: !DOWN[s.id], error: DOWN[s.id] || null,
      count: items.filter((i) => i.sourceId === s.id).length,
    })),
    items,
    ai: { translatedCount: items.filter((i) => i.title_pt).length, models: { translate: 'modelo rápido', briefing: 'modelo de análise' }, usage: {}, ranAt: new Date(now).toISOString() },
  };

  const [html, css, js] = await Promise.all([
    readFile(join(SITE, 'index.html'), 'utf8'),
    readFile(join(SITE, 'styles.css'), 'utf8'),
    readFile(join(SITE, 'app.js'), 'utf8'),
  ]);

  // Aviso no topo. Não é fixo: a barra de cima repete "PRÉVIA, manchetes
  // fictícias" e essa sim acompanha a rolagem, sem cobrir a gaveta no celular.
  const banner =
    '<div style="background:#7d6113;color:#fff;' +
    'font:500 12.5px/1.5 \'IBM Plex Sans\',system-ui,sans-serif;padding:11px 24px;text-align:center">' +
    'PRÉVIA DE INTERFACE — as manchetes desta página são <b>fictícias</b>, escritas só para demonstrar o layout. ' +
    'Nenhum link leva a lugar nenhum. O site real busca notícias reais nos feeds oficiais de cada veículo.</div>';

  // corpo sem as tags de documento, para o publicador embrulhar
  const body = html
    .slice(html.indexOf('<body>') + 6, html.indexOf('</body>'))
    .replace('<script src="app.js"></script>', '')
    .replace(/^\s*<a class="skip-link"[\s\S]*?<\/a>\s*/m, '');

  const fontLink = (html.match(/<link href="https:\/\/fonts\.googleapis[^>]*>/) || [''])[0];

  const out =
    '<title>Sinal</title>\n' + fontLink + '\n' +
    '<style>\n' + css + '\n</style>\n' +
    banner + '\n' + body + '\n' +
    '<script>window.__SINAL_DATA__ = ' + JSON.stringify(data) + ';</script>\n' +
    '<script>\n' + js + '\n</script>\n';

  await mkdir(join(ROOT, 'preview'), { recursive: true });
  await writeFile(join(ROOT, 'preview', 'sinal-previa.html'), out, 'utf8');

  // versão completa, para abrir direto no navegador
  await writeFile(join(ROOT, 'preview', 'standalone.html'),
    '<!doctype html>\n<html lang="pt-BR">\n<head>\n<meta charset="utf-8">\n' +
    '<meta name="viewport" content="width=device-width, initial-scale=1">\n' +
    '<meta name="color-scheme" content="light dark">\n' + out + '\n</html>', 'utf8');

  console.log(`prévia gerada: ${items.length} matérias fictícias, ${data.stats.sourcesTotal} fontes`);
  console.log(`  preview/sinal-previa.html  (para publicar)`);
  console.log(`  preview/standalone.html    (para abrir no navegador)`);
}

main().catch((e) => { console.error(e); process.exit(1); });
