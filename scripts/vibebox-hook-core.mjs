import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const MAX_CONTEXT_CHARS = 9000;

export function isActionableTask(prompt) {
  if (!prompt || typeof prompt !== 'string') {
    return false;
  }
  const trimmed = prompt.trim();
  if (!trimmed) {
    return false;
  }

  // 1. Filter out pure conversational pleasantries, greetings, and acknowledgments
  const casualPattern = /^(?:안녕(?:하세요|하십니까)?|하이|반가워|hello|hi|hey|good\s+morning|고마워(?:요)?|감사합니다|thank\s+you|thanks|수고했어|수고하세요|ok|okay|네|예|알겠어(?:요)?|확인|좋아(?:요)?)[.!?~^ ]*$/i;
  if (casualPattern.test(trimmed)) {
    return false;
  }

  // 2. Filter out pure translation requests (unless containing explicit code snippets or file names)
  const hasCodeOrFilePath = /```|\.(?:m?[jt]sx?|py|rs|go|rb|json|ya?ml|toml|sql|html|css)\b|[\\/][\w.-]+\.[a-z0-9]+/i.test(trimmed);
  const translationPattern = /^(?:(?:please\s+)?translate\b|can you translate\b|could you translate\b|번역(?:해\s*(?:줘|봐|주세요)|해|하기)?)/i;
  if (!hasCodeOrFilePath && (translationPattern.test(trimmed) || /(?:문서|문장|텍스트|단락|paragraph|text|sentence)\s*번역/i.test(trimmed))) {
    return false;
  }

  // 3. Filter out general non-coding definition or trivia questions
  const generalQuestionPattern = /^(?:what (?:does|is|are|was|were)\b|who (?:is|are|was|were)\b|where is\b|when (?:did|is)\b)/i;
  if (!hasCodeOrFilePath && generalQuestionPattern.test(trimmed) && !/(?:code|function|class|test|file|git|npm|repo|bug|error|script|vibebox|api|endpoint|syntax|method|variable|object)/i.test(trimmed)) {
    return false;
  }

  // 4. Definite code, command, syntax, or technical keywords (strictly avoiding ambiguous generic words like go, pr, case, from, if, it, store)
  const codeIndicatorPattern = /(?:```|\b(?:git\s+[a-z]+|npm|pnpm|yarn|pip|cargo|docker|diff|patch|commit|push|pull|branch|merge|lint|typecheck|build|bundle|compile|deploy|debug|bugfix|refactor|schema|api|endpoint|sql|migration|vibebox)\b|\.(?:m?[jt]sx?|py|rs|go|rb|php|java|c|cpp|h|hpp|cs|json|ya?ml|toml|sql|html|css|scss|md|sh|bash|ps1|bat|cmd)\b|[\\/][\w.-]+\.[a-z0-9]+|[{}<>[\];$=])/i;
  if (codeIndicatorPattern.test(trimmed)) {
    return true;
  }

  // 5. Korean direct action imperatives and defect/problem statements
  const koreanActionPattern = /(?:고쳐|수정|변경|바꿔|만들어|작성|구현|설계|추가|제거|삭제|리팩토링|빌드|배포|해결|최적화|패치|연동|디버깅|안\s*돼|안\s*되|왜\s*(?:안\s*돼|안\s*되|에러|오류|이래|그래|실패)|(?:버그|에러|오류|익셉션|크래시)\s*(?:가\s*)?(?:해결|수정|고쳐|잡아|발생|터져|있|생겼|나(?![가-힣])|나(?:[면고서도니야지]|는데|네요|니다))|테스트\s*(?:작성|추가|수정|실행|해|통과|실패|코드|케이스))/i;
  if (koreanActionPattern.test(trimmed)) {
    return true;
  }

  // 6. Korean technical/development nouns with action intent
  const koreanTechKeywordPattern = /(?:코드|함수|컴포넌트|테스트|빌드|배포|버그|에러|오류|구현|설계|리팩토링|패키지|스크립트|저장소|레포|커밋|브랜치|모듈|파일|디렉토리|설정|파이프라인|패치|강화|연동)/i;
  const koreanActionVerbPattern = /(?:해줘|해봐|해\s*주세요|열어봐|확인해|실행|정리|조사|찾아|알려줘|어떻게|왜|설명|비교|평가|리뷰)/i;
  if (koreanTechKeywordPattern.test(trimmed) && koreanActionVerbPattern.test(trimmed)) {
    return true;
  }
  if (koreanTechKeywordPattern.test(trimmed) && /(?:강화|추가|제거|설정|패치|연동)/i.test(trimmed) && trimmed.length < 30) {
    return true;
  }

  // 7. English actionable development imperatives paired with technical nouns
  const englishActionPattern = /\b(?:create|make|write|edit|modify|change|update|add|remove|delete|fix|implement|design|analyze|check|verify|validate|inspect|audit|review|run|test|build|deploy|investigate|refactor|optimize|benchmark|profile|trace|reproduce|debug|clean|format|sync|migrate|init|setup|configure|install)\b/i;
  const englishDevNounPattern = /\b(?:code|function|method|class|interface|type|test|spec|bug|issue|defect|feature|component|file|folder|dir|directory|hook|endpoint|api|script|repo|repository|workspace|package|plugin|module|runtime|dependency|dependencies|store|cache|vault|error|failure|logic|crash|syntax|schema|migration|build|pipeline|branch|commit|pr|diff|patch)\b/i;
  if (englishActionPattern.test(trimmed) && englishDevNounPattern.test(trimmed)) {
    return true;
  }

  return false;
}

export function resolveAgentRuntime(options = {}) {
  if (process.env.VIBEBOX_AGENT_RUNTIME) {
    return process.env.VIBEBOX_AGENT_RUNTIME;
  }
  // When running under Codex, detect any Codex environment signals
  const isCodexEnv = Boolean(
    process.env.CODEX_THREAD_ID ||
    process.env.CODEX_SANDBOX ||
    process.env.CODEX_CLI ||
    process.env.CODEX_VERSION ||
    process.env.OPENAI_CODEX
  );
  if (isCodexEnv) {
    return 'codex';
  }
  if (options.defaultRuntime) {
    return options.defaultRuntime;
  }
  if (process.env.ANTIGRAVITY_AGENT || process.env.AGY_VERSION) {
    return 'antigravity';
  }
  if (process.env.CLAUDE_PLUGIN_ROOT || process.env.CLAUDE_CODE_ENTRYPOINT) {
    return 'claude';
  }
  return 'claude';
}

export function truncate(text) {
  if (!text || text.length <= MAX_CONTEXT_CHARS) {
    return text || '';
  }
  return `${text.slice(0, MAX_CONTEXT_CHARS)}\n...[truncated by VibeBox hook]`;
}

export function readStdin() {
  return new Promise((resolveInput) => {
    let input = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => {
      input += chunk;
    });
    process.stdin.on('end', () => resolveInput(input));
    process.stdin.on('error', () => resolveInput(input));
  });
}

export function initializationGuidance(vibeboxCli) {
  return [
    'VibeBox global store is not initialized.',
    'Before repository work, infer the user-facing language from the current user conversation and choose its exact canonical BCP 47 tag. Do not hardcode Korean, English, or the operating-system locale.',
    `Run \`node "${vibeboxCli}" schema --format json --language <user-language-tag>\` and use initialization.displayTemplate to generate every required template value in that same user language.`,
    `Then run \`node "${vibeboxCli}" init --language <user-language-tag> --display-template-file <generated-template.json>\`.`,
    `After initialization succeeds, run \`node "${vibeboxCli}" pretask --task "<current user request>"\` before continuing.`,
    'Do not run bare init for a non-English user language, and do not substitute English display text.'
  ].join('\n');
}

export function aftertaskGuidance(vibeboxCli, runtime) {
  const isWin32 = process.platform === 'win32';
  const aftertaskArgs = 'aftertask --request "<original user request or faithful summary>" --summary "..." --candidates-file <structured-candidates.json> --technical-outcome success|failure|partial|unknown --user-acceptance accepted|rejected|mixed|unknown';
  const cmdCmd = `set VIBEBOX_AGENT_RUNTIME=${runtime} && node "${vibeboxCli}" ${aftertaskArgs}`;
  const pwshCmd = `$env:VIBEBOX_AGENT_RUNTIME="${runtime}"; node "${vibeboxCli}" ${aftertaskArgs}`;
  const bashCmd = `VIBEBOX_AGENT_RUNTIME=${runtime} node "${vibeboxCli}" ${aftertaskArgs}`;

  // The host shell is a property of the agent, not of the OS: Antigravity executes
  // tool commands through cmd.exe on Windows, while Claude Code and Codex run their
  // commands in a POSIX shell (git-bash) even on Windows.
  const primaryCmd = isWin32 && runtime === 'antigravity' ? cmdCmd : bashCmd;
  const altHints = [];
  if (primaryCmd !== bashCmd) altHints.push(`(In bash/git-bash: \`${bashCmd}\`)`);
  if (primaryCmd !== cmdCmd) altHints.push(`(In cmd.exe: \`${cmdCmd}\`)`);
  if (primaryCmd !== pwshCmd) altHints.push(`(In PowerShell: \`${pwshCmd}\`)`);

  return [
    'VibeBox aftertask checkpoint.',
    'Do not stop yet if this turn performed meaningful coding, documentation, packaging, review, validation, or debugging work and the user did not opt out.',
    `Run \`node "${vibeboxCli}" schema --format json\` before writing candidate JSON.`,
    `Then run \`${primaryCmd}\`.`,
    altHints.join(' '),
    'The schema reads the configured memoryLanguage. Write displayTitle, displaySummary, and displayRule in that exact user language and set displayLanguage to the exact schema value; Core rejects missing or mismatched display fields.',
    `Ensure agent runtime is set (e.g. \`VIBEBOX_AGENT_RUNTIME=${runtime}\`) so memory attribution is recorded correctly.`,
    'The AI agent must provide structured candidates for reusable memory. Core will not infer active memory from raw summaries.',
    'If no durable memory exists, submit no_reusable_memory_candidate with noCandidateReason instead of skipping the checkpoint.'
  ].join('\n');
}

const DEDUPE_FILE_PREFIX = 'vibebox_agy_dedupe_';
const DEDUPE_MAX_AGE_MS = 24 * 60 * 60 * 1000;

function pruneStaleDedupeFiles(prefix, maxAgeMs) {
  try {
    const directory = tmpdir();
    const now = Date.now();
    for (const entry of readdirSync(directory)) {
      if (!entry.startsWith(prefix)) {
        continue;
      }
      const target = resolve(directory, entry);
      try {
        if (now - statSync(target).mtimeMs > maxAgeMs) {
          unlinkSync(target);
        }
      } catch {
        // Ignore files that disappear or are locked.
      }
    }
  } catch {
    // Ignore cache directory access issues.
  }
}

function shouldSkipAntigravityPreInvocation(input, prompt) {
  if (!input.conversationId) {
    return false;
  }
  const safeId = String(input.conversationId).replace(/[^a-zA-Z0-9_-]/g, '');
  const dedupeFile = resolve(tmpdir(), `${DEDUPE_FILE_PREFIX}${safeId}.json`);
  const initialSteps = input.initialNumSteps ?? '';
  try {
    if (existsSync(dedupeFile)) {
      const data = JSON.parse(readFileSync(dedupeFile, 'utf8'));
      if (data.lastPrompt === prompt && data.lastInitialSteps === initialSteps) {
        return true;
      }
    }
    writeFileSync(dedupeFile, JSON.stringify({
      lastPrompt: prompt,
      lastInitialSteps: initialSteps,
      timestamp: Date.now()
    }), 'utf8');
    pruneStaleDedupeFiles(DEDUPE_FILE_PREFIX, DEDUPE_MAX_AGE_MS);
  } catch {
    // Ignore cache access issues gracefully
  }
  return false;
}

export async function runHook(options = {}) {
  const callerUrl = options.callerUrl || import.meta.url;
  const scriptDir = dirname(fileURLToPath(callerUrl));
  const pluginRoot = process.env.CLAUDE_PLUGIN_ROOT || resolve(scriptDir, '..');
  const vibeboxCli = resolve(pluginRoot, 'bin', 'vibebox.mjs');
  const vibeboxStore = resolve(process.env.VIBEBOX_HOME || resolve(homedir(), '.vibebox'));
  const runtime = resolveAgentRuntime(options);

  function runVibeBox(args, cwd) {
    const result = spawnSync(process.execPath, [vibeboxCli, ...args], {
      cwd: cwd || process.cwd(),
      env: {
        ...process.env,
        VIBEBOX_AGENT_RUNTIME: runtime
      },
      encoding: 'utf8',
      maxBuffer: 1024 * 1024
    });

    return {
      status: result.status,
      stdout: result.stdout || '',
      stderr: result.stderr || '',
      error: result.error
    };
  }

  const rawInput = await readStdin();
  let input = {};

  try {
    input = rawInput.trim() ? JSON.parse(rawInput) : {};
  } catch {
    input = {};
  }

  // Detect protocol: Antigravity vs Claude/Codex
  const isAntigravity = options.protocol === 'antigravity' || (
    options.protocol !== 'claude' && (
      input.terminationReason !== undefined ||
      input.invocationNum !== undefined ||
      (input.conversationId !== undefined && input.lastUserInput !== undefined && input.hook_event_name === undefined)
    )
  );

  // Resolve event name cleanly
  let eventName = options.forcedEvent || input.hook_event_name;
  if (!eventName) {
    if (input.terminationReason !== undefined || input.stop_hook_active !== undefined) {
      eventName = 'Stop';
    } else if (input.invocationNum !== undefined || input.initialNumSteps !== undefined) {
      eventName = 'PreInvocation';
    } else if (input.prompt !== undefined) {
      eventName = 'UserPromptSubmit';
    } else if (input.lastUserInput !== undefined) {
      eventName = 'PreInvocation';
    } else {
      eventName = 'PreInvocation';
    }
  }

  // Helper emitters
  function emitClaudeContext(event, additionalContext) {
    process.stdout.write(JSON.stringify({
      hookSpecificOutput: {
        hookEventName: event,
        additionalContext: truncate(additionalContext)
      }
    }));
  }

  function emitClaudeBlock(event, reason) {
    const message = truncate(reason);
    process.stdout.write(JSON.stringify({
      decision: 'block',
      reason: message,
      hookSpecificOutput: {
        hookEventName: event,
        additionalContext: message
      }
    }));
  }

  function emitAntigravityContext(contextText) {
    process.stdout.write(JSON.stringify({
      injectSteps: [
        {
          systemMessage: {
            systemMessage: truncate(contextText)
          }
        }
      ]
    }));
  }

  // Handle Prompt / PreInvocation
  if (eventName === 'UserPromptSubmit' || eventName === 'PreInvocation') {
    const prompt = typeof input.prompt === 'string'
      ? input.prompt.trim()
      : (typeof input.lastUserInput === 'string' ? input.lastUserInput.trim() : '');

    if (!prompt) {
      if (isAntigravity) {
        process.stdout.write(JSON.stringify({ injectSteps: [] }));
      }
      process.exit(0);
    }

    // Apply actionable task gating
    if (!isActionableTask(prompt)) {
      if (isAntigravity) {
        process.stdout.write(JSON.stringify({ injectSteps: [] }));
      }
      process.exit(0);
    }

    // Dedupe check for Antigravity: avoid re-injecting during secondary tool-invocation steps within the same turn
    if (isAntigravity && shouldSkipAntigravityPreInvocation(input, prompt)) {
      process.stdout.write(JSON.stringify({ injectSteps: [] }));
      process.exit(0);
    }

    if (!existsSync(resolve(vibeboxStore, 'config.json'))) {
      const guidance = initializationGuidance(vibeboxCli);
      if (isAntigravity) {
        emitAntigravityContext(guidance);
      } else {
        emitClaudeContext('UserPromptSubmit', guidance);
      }
      process.exit(0);
    }

    const targetCwd = input.cwd || (Array.isArray(input.workspacePaths) && input.workspacePaths[0]) || process.cwd();
    const result = runVibeBox(['pretask', '--task', prompt], targetCwd);
    const pretaskFailure = `${result.stderr}${result.stdout}`;

    if (result.status !== 0 && /global store not found|ENOENT|no such file or directory/iu.test(pretaskFailure)) {
      const guidance = initializationGuidance(vibeboxCli);
      if (isAntigravity) {
        emitAntigravityContext(guidance);
      } else {
        emitClaudeContext('UserPromptSubmit', guidance);
      }
      process.exit(0);
    }

    if (result.status === 0) {
      const context = [
        'VibeBox pretask retrieved active memory for this user request.',
        'Apply this guidance before planning or editing. The current user request still wins over older memory.',
        '',
        result.stdout.trim()
      ].join('\n');

      if (isAntigravity) {
        emitAntigravityContext(context);
      } else {
        emitClaudeContext('UserPromptSubmit', context);
      }
      process.exit(0);
    }

    const failureContext = [
      'VibeBox pretask could not read active memory for this request.',
      'Do not create workspace-local memory snapshots or fallback stores.',
      'If repository work proceeds, report that VibeBox guidance was unavailable when relevant.',
      '',
      result.error ? String(result.error.message || result.error) : `${result.stderr}${result.stdout}`.trim()
    ].join('\n');

    if (isAntigravity) {
      emitAntigravityContext(failureContext);
    } else {
      emitClaudeContext('UserPromptSubmit', failureContext);
    }
    process.exit(0);
  }

  // Handle Stop / Aftertask
  if (eventName === 'Stop') {
    // If Claude stop recursion guard
    if (input.stop_hook_active) {
      process.exit(0);
    }

    // Antigravity Stop protocol contract
    if (isAntigravity) {
      // Loop protection: allow exit if already forced continuation once or if aborted/errored
      if ((input.executionNum && input.executionNum > 1) ||
          input.terminationReason === 'MAX_FORCED_INVOCATIONS' ||
          input.terminationReason === 'USER_CANCELED' ||
          input.terminationReason === 'ERROR') {
        process.stdout.write(JSON.stringify({}));
        process.exit(0);
      }

      // If user input is available and was not actionable, allow exit immediately
      const prompt = typeof input.lastUserInput === 'string' ? input.lastUserInput.trim() : '';
      if (prompt && !isActionableTask(prompt)) {
        process.stdout.write(JSON.stringify({}));
        process.exit(0);
      }

      const guidance = aftertaskGuidance(vibeboxCli, runtime);
      process.stdout.write(JSON.stringify({
        decision: 'continue',
        reason: truncate(guidance)
      }));
      process.exit(0);
    }

    // Claude / Codex Stop protocol contract
    const prompt = typeof input.lastUserInput === 'string' ? input.lastUserInput.trim() : '';
    if (prompt && !isActionableTask(prompt)) {
      process.exit(0);
    }

    const guidance = aftertaskGuidance(vibeboxCli, runtime);
    emitClaudeBlock('Stop', guidance);
    process.exit(0);
  }

  if (isAntigravity) {
    process.stdout.write(JSON.stringify({ injectSteps: [] }));
  }
  process.exit(0);
}
