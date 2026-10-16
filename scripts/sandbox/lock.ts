// The run lock's policy: one scenario invocation at a time on this machine. The
// lock file is created exclusively, so two invocations that race cannot both take it
// (a check-then-create would let both pass). A lock whose recorded process is gone is
// stale and is taken over; a lock that is held by a live process, or that names no
// pid, refuses the start. Pure over the port, so the real file and a test's memory
// share one policy.

import type { RunLockFile } from "./ports";

export type LockAttempt =
  | { held: true; takenOverFrom?: number }
  | { held: false; reason: string };

export async function acquireRunLock(lock: RunLockFile): Promise<LockAttempt> {
  if (await lock.create()) return { held: true };
  const holder = await lock.holder();
  if (holder.kind === "none") {
    // Released between the failed create and this read: one fresh attempt.
    if (await lock.create()) return { held: true };
    return refused(lock.path, "another run took it while this one started");
  }
  // Refused rather than taken over: a file that names no pid may be a start that
  // is still writing it, so only a person can say it is stale.
  if (holder.kind === "unreadable") {
    return refused(
      lock.path,
      "it names no pid (an interrupted start, or a file someone else wrote); remove it if no run is in progress",
    );
  }
  if (lock.alive(holder.pid)) {
    return refused(lock.path, `pid ${holder.pid} holds it and is running`);
  }
  // The recorded process is gone, so the lock is stale. The remove is guarded by
  // the pid, so a lock written meanwhile by a live run is not removed.
  await lock.remove(holder.pid);
  if (await lock.create()) return { held: true, takenOverFrom: holder.pid };
  return refused(
    lock.path,
    "another run took it while the stale lock was cleared",
  );
}

// Removes the lock this process took. The remove is guarded by this process's pid,
// so a lock another run took after this one released is left alone.
export async function releaseRunLock(lock: RunLockFile): Promise<void> {
  await lock.remove(lock.pid);
}

function refused(path: string, why: string): LockAttempt {
  return {
    held: false,
    reason: `${path} is locked: ${why}. Sandbox runs are serialized, so wait for the other run or clean up before starting.`,
  };
}
