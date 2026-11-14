import { runHook } from './vibebox-hook-core.mjs';

await runHook({
  protocol: 'claude',
  defaultRuntime: 'claude',
  callerUrl: import.meta.url
});
