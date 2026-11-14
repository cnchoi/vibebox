import {
  access,
  cp,
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  writeFile
} from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  PLUGIN_DIRECTORY_MAPPINGS,
  PLUGIN_FILE_MAPPINGS
} from './plugin-package-config.mjs';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const packageRoot = path.join(repositoryRoot, 'plugins', 'vibebox');
const stagingRoot = path.join(
  repositoryRoot,
  'plugins',
  `.vibebox-package-staging-${process.pid}-${Date.now()}`
);
const backupRoot = path.join(
  repositoryRoot,
  'plugins',
  `.vibebox-package-backup-${process.pid}-${Date.now()}`
);

for (const [sourceRelative, targetRelative] of PLUGIN_FILE_MAPPINGS) {
  const source = path.join(repositoryRoot, sourceRelative);
  const target = path.join(stagingRoot, targetRelative);
  await mkdir(path.dirname(target), { recursive: true });
  await cp(source, target, { force: true });
}

for (const directory of PLUGIN_DIRECTORY_MAPPINGS) {
  await cp(path.join(repositoryRoot, directory), path.join(stagingRoot, directory), {
    recursive: true,
    force: true
  });
}

const rootPackage = JSON.parse(await readFile(path.join(repositoryRoot, 'package.json'), 'utf8'));
const runtimePackage = {
  name: rootPackage.name,
  version: rootPackage.version,
  description: rootPackage.description,
  type: rootPackage.type,
  bin: rootPackage.bin,
  engines: rootPackage.engines,
  license: rootPackage.license
};
await writeFile(path.join(stagingRoot, 'package.json'), `${JSON.stringify(runtimePackage, null, 2)}\n`, 'utf8');

let movedExisting = false;
try {
  try {
    await access(packageRoot);
    await rename(packageRoot, backupRoot);
    movedExisting = true;
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
  try {
    await rename(stagingRoot, packageRoot);
  } catch (error) {
    if (!['EPERM', 'EACCES', 'EBUSY', 'ENOTEMPTY'].includes(error?.code)) {
      throw error;
    }
    try {
      await mkdir(packageRoot, { recursive: true });
      for (const entry of await readdir(stagingRoot)) {
        await cp(
          path.join(stagingRoot, entry),
          path.join(packageRoot, entry),
          { recursive: true, force: true }
        );
      }
    } catch (copyError) {
      await rm(packageRoot, { recursive: true, force: true }).catch(() => {});
      if (movedExisting) {
        await rename(backupRoot, packageRoot).catch(() => {});
        movedExisting = false;
      }
      throw copyError;
    }
  }
  if (movedExisting) {
    await rm(backupRoot, { recursive: true, force: true });
    movedExisting = false;
  }
} finally {
  await rm(stagingRoot, { recursive: true, force: true }).catch(() => {});
  if (movedExisting) {
    await rm(backupRoot, { recursive: true, force: true }).catch(() => {});
  }
}

process.stdout.write(`Synced self-contained plugin package at ${packageRoot}\n`);
