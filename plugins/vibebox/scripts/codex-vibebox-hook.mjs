import { runHook } from './vibebox-hook-core.mjs';

await runHook({
  protocol: 'claude',
  defaultRuntime: 'codex',
  callerUrl: import.meta.url
});
