#!/usr/bin/env node
/** Abre a prévia num Chromium de verdade, captura telas e reporta erros de console. */

import { chromium } from 'playwright';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdir } from 'node:fs/promises';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const FILE = 'file://' + join(ROOT, 'preview', 'standalone.html');
const OUT = join(ROOT, 'preview', 'shots');
await mkdir(OUT, { recursive: true });

// o Chromium pré-instalado do ambiente pode ter build diferente do que o
// pacote espera; apontar direto para o binário evita download
const browser = await chromium.launch({
  executablePath: process.env.CHROME_PATH || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  args: ['--no-sandbox', '--font-render-hinting=none'],
});
const problems = [];

async function shot(name, { width, height, theme, actions }) {
  const ctx = await browser.newContext({
    viewport: { width, height }, colorScheme: theme, deviceScaleFactor: 2,
  });
  const page = await ctx.newPage();
  page.on('console', (m) => { if (m.type() === 'error') problems.push(`[${name}] console: ${m.text()}`); });
  page.on('pageerror', (e) => problems.push(`[${name}] erro de página: ${e.message}`));
  await page.goto(FILE, { waitUntil: 'networkidle' });
  await page.waitForTimeout(900);
  if (actions) await actions(page);
  await page.screenshot({ path: join(OUT, name + '.png'), fullPage: false });

  // largura da página não pode passar da janela
  const overflow = await page.evaluate(() =>
    document.documentElement.scrollWidth - document.documentElement.clientWidth);
  if (overflow > 2) problems.push(`[${name}] a página rola para o lado (${overflow}px a mais)`);

  await ctx.close();
  return page;
}

await shot('01-claro', { width: 1400, height: 1000, theme: 'light' });
await shot('02-escuro', { width: 1400, height: 1000, theme: 'dark' });
await shot('03-curadoria-ia', {
  width: 1400, height: 1100, theme: 'light',
  actions: async (p) => { await p.click('#btn-ai'); await p.waitForTimeout(400); },
});
await shot('04-filtrado-por-tema', {
  width: 1400, height: 1000, theme: 'light',
  actions: async (p) => {
    await p.click('[data-topic="educacao-aprendizagem"]');
    await p.click('[data-topic="performance-humana"]');
    await p.waitForTimeout(400);
  },
});
await shot('05-fontes-e-busca', {
  width: 1400, height: 1000, theme: 'dark',
  actions: async (p) => {
    await p.fill('#q', 'requalifica');
    await p.waitForTimeout(500);
    await p.evaluate(() => { document.querySelector('.sidebar-scroll').scrollTop = 420; });
    await p.waitForTimeout(200);
  },
});
await shot('06-celular', {
  width: 390, height: 844, theme: 'light',
  actions: async (p) => { await p.waitForTimeout(300); },
});
await shot('07-celular-filtros', {
  width: 390, height: 844, theme: 'light',
  actions: async (p) => { await p.click('#btn-filters'); await p.waitForTimeout(400); },
});

// checagens funcionais
const ctx = await browser.newContext({ viewport: { width: 1400, height: 1000 } });
const page = await ctx.newPage();
page.on('pageerror', (e) => problems.push(`[funcional] ${e.message}`));
await page.goto(FILE, { waitUntil: 'networkidle' });
await page.waitForTimeout(600);

const total = await page.locator('.art').count();
await page.click('[data-topic="dei-equidade"]');
await page.waitForTimeout(300);
const filtered = await page.locator('.art').count();
if (!(filtered > 0 && filtered < total)) problems.push(`filtro por tema não estreitou: ${total} → ${filtered}`);

await page.click('[data-untopic="dei-equidade"]');
await page.waitForTimeout(300);
if (await page.locator('.art').count() !== total) problems.push('remover o filtro não restaurou a lista');

await page.click('.seg-btn[data-lang="orig"]');
await page.waitForTimeout(300);
const origTitle = await page.locator('.art-title').first().innerText();
await page.click('.seg-btn[data-lang="pt"]');
await page.waitForTimeout(300);
const ptTitle = await page.locator('.art-title').first().innerText();
if (origTitle === ptTitle) problems.push('alternar idioma não mudou o título');

await page.fill('#q', 'zzzznadaaqui');
await page.waitForTimeout(400);
if (await page.locator('#empty').isHidden()) problems.push('busca sem resultado não mostrou o estado vazio');
await page.fill('#q', '');
await page.waitForTimeout(400);

await page.click('#btn-ai');
await page.waitForTimeout(300);
if (await page.locator('#briefing').isHidden()) problems.push('o botão de curadoria não abriu o painel');
const refs = await page.locator('.ref').count();
if (refs === 0) problems.push('a curadoria não trouxe referências clicáveis');
await page.locator('.ref').first().click();
await page.waitForTimeout(600);
if (await page.locator('.art.is-hit').count() === 0) problems.push('clicar na referência não destacou a matéria');

await ctx.close();
await browser.close();

console.log(problems.length ? '\nProblemas:\n  ' + problems.join('\n  ') : '\nNenhum problema encontrado.');
console.log(`\ntelas em preview/shots/`);
process.exit(problems.length ? 1 : 0);
