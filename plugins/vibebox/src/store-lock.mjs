import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import {
  mkdir,
  open,
  readFile,
  rename,
  rm,
  stat,
  unlink,
  utimes
} from 'node:fs/promises';
import { hostname } from 'node:os';
import path from 'node:path';

const activeLock = new AsyncLocalStorage();

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function storeLockPath(storeRoot) {
  const resolved = path.resolve(storeRoot);
  const basename = path.basename(resolved) || 'vibebox';
  return path.join(path.dirname(resolved), `.${basename}.lock`);
}

async function readLockMetadata(lockPath) {
  try {
    return JSON.parse(await readFile(lockPath, 'utf8'));
  } catch {
    return null;
  }
}

async function lockAgeMs(lockPath) {
  try {
    return Date.now() - (await stat(lockPath)).mtimeMs;
  } catch {
    return 0;
  }
}

function isProcessAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === 'EPERM';
  }
}

async function lockIsStale(lockPath, staleMs) {
  const metadata = await readLockMetadata(lockPath);
  if (metadata?.hostname === hostname() && metadata.pid && !isProcessAlive(metadata.pid)) {
    return true;
  }
  return (await lockAgeMs(lockPath)) > staleMs;
}

async function tryCreateLock(lockPath, metadata) {
  let handle;
  let created = false;
  try {
    handle = await open(lockPath, 'wx', 0o600);
    created = true;
    await handle.writeFile(`${JSON.stringify(metadata, null, 2)}\n`, 'utf8');
    await handle.sync();
    return true;
  } catch (error) {
    if (error?.code === 'EEXIST') return false;
    if (created) await unlink(lockPath).catch(() => {});
    throw error;
  } finally {
    await handle?.close().catch(() => {});
  }
}

async function reclaimStaleLock(lockPath) {
  const stalePath = `${lockPath}.stale-${randomUUID()}`;
  try {
    await rename(lockPath, stalePath);
  } catch (error) {
    if (['ENOENT', 'EEXIST', 'EPERM'].includes(error?.code)) return;
    throw error;
  }
  await rm(stalePath, { force: true }).catch(() => {});
}

async function acquireLock(storeRoot, options = {}) {
  const lockPath = storeLockPath(storeRoot);
  const timeoutMs = Number.isFinite(options.timeoutMs) ? options.timeoutMs : 10_000;
  const staleMs = Number.isFinite(options.staleMs) ? options.staleMs : 30_000;
  const metadata = {
    token: randomUUID(),
    pid: process.pid,
    hostname: hostname(),
    operation: options.operation || 'store mutation',
    createdAt: new Date().toISOString()
  };
  const deadline = Date.now() + timeoutMs;
  let delayMs = 40;

  await mkdir(path.dirname(lockPath), { recursive: true });
  while (Date.now() <= deadline) {
    if (await tryCreateLock(lockPath, metadata)) {
      return { lockPath, metadata };
    }
    if (await lockIsStale(lockPath, staleMs)) {
      await reclaimStaleLock(lockPath);
      continue;
    }
    await sleep(delayMs);
    delayMs = Math.min(500, Math.ceil(delayMs * 1.6));
  }

  const holder = await readLockMetadata(lockPath);
  throw new Error(
    `Timed out waiting for VibeBox store lock at ${lockPath}`
    + (holder ? ` held by pid ${holder.pid} since ${holder.createdAt}` : '')
  );
}

async function releaseLock(lockPath, token) {
  const metadata = await readLockMetadata(lockPath);
  if (metadata?.token !== token) return;
  await unlink(lockPath).catch((error) => {
    if (error?.code !== 'ENOENT') throw error;
  });
}

export async function withStoreLock(storeRoot, callback, options = {}) {
  const resolvedStore = path.resolve(storeRoot);
  const current = activeLock.getStore();
  if (current?.storeRoot === resolvedStore) {
    return callback();
  }

  const { lockPath, metadata } = await acquireLock(resolvedStore, options);
  const heartbeat = setInterval(() => {
    const now = new Date();
    utimes(lockPath, now, now).catch(() => {});
  }, Math.max(250, Math.min(5_000, Math.floor((options.staleMs || 30_000) / 3))));
  heartbeat.unref?.();

  try {
    return await activeLock.run({
      storeRoot: resolvedStore,
      lockPath,
      token: metadata.token,
      depth: 1
    }, callback);
  } finally {
    clearInterval(heartbeat);
    await releaseLock(lockPath, metadata.token);
  }
}
