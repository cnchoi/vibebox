import { runHook } from './vibebox-hook-core.mjs';

const forcedEvent = process.argv[2];

await runHook({
  protocol: 'antigravity',
  defaultRuntime: 'antigravity',
  forcedEvent,
  callerUrl: import.meta.url
});
