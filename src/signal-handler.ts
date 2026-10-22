// The signal handlers' shape: the first signal settles and exits with its own
// code; every later one waits for that settle instead of starting another.
export function createSignalHandler(deps: {
  settle: () => Promise<void>;
  exit: (code: number) => void;
}): (exitCode: number) => () => Promise<void> {
  let signalSettle: Promise<void> | null = null;
  return (exitCode) => async () => {
    if (signalSettle !== null) {
      await signalSettle;
      return;
    }
    signalSettle = (async () => {
      await deps.settle();
      deps.exit(exitCode);
    })();
    await signalSettle;
  };
}

// What the first signal settles: stop spending, then release what this
// process holds. The OpenCode server close runs CONCURRENTLY with the lock and
// ledger settles, never ahead of them: a server that ignores SIGTERM takes up
// to its grace plus reap (~4s), Actions sends SIGKILL ~10s after the first
// SIGINT, and those settles make network calls. Serialized, a slow server
// could get the in-flight lock release killed mid-flight, and the next run
// would skip the head for the rest of the 90-minute TTL (#146).
export async function settleOnSignal(deps: {
  killChildren: () => void;
  closeServers: () => Promise<void>;
  unregisterRun: () => Promise<void>;
  settleCommitStatus: () => Promise<void>;
  settleAdmissionLedger: () => Promise<void>;
}): Promise<void> {
  let serversClosed: Promise<void> = Promise.resolve();
  try {
    deps.killChildren();
    serversClosed = deps.closeServers().catch(() => {});
    await deps.unregisterRun();
  } catch {
    // Ignore
  }
  await Promise.all([
    serversClosed,
    (async () => {
      await deps.settleCommitStatus();
      await deps.settleAdmissionLedger();
    })(),
  ]);
}
