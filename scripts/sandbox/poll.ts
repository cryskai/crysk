// Polling and interrupts for the scenario runner. A poll reads GitHub until a
// run is done or a deadline passes. A SIGINT or SIGTERM ends every wait at once,
// and the scenario's cleanup then runs in its finally (scenario.ts), so an
// operator's Ctrl-C never leaves a scenario PR behind.

import type { SandboxDeps, Signal, SignalSource } from "./ports";

// Consecutive failed reads before a poll gives up. One transient gh error must
// not tear the PR down while the run is in flight.
const MAX_CONSECUTIVE_POLL_FAILURES = 5;

// The exit codes of an interrupted invocation, the shell's convention for the
// signal (128 + number), so a wrapper can tell an interrupt from a failure.
export const SIGNAL_EXIT_CODES: Record<Signal, number> = {
  SIGINT: 130,
  SIGTERM: 143,
};

export interface PollTiming {
  intervalMs: number;
  timeoutMs: number;
}

// The error a poll must not retry: the read found something it cannot decide,
// such as an ambiguous run, and another identical read would not decide it.
export class Unrecoverable extends Error {
  constructor(message: string) {
    super(message);
    this.name = "Unrecoverable";
  }
}

export class Interrupted extends Error {
  constructor(readonly signal: Signal) {
    super(`interrupted by ${signal}`);
    this.name = "Interrupted";
  }
}

export interface Interrupts {
  // Rejects when a signal arrives, so a sleep in progress wakes at once.
  readonly interrupted: Promise<never>;
  received(): Signal | undefined;
  dispose(): void;
}

// Installed for the length of the invocation. The first signal wins; a second
// one is ignored, so cleanup is never cut short by an impatient Ctrl-C.
export function watchInterrupts(
  source: SignalSource,
  log: (line: string) => void,
): Interrupts {
  let received: Signal | undefined;
  let reject!: (error: Error) => void;
  const interrupted = new Promise<never>((_, rej) => {
    reject = rej;
  });
  // Nobody may be waiting when a signal lands; that must not be an unhandled rejection.
  interrupted.catch(() => undefined);
  const installed = (["SIGINT", "SIGTERM"] as const).map((signal) => {
    const handler = () => {
      if (received !== undefined) return;
      received = signal;
      log(`${signal} received: stopping the scenario and cleaning up`);
      reject(new Interrupted(signal));
    };
    source.on(signal, handler);
    return { signal, handler };
  });
  return {
    interrupted,
    received: () => received,
    dispose: () => {
      for (const { signal, handler } of installed) source.off(signal, handler);
    },
  };
}

function throwIfInterrupted(interrupts: Interrupts | undefined): void {
  const signal = interrupts?.received();
  if (signal !== undefined) throw new Interrupted(signal);
}

function sleepUnlessInterrupted(
  clock: SandboxDeps["clock"],
  ms: number,
  interrupts: Interrupts | undefined,
): Promise<void> {
  return interrupts === undefined
    ? clock.sleep(ms)
    : Promise.race([interrupts.interrupted, clock.sleep(ms)]);
}

// The work after a signal makes no new call, so nothing is created once cleanup
// has begun: a PR opened after the close would be left behind. The caller keeps
// the unwrapped deps for cleanup, which must still run.
export function stopAfterInterrupt(
  deps: SandboxDeps,
  interrupts: Interrupts,
): SandboxDeps {
  return {
    ...deps,
    gh: async (args) => {
      throwIfInterrupted(interrupts);
      return deps.gh(args);
    },
    git: async (args, cwd) => {
      throwIfInterrupted(interrupts);
      return deps.git(args, cwd);
    },
  };
}

// Calls `read` until `done` accepts its value, sleeping between tries. A failed
// read is one miss: only MAX_CONSECUTIVE_POLL_FAILURES in a row end the poll, and
// the last error is thrown then. A read that finds nothing does not reset the
// last value seen, so the caller still learns about a run seen earlier.
export async function pollUntil<T>(
  deps: Pick<SandboxDeps, "clock" | "log">,
  interrupts: Interrupts | undefined,
  timing: PollTiming,
  read: () => Promise<T | undefined>,
  done: (value: T) => boolean,
): Promise<{ done: boolean; last?: T }> {
  const deadline = deps.clock.now().getTime() + timing.timeoutMs;
  let last: T | undefined;
  let failures = 0;
  for (;;) {
    throwIfInterrupted(interrupts);
    try {
      const value = await read();
      failures = 0;
      if (value !== undefined) {
        last = value;
        if (done(value)) return { done: true, last };
      }
    } catch (error) {
      if (error instanceof Interrupted || error instanceof Unrecoverable) {
        throw error;
      }
      failures += 1;
      if (failures >= MAX_CONSECUTIVE_POLL_FAILURES) throw error;
      deps.log(
        `poll read failed (${failures} of ${MAX_CONSECUTIVE_POLL_FAILURES}), retrying: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    if (deps.clock.now().getTime() >= deadline) return { done: false, last };
    await sleepUnlessInterrupted(deps.clock, timing.intervalMs, interrupts);
  }
}
