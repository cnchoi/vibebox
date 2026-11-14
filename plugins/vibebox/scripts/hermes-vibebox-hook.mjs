import { runHook } from './vibebox-hook-core.mjs';

const forcedEvent = process.argv[2];

await runHook({
  protocol: 'claude',
  defaultRuntime: 'hermes',
  forcedEvent,
  callerUrl: import.meta.url
});
