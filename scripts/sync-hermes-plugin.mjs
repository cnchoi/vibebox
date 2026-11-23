/**
 * Deploy the Hermes VibeBox plugin from this repository to the live Hermes plugin
 * directory, or verify that the live copy still matches the source.
 *
 * The repository (`adapters/hermes/plugin/`) is the single source of truth; the live
 * directory only ever holds a copy, so plugin logic cannot drift between the two.
 *
 * Usage:
 *   node scripts/sync-hermes-plugin.mjs           # copy source -> live (backs up first)
 *   node scripts/sync-hermes-plugin.mjs --check   # exit 1 when the live copy differs
 *
 * Target directory: `VIBEBOX_HERMES_HOME` or `HERMES_HOME` (default `D:/HermesPrograms/hermes`),
 * then `/plugins/vibebox`.
 */
import { cp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sourceDir = path.join(repositoryRoot, 'adapters', 'hermes', 'plugin');
const hermesHome = process.env.VIBEBOX_HERMES_HOME || process.env.HERMES_HOME || 'D:/HermesPrograms/hermes';
const targetDir = path.join(hermesHome, 'plugins', 'vibebox');
const checkOnly = process.argv.includes('--check');

const FILES = ['__init__.py', 'plugin.yaml'];

function sha256(buffer) {
  return createHash('sha256').update(buffer).digest('hex');
}

async function readHash(file) {
  try {
    return sha256(await readFile(file));
  } catch {
    return null;
  }
}

async function main() {
  if (!existsSync(hermesHome)) {
    console.log(`[hermes-plugin] skipped — Hermes directory not found: ${hermesHome}`);
    return;
  }

  const drift = [];
  for (const name of FILES) {
    const sourceHash = await readHash(path.join(sourceDir, name));
    if (!sourceHash) {
      console.error(`[hermes-plugin] missing source file: ${path.join(sourceDir, name)}`);
      process.exitCode = 1;
      return;
    }
    const targetHash = await readHash(path.join(targetDir, name));
    if (sourceHash !== targetHash) {
      drift.push({ name, sourceHash, targetHash });
    }
  }

  if (checkOnly) {
    if (drift.length === 0) {
      console.log(`[hermes-plugin] check ok — ${targetDir} matches adapters/hermes/plugin`);
      return;
    }
    for (const entry of drift) {
      console.error(
        `[hermes-plugin] drift: ${entry.name} live=${entry.targetHash ? entry.targetHash.slice(0, 12) : '(missing)'} source=${entry.sourceHash.slice(0, 12)}`
      );
    }
    console.error('[hermes-plugin] run `node scripts/sync-hermes-plugin.mjs` to redeploy');
    process.exitCode = 1;
    return;
  }

  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backupDir = path.join(hermesHome, 'plugins', `.vibebox-backup-${stamp}`);
  await mkdir(targetDir, { recursive: true });
  const existing = await readdir(targetDir);
  const backups = [];
  for (const name of existing) {
    if (!FILES.includes(name)) continue;
    await mkdir(backupDir, { recursive: true });
    const backupPath = path.join(backupDir, name);
    await cp(path.join(targetDir, name), backupPath, { force: true });
    backups.push(backupPath);
  }

  for (const name of FILES) {
    await cp(path.join(sourceDir, name), path.join(targetDir, name), { force: true });
    const expected = await readHash(path.join(sourceDir, name));
    const written = await readHash(path.join(targetDir, name));
    if (expected !== written) {
      console.error(`[hermes-plugin] copy verification failed for ${name}`);
      process.exitCode = 1;
      return;
    }
    console.log(`[hermes-plugin] wrote ${path.join(targetDir, name)} (${written.slice(0, 12)})`);
  }

  // Drop a stale bytecode cache so the next Hermes process compiles the new source.
  await rm(path.join(targetDir, '__pycache__'), { recursive: true, force: true });
  await writeFile(path.join(targetDir, '.vibebox-source-stamp'), `${new Date().toISOString()}\n`, 'utf8');

  if (backups.length > 0) {
    console.log(`[hermes-plugin] backup: ${backupDir}`);
  }
  console.log('[hermes-plugin] deployed — restart the gateway (`hermes gateway restart`) to load it');
}

await main();
