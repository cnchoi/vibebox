import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import {
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  rename,
  writeFile
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { test } from 'node:test';
import {
  VIBEBOX_VERSION,
  backupVibeBox,
  displayTemplateSchema,
  extractMemoryCandidates,
  initVibeBox,
  loadJson,
  readJsonl,
  runDoctor,
  restoreVibeBox
} from '../src/core.mjs';
import { storeLockPath, withStoreLock } from '../src/store-lock.mjs';

const repositoryRoot = path.resolve('.');
const coreUrl = pathToFileURL(path.join(repositoryRoot, 'src', 'core.mjs')).href;

async function makeReliabilityWorkspace() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'vibebox-reliability-'));
  const store = path.join(root, 'store');
  await mkdir(root, { recursive: true });
  process.env.VIBEBOX_HOME = store;
  await initVibeBox(root, { language: 'en-US' });
  return { root, store };
}

function candidateFixture(index) {
  return {
    memoryRole: 'user_success_criteria',
    type: 'user_preference',
    modelClass: 'user_model',
    modelSubClass: 'preference_model',
    scope: 'global',
    primaryCategory: 'user_preferences',
    relatedCategories: [],
    title: `Concurrent preference ${index}`,
    summary: `Preference ${index} must survive concurrent approval.`,
    rule: `Apply preference ${index}.`,
    displayTitle: `Concurrent preference ${index}`,
    displaySummary: `Preference ${index} must survive concurrent approval.`,
    displayRule: `Apply preference ${index}.`,
    displayLanguage: 'en-US',
    confidence: 'high',
    sourceType: 'agent_semantic_extraction'
  };
}

function approveInChild(candidateId, root, store) {
  const code = `
    const { approveMemory } = await import(${JSON.stringify(coreUrl)});
    await approveMemory(process.env.REVIEW_ROOT, process.env.REVIEW_CANDIDATE_ID);
  `;
  return new Promise((resolve, reject) => {
    execFile(
      process.execPath,
      ['--input-type=module', '-e', code],
      {
        cwd: repositoryRoot,
        env: {
          ...process.env,
          VIBEBOX_HOME: store,
          VIBEBOX_AGENT_RUNTIME: 'codex',
          REVIEW_ROOT: root,
          REVIEW_CANDIDATE_ID: candidateId
        }
      },
      (error, stdout, stderr) => {
        if (error) {
          reject(new Error(`${error.message}\n${stdout}\n${stderr}`));
          return;
        }
        resolve();
      }
    );
  });
}

function runNode(args, options = {}) {
  return new Promise((resolve) => {
    execFile(
      process.execPath,
      args,
      {
        cwd: repositoryRoot,
        env: { ...process.env, ...options.env },
        encoding: 'utf8'
      },
      (error, stdout, stderr) => {
        resolve({
          status: error?.code ?? 0,
          stdout,
          stderr
        });
      }
    );
  });
}

test('concurrent approvals from separate processes preserve every active memory', async () => {
  const { root, store } = await makeReliabilityWorkspace();
  const candidates = [];
  for (let index = 0; index < 10; index += 1) {
    const [candidate] = await extractMemoryCandidates(root, {
      structuredMemoryCandidates: [candidateFixture(index)],
      manualReview: true
    });
    candidates.push(candidate);
  }

  await Promise.all(candidates.map((candidate) => approveInChild(candidate.id, root, store)));

  const index = await loadJson(path.join(store, 'index', 'global-memory-index.json'));
  const activeIds = new Set(
    (index.memories || [])
      .filter((memory) => memory.status === 'active')
      .map((memory) => memory.id)
  );
  const missingIds = candidates
    .map((candidate) => candidate.id)
    .filter((candidateId) => !activeIds.has(candidateId));

  assert.deepEqual(missingIds, []);
});

test('wiki rebuild does not erase an approval running concurrently', async () => {
  const { root, store } = await makeReliabilityWorkspace();
  const [candidate] = await extractMemoryCandidates(root, {
    structuredMemoryCandidates: [candidateFixture(99)],
    manualReview: true
  });
  const rebuildCode = `
    const { rebuildVibeBox } = await import(${JSON.stringify(coreUrl)});
    await rebuildVibeBox(process.env.REVIEW_ROOT, { wikiOnly: true });
  `;

  const [approval, rebuild] = await Promise.all([
    approveInChild(candidate.id, root, store),
    runNode(
      ['--input-type=module', '-e', rebuildCode],
      {
        env: {
          VIBEBOX_HOME: store,
          REVIEW_ROOT: root
        }
      }
    )
  ]);

  assert.equal(rebuild.status, 0, rebuild.stderr);
  await approval;
  const index = await loadJson(path.join(store, 'index', 'global-memory-index.json'));
  assert.ok(index.memories.some((memory) => memory.id === candidate.id && memory.status === 'active'));
});

test('failed restore copy preserves the original store', async () => {
  const { root, store } = await makeReliabilityWorkspace();
  const backup = await backupVibeBox(root, {
    output: path.join(root, 'backup')
  });
  const markerPath = path.join(store, 'post-backup-marker.txt');
  await writeFile(markerPath, 'original store must survive\n', 'utf8');

  await assert.rejects(
    () => restoreVibeBox(root, {
      from: backup.backupPath,
      confirmReplace: true,
      copyStore: async () => {
        throw new Error('injected restore copy failure');
      }
    }),
    /injected restore copy failure/u
  );

  assert.equal(await readFile(markerPath, 'utf8'), 'original store must survive\n');
});

test('failed restore swap rolls the original store back', async () => {
  const { root, store } = await makeReliabilityWorkspace();
  const backup = await backupVibeBox(root, {
    output: path.join(root, 'swap-backup')
  });
  const markerPath = path.join(store, 'post-backup-marker.txt');
  await writeFile(markerPath, 'original store must roll back\n', 'utf8');
  let renameCalls = 0;

  await assert.rejects(
    () => restoreVibeBox(root, {
      from: backup.backupPath,
      confirmReplace: true,
      renameStore: async (from, to) => {
        renameCalls += 1;
        if (renameCalls === 2) {
          throw new Error('injected restore swap failure');
        }
        await rename(from, to);
      }
    }),
    /injected restore swap failure/u
  );

  assert.equal(await readFile(markerPath, 'utf8'), 'original store must roll back\n');
});

test('restore accepts backups created without logs', async () => {
  const { root, store } = await makeReliabilityWorkspace();
  const backup = await backupVibeBox(root, {
    output: path.join(root, 'without-logs'),
    includeLogs: false
  });

  await restoreVibeBox(root, {
    from: backup.backupPath,
    confirmReplace: true
  });

  assert.ok(await readFile(path.join(store, 'config.json'), 'utf8'));
  await assert.rejects(
    () => readFile(path.join(store, 'logs', 'events.jsonl'), 'utf8'),
    /ENOENT/u
  );
});

test('doctor command exits non-zero when the store has errors', async () => {
  const { root, store } = await makeReliabilityWorkspace();
  await writeFile(path.join(store, 'index', 'relation-index.json'), '{broken', 'utf8');

  const result = await runNode([path.join(repositoryRoot, 'bin', 'vibebox.mjs'), 'doctor'], {
    env: { VIBEBOX_HOME: store }
  });

  assert.equal(result.status, 1);
  assert.match(result.stdout, /Status: error/u);
});

test('CLI init uses a display template supplied through the environment', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'vibebox-template-env-'));
  const store = path.join(root, 'store');
  const schema = displayTemplateSchema();
  const displayTemplate = Object.fromEntries(
    schema.requiredKeys.map((key) => [key, schema.baseTemplate[key]])
  );
  const result = await runNode([
    path.join(repositoryRoot, 'bin', 'vibebox.mjs'),
    'init',
    '--language',
    'ko-KR'
  ], {
    env: {
      VIBEBOX_HOME: store,
      VIBEBOX_DISPLAY_TEMPLATE: JSON.stringify({
        languageTag: 'ko-KR',
        displayTemplate
      })
    }
  });

  assert.equal(result.status, 0, result.stderr);
  const config = await loadJson(path.join(store, 'config.json'));
  assert.equal(config.memoryLanguage, 'ko-KR');
});

test('wiki titles containing Obsidian link syntax remain valid', async () => {
  const { root, store } = await makeReliabilityWorkspace();
  await extractMemoryCandidates(root, {
    structuredMemoryCandidates: [{
      memoryRole: 'ai_successful_approach',
      type: 'validation_pattern',
      modelClass: 'project_model',
      modelSubClass: 'validation_rule_model',
      scope: 'global',
      primaryCategory: 'validation_patterns',
      relatedCategories: [],
      title: 'Issue #42 and A^B [draft]',
      summary: 'Run validation after issue 42 changes.',
      rule: 'Run validation after issue 42 changes.',
      displayTitle: 'Issue #42 and A^B [draft]',
      displaySummary: 'Run validation after issue 42 changes.',
      displayRule: 'Run validation after issue 42 changes.',
      displayLanguage: 'en-US',
      confidence: 'high',
      sourceType: 'agent_semantic_extraction',
      successEvidence: 'inferred',
      acceptanceBasis: 'inferred'
    }]
  });

  const report = await runDoctor(root);
  assert.deepEqual(
    report.warnings.filter((warning) => /Wiki link target is missing/u.test(warning)),
    []
  );
  const noteFiles = await readdir(path.join(store, 'wiki'), {
    recursive: true,
    withFileTypes: true
  });
  const titleFile = noteFiles.find((entry) => (
    entry.isFile() && entry.name.endsWith('.md') && entry.name.includes('Issue')
  ));
  assert.ok(titleFile);
  assert.doesNotMatch(titleFile.name, /[#^\[\]]/u);
});

test('readJsonl quarantines only the corrupt line', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'vibebox-jsonl-recovery-'));
  const filePath = path.join(root, 'records.jsonl');
  await writeFile(filePath, '{"id":"ok"}\n{broken\n{"id":"also-ok"}\n', 'utf8');

  const records = await readJsonl(filePath);
  assert.deepEqual(records, [{ id: 'ok' }, { id: 'also-ok' }]);
  assert.match(await readFile(`${filePath}.corrupt`, 'utf8'), /\{broken/u);
});

test('doctor reports quarantined corrupt JSONL lines', async () => {
  const { root, store } = await makeReliabilityWorkspace();
  await writeFile(
    path.join(store, 'pending', 'memory-candidates.jsonl.corrupt'),
    '{"lineNumber":1,"text":"{broken"}\n',
    'utf8'
  );

  const report = await runDoctor(root);
  assert.ok(
    report.warnings.some((warning) => /quarantined corrupt JSONL lines/iu.test(warning)),
    JSON.stringify(report.warnings)
  );
});

test('init upgrades an old config version to the package version', async () => {
  const { root, store } = await makeReliabilityWorkspace();
  const configPath = path.join(store, 'config.json');
  const config = await loadJson(configPath);
  config.version = '0.1.13';
  await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`, 'utf8');

  await initVibeBox(root);
  const updated = await loadJson(configPath);
  assert.equal(updated.version, VIBEBOX_VERSION);
});

test('store lock lives beside the store and reclaims a dead owner', async () => {
  const { root, store } = await makeReliabilityWorkspace();
  const lockPath = storeLockPath(store);
  assert.equal(path.dirname(lockPath), path.dirname(store));
  await writeFile(lockPath, JSON.stringify({
    token: 'stale-lock',
    pid: 999999,
    hostname: os.hostname(),
    operation: 'stale test',
    createdAt: new Date(0).toISOString()
  }), 'utf8');

  let executed = false;
  await withStoreLock(store, async () => {
    executed = true;
    assert.equal(await readFile(lockPath, 'utf8').then((text) => JSON.parse(text).token === 'stale-lock'), false);
  }, { timeoutMs: 2_000, staleMs: 1_000 });

  assert.equal(executed, true);
  await assert.rejects(() => readFile(lockPath, 'utf8'), /ENOENT/u);
  assert.ok(root);
});
