#!/usr/bin/env node
/** Mantém apenas os últimos N dias de arquivo, para o repositório não inchar. */

import { readdir, unlink, stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ARCHIVE = join(__dirname, '..', 'site', 'data', 'archive');
const KEEP_DAYS = parseInt(process.env.KEEP_DAYS || '30', 10);

const cutoff = new Date(Date.now() - KEEP_DAYS * 86400000).toISOString().slice(0, 10);

let files;
try {
  files = (await readdir(ARCHIVE)).filter((f) => /^\d{4}-\d{2}-\d{2}\.json$/.test(f));
} catch {
  console.log('sem pasta de arquivo ainda — nada a podar');
  process.exit(0);
}

let removed = 0, bytes = 0;
for (const f of files) {
  if (f.slice(0, 10) >= cutoff) continue;
  try {
    bytes += (await stat(join(ARCHIVE, f))).size;
    await unlink(join(ARCHIVE, f));
    removed++;
  } catch { /* ignora */ }
}

const index = files.filter((f) => f.slice(0, 10) >= cutoff).sort().reverse();
console.log(`arquivo: ${index.length} edições mantidas, ${removed} removidas (${(bytes / 1048576).toFixed(1)} MB liberados)`);
