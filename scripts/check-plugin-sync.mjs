import { createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  PLUGIN_DIRECTORY_MAPPINGS,
  PLUGIN_FILE_MAPPINGS
} from './plugin-package-config.mjs';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const packageRoot = path.join(repositoryRoot, 'plugins', 'vibebox');

function sha256(buffer) {
  return createHash('sha256').update(buffer).digest('hex');
}

async function listFiles(root, relative = '') {
  const current = path.join(root, relative);
  const entries = await readdir(current, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const next = path.join(relative, entry.name);
    if (entry.isDirectory()) {
      files.push(...await listFiles(root, next));
    } else if (entry.isFile()) {
      files.push(next.replace(/\\/gu, '/'));
    }
  }
  return files;
}

const expected = new Set(PLUGIN_FILE_MAPPINGS.map(([, target]) => target.replace(/\\/gu, '/')));
expected.add('package.json');
for (const directory of PLUGIN_DIRECTORY_MAPPINGS) {
  for (const relative of await listFiles(path.join(repositoryRoot, directory))) {
    expected.add(`${directory}/${relative}`);
  }
}

const problems = [];
for (const [sourceRelative, targetRelative] of PLUGIN_FILE_MAPPINGS) {
  const source = await readFile(path.join(repositoryRoot, sourceRelative));
  let target;
  try {
    target = await readFile(path.join(packageRoot, targetRelative));
  } catch {
    problems.push(`missing: ${targetRelative}`);
    continue;
  }
  if (sha256(source) !== sha256(target)) {
    problems.push(`outdated: ${targetRelative}`);
  }
}

for (const directory of PLUGIN_DIRECTORY_MAPPINGS) {
  for (const relative of await listFiles(path.join(repositoryRoot, directory))) {
    const targetRelative = `${directory}/${relative}`;
    const source = await readFile(path.join(repositoryRoot, directory, relative));
    let target;
    try {
      target = await readFile(path.join(packageRoot, targetRelative));
    } catch {
      problems.push(`missing: ${targetRelative}`);
      continue;
    }
    if (sha256(source) !== sha256(target)) {
      problems.push(`outdated: ${targetRelative}`);
    }
  }
}

const sourcePackage = JSON.parse(await readFile(path.join(repositoryRoot, 'package.json'), 'utf8'));
const expectedPackage = {
  name: sourcePackage.name,
  version: sourcePackage.version,
  description: sourcePackage.description,
  type: sourcePackage.type,
  bin: sourcePackage.bin,
  engines: sourcePackage.engines,
  license: sourcePackage.license
};
const actualPackage = JSON.parse(await readFile(path.join(packageRoot, 'package.json'), 'utf8'));
if (JSON.stringify(actualPackage) !== JSON.stringify(expectedPackage)) {
  problems.push('outdated: package.json');
}

const actualFiles = await listFiles(packageRoot);
for (const relative of actualFiles) {
  if (!expected.has(relative)) {
    problems.push(`stale: ${relative}`);
  }
}

if (problems.length > 0) {
  process.stderr.write(`Plugin package is out of sync:\n${problems.map((problem) => `- ${problem}`).join('\n')}\n`);
  process.exitCode = 1;
} else {
  process.stdout.write(`Plugin package is synchronized with ${expected.size} file(s).\n`);
}
