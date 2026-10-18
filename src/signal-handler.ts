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
