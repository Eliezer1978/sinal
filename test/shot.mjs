#!/usr/bin/env node
/** Abre a prévia num Chromium de verdade, exercita a interface e captura telas. */

import { chromium } from 'playwright';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdir } from 'node:fs/promises';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const FILE = 'file://' + join(ROOT, 'preview', 'standalone.html');
const OUT = join(ROOT, 'preview', 'shots');
await mkdir(OUT, { recursive: true });

const browser = await chromium.launch({
  executablePath: process.env.CHROME_PATH || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  args: ['--no-sandbox', '--font-render-hinting=none'],
});

const problemas = [];
// numa prévia aberta como arquivo local, fontes externas e o acervo não existem
const ignorar = /ERR_TUNNEL|ERR_NAME_NOT_RESOLVED|ERR_INTERNET_DISCONNECTED|ERR_FAILED|CORS policy|fonts\.(googleapis|gstatic)/;

async function novaPagina(rotulo, { width, height, theme }) {
  const ctx = await browser.newContext({
    viewport: { width, height }, colorScheme: theme || 'light', deviceScaleFactor: 2,
  });
  const page = await ctx.newPage();
  page.on('console', (m) => {
    if (m.type() === 'error' && !ignorar.test(m.text())) problemas.push(`[${rotulo}] console: ${m.text()}`);
  });
  page.on('pageerror', (e) => problemas.push(`[${rotulo}] erro de página: ${e.message}`));
  await page.goto(FILE, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('.art', { timeout: 8000 });
  await page.waitForTimeout(400);
  return { ctx, page };
}

async function shot(nome, opts) {
  const { ctx, page } = await novaPagina(nome, opts);
  if (opts.acoes) await opts.acoes(page);
  await page.screenshot({ path: join(OUT, nome + '.png') });
  const excesso = await page.evaluate(() =>
    document.documentElement.scrollWidth - document.documentElement.clientWidth);
  if (excesso > 2) problemas.push(`[${nome}] a página rola para o lado (${excesso}px a mais)`);
  await ctx.close();
}

// ---------------------------------------------------------------- telas

await shot('01-claro', { width: 1400, height: 1000, theme: 'light' });
await shot('02-escuro', { width: 1400, height: 1000, theme: 'dark' });
await shot('03-curadoria-ia', {
  width: 1400, height: 1100,
  acoes: async (p) => { await p.click('#btn-ai'); await p.waitForTimeout(400); },
});
await shot('04-acoes-na-materia', {
  width: 1400, height: 900,
  acoes: async (p) => {
    await p.locator('.art').first().hover();
    await p.locator('.art').first().locator('[data-descartar]').click();
    await p.waitForTimeout(300);
  },
});
await shot('05-favoritas', {
  width: 1400, height: 900,
  acoes: async (p) => {
    for (const i of [0, 2, 4]) await p.locator('.art').nth(i).locator('[data-fav]').click();
    await p.click('.vista-btn[data-vista="favoritos"]');
    await p.waitForTimeout(400);
  },
});
await shot('06-aprendizado', {
  width: 1400, height: 1000, theme: 'dark',
  acoes: async (p) => {
    await p.locator('.art').first().locator('[data-descartar]').click();
    await p.click('[data-motivo="local-factual"]');
    await p.waitForTimeout(200);
    await p.locator('.art').first().locator('[data-descartar]').click();
    await p.click('[data-motivo="fora-do-tema"]');
    await p.waitForTimeout(400);
    await p.evaluate(() => { document.querySelector('.sidebar-scroll').scrollTop = 900; });
    await p.waitForTimeout(300);
  },
});
await shot('07-celular', { width: 390, height: 844 });
await shot('08-celular-acoes', {
  width: 390, height: 844,
  acoes: async (p) => {
    await p.locator('.art').first().locator('[data-descartar]').click();
    await p.waitForTimeout(300);
  },
});

// ---------------------------------------------------------------- comportamento

const { ctx, page } = await novaPagina('funcional', { width: 1400, height: 1000 });
const conta = () => page.locator('.art').count();

const total = await conta();

// filtro por tema
await page.click('[data-topic="dei-equidade"]');
await page.waitForTimeout(250);
const filtrado = await conta();
if (!(filtrado > 0 && filtrado < total)) problemas.push(`filtro por tema não estreitou: ${total} → ${filtrado}`);
await page.click('[data-untopic="dei-equidade"]');
await page.waitForTimeout(250);
if (await conta() !== total) problemas.push('remover o filtro não restaurou a lista');

// idioma
await page.click('.seg-btn[data-lang="orig"]');
await page.waitForTimeout(250);
const orig = await page.locator('.art-title').first().innerText();
await page.click('.seg-btn[data-lang="pt"]');
await page.waitForTimeout(250);
if (orig === await page.locator('.art-title').first().innerText()) problemas.push('alternar idioma não mudou o título');

// favoritar
const tituloFav = await page.locator('.art').first().locator('.art-title').innerText();
await page.locator('.art').first().locator('[data-fav]').click();
await page.waitForTimeout(250);
if (await page.locator('#conta-fav').innerText() !== '1') problemas.push('o contador de favoritas não subiu');
await page.click('.vista-btn[data-vista="favoritos"]');
await page.waitForTimeout(300);
if (await conta() !== 1) problemas.push('a vista de favoritas não mostrou exatamente a favoritada');
if (await page.locator('.art-title').first().innerText() !== tituloFav) problemas.push('a favorita mostrada não é a que foi marcada');

// favorito sobrevive a recarregar (é o ponto todo do id estável)
await page.reload({ waitUntil: 'domcontentloaded' });
await page.waitForSelector('.art', { timeout: 8000 });
await page.waitForTimeout(400);
if (await page.locator('#conta-fav').innerText() !== '1') problemas.push('a favorita não sobreviveu ao recarregar');

// descartar com motivo
await page.click('.vista-btn[data-vista="tudo"]');
await page.waitForTimeout(300);
const antesDesc = await conta();
await page.locator('.art').nth(1).locator('[data-descartar]').click();
await page.waitForTimeout(200);
if (await page.locator('.menu-motivo').count() === 0) problemas.push('o menu de motivos não abriu');
await page.click('[data-motivo="fora-do-tema"]');
await page.waitForTimeout(300);
if (await conta() !== antesDesc - 1) problemas.push('descartar não tirou a matéria da lista');
if (await page.locator('#conta-desc').innerText() !== '1') problemas.push('o contador de descartadas não subiu');
if (!(await page.locator('#aprendizado-body .apr-row').count())) problemas.push('o painel de aprendizado ficou vazio depois de um descarte com motivo');

// restaurar
await page.click('.vista-btn[data-vista="descartados"]');
await page.waitForTimeout(300);
if (await conta() !== 1) problemas.push('a vista de descartadas não mostrou a matéria');
await page.locator('[data-restaurar]').first().click();
await page.waitForTimeout(300);
await page.click('.vista-btn[data-vista="tudo"]');
await page.waitForTimeout(300);
if (await conta() !== antesDesc) problemas.push('restaurar não devolveu a matéria à lista');

// esquecer fonte
const fonteAlvo = await page.locator('.art').first().locator('[data-esquecer]').getAttribute('data-esquecer');
const daFonte = await page.locator(`.art:has([data-esquecer="${fonteAlvo}"])`).count();
const antesEsq = await conta();
await page.locator('.art').first().locator('[data-esquecer]').click();
await page.waitForTimeout(350);
if (await conta() !== antesEsq - daFonte) problemas.push('esquecer a fonte não removeu todas as matérias dela');
if (!(await page.locator('[data-lembrar]').count())) problemas.push('a fonte esquecida não apareceu para ser lembrada');
await page.locator('[data-lembrar]').first().click();
await page.waitForTimeout(350);
if (await conta() !== antesEsq) problemas.push('lembrar a fonte não trouxe as matérias de volta');

// estado vazio
await page.fill('#q', 'zzzznadaaqui');
await page.waitForTimeout(400);
if (await page.locator('#empty').isHidden()) problemas.push('busca sem resultado não mostrou o estado vazio');
await page.fill('#q', '');
await page.waitForTimeout(400);

// curadoria e salto para a matéria
await page.click('#btn-ai');
await page.waitForTimeout(300);
if (await page.locator('#briefing').isHidden()) problemas.push('o botão de curadoria não abriu o painel');
if (!(await page.locator('.ref').count())) problemas.push('a curadoria não trouxe referências clicáveis');
await page.locator('.ref').first().click();
await page.waitForTimeout(600);
if (!(await page.locator('.art.is-hit').count())) problemas.push('clicar na referência não destacou a matéria');

await ctx.close();
await browser.close();

console.log(problemas.length ? '\nProblemas:\n  ' + problemas.join('\n  ') : '\nNenhum problema encontrado.');
console.log('\ntelas em preview/shots/');
process.exit(problemas.length ? 1 : 0);
