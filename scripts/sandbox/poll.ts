// The interrupt layer of the scenario runner. The first SIGINT or SIGTERM of an
// invocation ends the scenario's waits and work at once, and that scenario's cleanup
// then runs as after a normal end, so an operator's Ctrl-C never leaves a scenario PR
// behind. A second signal ends the cleanup's waits too: cleanup then reports what it
// may have left open and gives up. The waits themselves live in runs.ts; this file
// only decides which signal stops which wait.

import type { SandboxDeps, Signal, SignalSource } from "./ports";
import { Interrupted, type Stop, throwIfStopped } from "./runs";

// The exit codes of an interrupted invocation, the shell's convention for the
// signal (128 + number), so a wrapper can tell an interrupt from a failure.
export const SIGNAL_EXIT_CODES: Record<Signal, number> = {
  SIGINT: 130,
  SIGTERM: 143,
};

export interface Interrupts {
  // Ends the scenario's work. Its first signal is the one that interrupts it.
  readonly scenario: Stop;
  // Ends cleanup's waits. Its second signal is the one that abandons them.
  readonly cleanup: Stop;
  // The first signal of the invocation, if any.
  received(): Signal | undefined;
  // Marks the start of one scenario's work, and of its cleanup. A first signal that
  // lands during cleanup is reported and does not interrupt anything: the work it
  // would stop has already ended.
  enterScenario(): void;
  enterCleanup(): void;
  dispose(): void;
}

// Installed for the length of the invocation, so a signal between scenarios stops
// the invocation too.
export function watchInterrupts(
  source: SignalSource,
  log: (line: string) => void,
): Interrupts {
  const received: Signal[] = [];
  let inCleanup = false;
  let wakeScenario!: (error: Error) => void;
  let wakeCleanup!: (error: Error) => void;
  const scenarioWake = new Promise<never>((_, reject) => {
    wakeScenario = reject;
  });
  const cleanupWake = new Promise<never>((_, reject) => {
    wakeCleanup = reject;
  });
  // Nobody may be waiting when a signal lands; that must not be an unhandled rejection.
  scenarioWake.catch(() => undefined);
  cleanupWake.catch(() => undefined);
  const installed = (["SIGINT", "SIGTERM"] as const).map((signal) => {
    const handler = () => {
      received.push(signal);
      if (received.length === 1) {
        if (inCleanup) {
          log(
            `${signal} received during cleanup: the scenario had already ended, so it does not change the exit code`,
          );
        } else {
          log(`${signal} received: stopping the scenario and cleaning up`);
          wakeScenario(new Interrupted(signal));
        }
      } else if (received.length === 2) {
        log(`${signal} received again: abandoning the cleanup wait`);
        wakeCleanup(new Interrupted(signal));
      }
    };
    source.on(signal, handler);
    return { signal, handler };
  });
  return {
    scenario: { signal: () => received[0], wake: scenarioWake },
    cleanup: { signal: () => received[1], wake: cleanupWake },
    received: () => received[0],
    enterScenario: () => {
      inCleanup = false;
    },
    enterCleanup: () => {
      inCleanup = true;
    },
    dispose: () => {
      for (const { signal, handler } of installed) source.off(signal, handler);
    },
  };
}

// The work after a signal makes no new call, so nothing is created once cleanup
// has begun: a PR opened after the close would be left behind. The caller keeps
// the unwrapped deps for cleanup, which must still run.
export function stopAfterInterrupt(deps: SandboxDeps, stop: Stop): SandboxDeps {
  return {
    ...deps,
    gh: async (args) => {
      throwIfStopped(stop);
      return deps.gh(args);
    },
    git: async (args, cwd) => {
      throwIfStopped(stop);
      return deps.git(args, cwd);
    },
  };
}
