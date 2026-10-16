// Generic CLI error classes, shared by every domain. Neither is review logic:
// a usage mistake or a runtime failure (git, gh, the filesystem) can surface
// from any I/O shell, so both live in this neutral, dependency-free module
// instead of being owned by whichever shell happened to throw them first.
// C1 git-layering slice: moved out of review/preflight.ts, which still
// re-exports both for the ~55 existing consumers (see the re-export note
// there).
//
// The one import below is type-only, erased at transpile time, so this module
// stays free of runtime dependencies. The class an error names is the record
// class the CI writes to cli.json (odd/tasks/agent-first-ci.md, T2d-1).

import type { CliErrorClass } from "./ci/outcome";

// The class a throw site names is optional: a CliUsageError without one is
// classified as unknown, exactly as before. The message never changes with it.
export interface CliErrorOptions {
  cls?: CliErrorClass;
}

export class CliUsageError extends Error {
  readonly cls: CliErrorClass | undefined;

  constructor(message: string, options: CliErrorOptions = {}) {
    super(message);
    this.cls = options.cls;
  }
}

// Runtime failure (git, gh, the filesystem) as opposed to a usage error.
// Defined here rather than in a shell so every I/O shell (cli.ts, pr/pr.ts,
// and others) can throw the same class without importing each other.
export class CliError extends Error {
  readonly cls: CliErrorClass | undefined;

  constructor(message: string, options: CliErrorOptions = {}) {
    super(message);
    this.cls = options.cls;
  }
}

// The record class of an error that is not a CliError. main() in src/cli.ts prints a
// CliError as one line and lets every other error take the uncaught-exception path,
// which local runs have always used. Such an error must stay the object it was thrown
// as: same type, same message, same stack, so the excerpt Bun prints still points at
// the throw site. Its class therefore sits beside it, in a WeakMap. An own property
// would not do: the uncaught print shows every enumerable property of an error.
const recordClasses = new WeakMap<object, CliErrorClass>();

export function withRecordClass<T>(error: T, cls: CliErrorClass): T {
  if (typeof error === "object" && error !== null) {
    recordClasses.set(error, cls);
  }
  return error;
}

export function recordClassOf(error: unknown): CliErrorClass | undefined {
  return typeof error === "object" && error !== null
    ? recordClasses.get(error)
    : undefined;
}

// A parser's boundary: every CliUsageError thrown inside `parse` that carries no
// class gets `cls`, with the same message. The parser's own throws and their
// messages stay as they are, and errors that are not usage errors pass through
// unchanged. WHY at the boundary and not per throw: one parser's throws are one
// kind of failure, and the class depends on which parser was asked (the repo
// layer, the routing object, the extra hunters), not on the throw.
export function withUsageClass<T>(cls: CliErrorClass, parse: () => T): T {
  try {
    return parse();
  } catch (error) {
    if (error instanceof CliUsageError && error.cls === undefined) {
      throw new CliUsageError(error.message, { cls });
    }
    throw error;
  }
}
