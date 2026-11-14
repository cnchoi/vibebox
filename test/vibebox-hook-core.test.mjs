import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  aftertaskGuidance,
  isActionableTask,
  resolveAgentRuntime,
  truncate
} from '../scripts/vibebox-hook-core.mjs';
import { setupAntigravity } from '../src/core.mjs';

const HOST_RUNTIME_ENV_KEYS = [
  'CODEX_THREAD_ID',
  'CODEX_SANDBOX',
  'CODEX_CLI',
  'CODEX_VERSION',
  'OPENAI_CODEX'
];
const originalHostEnv = new Map();

before(() => {
  for (const key of [...HOST_RUNTIME_ENV_KEYS, 'PYTHONIOENCODING', 'PYTHONUTF8']) {
    originalHostEnv.set(key, process.env[key]);
  }
  for (const key of HOST_RUNTIME_ENV_KEYS) delete process.env[key];
  process.env.PYTHONIOENCODING = 'utf-8';
  process.env.PYTHONUTF8 = '1';
});

after(() => {
  for (const [key, value] of originalHostEnv) {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
});

test('isActionableTask filters casual greetings and acknowledgments', () => {
  assert.equal(isActionableTask(''), false);
  assert.equal(isActionableTask('   '), false);
  assert.equal(isActionableTask('안녕하세요'), false);
  assert.equal(isActionableTask('안녕!'), false);
  assert.equal(isActionableTask('hello'), false);
  assert.equal(isActionableTask('hi there'), false);
  assert.equal(isActionableTask('감사합니다'), false);
  assert.equal(isActionableTask('고마워요!'), false);
  assert.equal(isActionableTask('thank you'), false);
  assert.equal(isActionableTask('thanks'), false);
  assert.equal(isActionableTask('ok'), false);
  assert.equal(isActionableTask('알겠어'), false);
  assert.equal(isActionableTask('네'), false);
  assert.equal(isActionableTask('확인'), false);
});

test('isActionableTask filters non-coding questions and translation tasks', () => {
  assert.equal(isActionableTask('Translate this paragraph into Korean please.'), false);
  assert.equal(isActionableTask('이 문서 번역해줘'), false);
  assert.equal(isActionableTask('단락 번역해줘'), false);
  assert.equal(isActionableTask('What does the term store mean in retail?'), false);
  assert.equal(isActionableTask('Who is the president of France?'), false);
  assert.equal(isActionableTask('hello there, how are you doing today?'), false);

  // Casual sentences containing nouns like '테스트' or '버그'
  assert.equal(isActionableTask('요즘 테스트 점수 어때?'), false);
  assert.equal(isActionableTask('버그 나온 영화 봤어?'), false);
});

test('isActionableTask recognizes code indicators, verbs, and technical directives', () => {
  assert.equal(isActionableTask('함수 리팩토링 해줘'), true);
  assert.equal(isActionableTask('fix the failing test in vibebox.test.mjs'), true);
  assert.equal(isActionableTask('git status 확인'), true);
  assert.equal(isActionableTask('build failing with exit code 1'), true);
  assert.equal(isActionableTask('이 코드 왜 에러가 나?'), true);
  assert.equal(isActionableTask('```javascript\nconst a = 1;\n```'), true);
  assert.equal(isActionableTask('src/core.mjs 파일 열어봐'), true);
  assert.equal(isActionableTask('VibeBox pretask 호출 방법 알려줘'), true);
  assert.equal(isActionableTask('에이전트 학습기능 강화'), true);

  // Genuine natural Korean user requests
  assert.equal(isActionableTask('이거 고쳐줘'), true);
  assert.equal(isActionableTask('버튼 색깔 바꿔줘'), true);
  assert.equal(isActionableTask('로그인 안 돼 왜 그래?'), true);
  assert.equal(isActionableTask('새로운 기능 만들어줘'), true);
});

test('resolveAgentRuntime respects env, option, and host hints with precedence', () => {
  assert.equal(resolveAgentRuntime({ defaultRuntime: 'codex' }), 'codex');
  assert.equal(resolveAgentRuntime({ defaultRuntime: 'antigravity' }), 'antigravity');

  // CODEX_THREAD_ID takes precedence over defaultRuntime: 'claude'
  const oldCodex = process.env.CODEX_THREAD_ID;
  try {
    process.env.CODEX_THREAD_ID = 'thread-123';
    assert.equal(resolveAgentRuntime({ defaultRuntime: 'claude' }), 'codex');
  } finally {
    if (oldCodex === undefined) {
      delete process.env.CODEX_THREAD_ID;
    } else {
      process.env.CODEX_THREAD_ID = oldCodex;
    }
  }

  // VIBEBOX_AGENT_RUNTIME takes absolute top precedence
  const oldEnv = process.env.VIBEBOX_AGENT_RUNTIME;
  try {
    process.env.VIBEBOX_AGENT_RUNTIME = 'hermes';
    assert.equal(resolveAgentRuntime({ defaultRuntime: 'codex' }), 'hermes');
  } finally {
    if (oldEnv === undefined) {
      delete process.env.VIBEBOX_AGENT_RUNTIME;
    } else {
      process.env.VIBEBOX_AGENT_RUNTIME = oldEnv;
    }
  }
});

test('Codex Stop hook outputs guidance with codex runtime attribution', async () => {
  const hookPath = path.resolve('scripts/codex-vibebox-hook.mjs');
  const env = {
    ...process.env,
    CLAUDE_PLUGIN_ROOT: path.resolve('.')
  };

  const stopRun = spawnSync(process.execPath, [hookPath], {
    input: JSON.stringify({
      hook_event_name: 'Stop',
      cwd: process.cwd()
    }),
    encoding: 'utf8',
    env
  });

  assert.equal(stopRun.status, 0);
  const payload = JSON.parse(stopRun.stdout);
  assert.equal(payload.decision, 'block');
  assert.match(payload.reason, /VibeBox aftertask checkpoint/);
  assert.match(payload.reason, /codex/i);
});

test('Claude hook skips pretask for casual non-actionable prompts', async () => {
  const hookPath = path.resolve('scripts/claude-vibebox-hook.mjs');
  const env = {
    ...process.env,
    CLAUDE_PLUGIN_ROOT: path.resolve('.')
  };

  const promptRun = spawnSync(process.execPath, [hookPath], {
    input: JSON.stringify({
      hook_event_name: 'UserPromptSubmit',
      prompt: '안녕하세요!',
      cwd: process.cwd()
    }),
    encoding: 'utf8',
    env
  });

  assert.equal(promptRun.status, 0);
  assert.equal(promptRun.stdout.trim(), '');
});

test('Antigravity PreInvocation hook deduplicates using (prompt, initialNumSteps)', async () => {
  const hookPath = path.resolve('scripts/antigravity-vibebox-hook.mjs');
  const env = {
    ...process.env,
    CLAUDE_PLUGIN_ROOT: path.resolve('.')
  };

  // 1. Casual greeting -> empty injectSteps
  const greetingRun = spawnSync(process.execPath, [hookPath, 'PreInvocation'], {
    input: JSON.stringify({
      lastUserInput: '좋은 아침입니다',
      conversationId: 'test-convo-casual',
      initialNumSteps: 0,
      workspacePaths: [process.cwd()]
    }),
    encoding: 'utf8',
    env
  });

  assert.equal(greetingRun.status, 0);
  const greetingPayload = JSON.parse(greetingRun.stdout);
  assert.deepEqual(greetingPayload.injectSteps, []);

  // 2. Actionable task first invocation -> injects systemMessage
  const convoId = `test-convo-dedupe-${Date.now()}`;
  const firstRun = spawnSync(process.execPath, [hookPath, 'PreInvocation'], {
    input: JSON.stringify({
      lastUserInput: '함수 리팩토링 및 테스트 코드 작성',
      conversationId: convoId,
      initialNumSteps: 0,
      invocationNum: 1,
      workspacePaths: [process.cwd()]
    }),
    encoding: 'utf8',
    env
  });

  assert.equal(firstRun.status, 0);
  const firstPayload = JSON.parse(firstRun.stdout);
  assert.ok(Array.isArray(firstPayload.injectSteps));
  assert.equal(firstPayload.injectSteps.length, 1);
  assert.match(firstPayload.injectSteps[0].systemMessage.systemMessage, /VibeBox/);

  // 3. Second invocation in the same turn (same initialNumSteps and prompt) -> deduplicated!
  const secondRun = spawnSync(process.execPath, [hookPath, 'PreInvocation'], {
    input: JSON.stringify({
      lastUserInput: '함수 리팩토링 및 테스트 코드 작성',
      conversationId: convoId,
      initialNumSteps: 0,
      invocationNum: 2,
      workspacePaths: [process.cwd()]
    }),
    encoding: 'utf8',
    env
  });

  assert.equal(secondRun.status, 0);
  const secondPayload = JSON.parse(secondRun.stdout);
  assert.deepEqual(secondPayload.injectSteps, []);

  // 4. Turn 2 with same prompt but different initialNumSteps (new turn in conversation) -> INJECTS!
  const turnTwoRun = spawnSync(process.execPath, [hookPath, 'PreInvocation'], {
    input: JSON.stringify({
      lastUserInput: '함수 리팩토링 및 테스트 코드 작성',
      conversationId: convoId,
      initialNumSteps: 5,
      invocationNum: 3,
      workspacePaths: [process.cwd()]
    }),
    encoding: 'utf8',
    env
  });

  assert.equal(turnTwoRun.status, 0);
  const turnTwoPayload = JSON.parse(turnTwoRun.stdout);
  assert.ok(Array.isArray(turnTwoPayload.injectSteps));
  assert.equal(turnTwoPayload.injectSteps.length, 1);
});

test('Antigravity Stop hook outputs decision: continue and reason per engine specification', async () => {
  const hookPath = path.resolve('scripts/antigravity-vibebox-hook.mjs');
  const env = {
    ...process.env,
    CLAUDE_PLUGIN_ROOT: path.resolve('.')
  };

  // Actionable Stop hook -> decision continue + guidance
  const stopRun = spawnSync(process.execPath, [hookPath, 'Stop'], {
    input: JSON.stringify({
      terminationReason: 'NO_TOOL_CALL',
      executionNum: 1,
      lastUserInput: '함수 리팩토링 해줘',
      conversationId: 'test-convo-stop',
      workspacePaths: [process.cwd()]
    }),
    encoding: 'utf8',
    env
  });

  assert.equal(stopRun.status, 0);
  const stopPayload = JSON.parse(stopRun.stdout);
  assert.equal(stopPayload.decision, 'continue');
  assert.match(stopPayload.reason, /VibeBox aftertask checkpoint/);
  assert.match(stopPayload.reason, /antigravity/i);

  // Stop hook recursion guard (executionNum > 1) -> allows agent termination
  const secondStopRun = spawnSync(process.execPath, [hookPath, 'Stop'], {
    input: JSON.stringify({
      terminationReason: 'NO_TOOL_CALL',
      executionNum: 2,
      lastUserInput: '함수 리팩토링 해줘',
      conversationId: 'test-convo-stop',
      workspacePaths: [process.cwd()]
    }),
    encoding: 'utf8',
    env
  });

  assert.equal(secondStopRun.status, 0);
  const secondStopPayload = JSON.parse(secondStopRun.stdout);
  assert.deepEqual(secondStopPayload, {});
});

test('Hermes hook entrypoint outputs guidance attributed to hermes', async () => {
  const hookPath = path.resolve('scripts/hermes-vibebox-hook.mjs');
  const env = {
    ...process.env,
    CLAUDE_PLUGIN_ROOT: path.resolve('.')
  };

  const stopRun = spawnSync(process.execPath, [hookPath, 'Stop'], {
    input: JSON.stringify({
      hook_event_name: 'Stop',
      lastUserInput: '버그 수정',
      cwd: process.cwd()
    }),
    encoding: 'utf8',
    env
  });

  assert.equal(stopRun.status, 0);
  const payload = JSON.parse(stopRun.stdout);
  assert.equal(payload.decision, 'block');
  assert.match(payload.reason, /VibeBox aftertask checkpoint/);
  assert.match(payload.reason, /hermes/i);
});

test('Hermes python adapter invokes hook and retrieves active context via python', () => {
  const pythonRun = spawnSync('python', [
    path.resolve('adapters/hermes/vibebox_hermes_hook.py'),
    '함수 리팩토링 및 테스트 코드 작성'
  ], {
    encoding: 'utf8'
  });

  assert.equal(pythonRun.status, 0);
  const payload = JSON.parse(pythonRun.stdout);
  assert.ok(payload.context);
  assert.match(payload.context, /VibeBox/);

  // Casual greeting -> empty dict
  const casualRun = spawnSync('python', [
    path.resolve('adapters/hermes/vibebox_hermes_hook.py'),
    '안녕하세요'
  ], {
    encoding: 'utf8'
  });

  assert.equal(casualRun.status, 0);
  const casualPayload = JSON.parse(casualRun.stdout);
  assert.deepEqual(casualPayload, {});
});

test('setupAntigravity configures shim and executes cleanly through shell', async () => {
  const tmpDir = path.resolve('.tmp-setup-test');
  const tmpHooksPath = path.join(tmpDir, 'hooks.json');
  // Unique per run: the Antigravity dedupe state is keyed by conversationId and lives in
  // the OS temp dir, so a fixed id makes the assertion below pass only on a clean machine.
  const conversationId = `shell-test-convo-${process.pid}-${Date.now()}`;
  const dedupeFile = path.join(tmpdir(), `vibebox_agy_dedupe_${conversationId}.json`);
  try {
    const result = await setupAntigravity({ hooksPath: tmpHooksPath });
    assert.equal(result.agent, 'antigravity');
    assert.equal(result.changed, true);
    assert.ok(existsSync(tmpHooksPath));
    assert.ok(result.shimPath);
    assert.ok(existsSync(result.shimPath));

    const content = JSON.parse(readFileSync(tmpHooksPath, 'utf8'));
    assert.ok(content.vibebox);
    assert.ok(content.vibebox.PreInvocation);
    assert.ok(content.vibebox.Stop);

    const preCommand = content.vibebox.PreInvocation[0].command;
    assert.match(preCommand, /vibebox-hook\.(cmd|sh)\s+PreInvocation/);

    // Actually execute the registered hook command in the shell (cmd /c on win32, sh -c on unix)
    const isWin = process.platform === 'win32';
    const shell = isWin ? 'cmd.exe' : '/bin/sh';
    const shellArgs = isWin ? ['/c', preCommand] : ['-c', preCommand];

    const shellExec = spawnSync(shell, shellArgs, {
      cwd: tmpDir,
      input: JSON.stringify({
        lastUserInput: '함수 리팩토링 해줘',
        conversationId,
        initialNumSteps: 0,
        workspacePaths: [process.cwd()]
      }),
      encoding: 'utf8'
    });

    assert.equal(shellExec.status, 0, `Hook execution failed: ${shellExec.stderr}`);
    const shellPayload = JSON.parse(shellExec.stdout);
    assert.ok(Array.isArray(shellPayload.injectSteps));
    assert.equal(shellPayload.injectSteps.length, 1);
  } finally {
    if (existsSync(tmpDir)) {
      rmSync(tmpDir, { recursive: true, force: true });
    }
    if (existsSync(dedupeFile)) {
      rmSync(dedupeFile, { force: true });
    }
  }
});

test('aftertask guidance follows the host agent shell, not the OS', () => {
  const cli = 'D:/x/bin/vibebox.mjs';

  // Claude Code and Codex run tool commands in a POSIX shell even on Windows.
  assert.match(
    aftertaskGuidance(cli, 'claude'),
    /Then run `VIBEBOX_AGENT_RUNTIME=claude node/
  );
  assert.match(
    aftertaskGuidance(cli, 'codex'),
    /Then run `VIBEBOX_AGENT_RUNTIME=codex node/
  );

  // Antigravity executes tool commands through cmd.exe on Windows only.
  const antigravityText = aftertaskGuidance(cli, 'antigravity');
  if (process.platform === 'win32') {
    assert.match(antigravityText, /Then run `set VIBEBOX_AGENT_RUNTIME=antigravity && node/);
    assert.match(antigravityText, /\(In bash\/git-bash: `VIBEBOX_AGENT_RUNTIME=antigravity node/);
  } else {
    assert.match(antigravityText, /Then run `VIBEBOX_AGENT_RUNTIME=antigravity node/);
  }
});

test('Plugin sync ensures plugins/vibebox/hooks.json exists and matches adapter', () => {
  const adapterHooks = path.resolve('adapters/antigravity/hooks.json');
  const pluginHooks = path.resolve('plugins/vibebox/hooks.json');

  assert.ok(existsSync(adapterHooks));
  assert.ok(existsSync(pluginHooks));
  assert.equal(
    readFileSync(adapterHooks, 'utf8').trim(),
    readFileSync(pluginHooks, 'utf8').trim()
  );
});
