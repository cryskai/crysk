// odd/tasks/antigravity-oauth.md T4b (S5, L17 A4): `grep`'s regex runs in a
// Bun Worker, so a pattern that backtracks for ever can be stopped. A running
// JavaScript regex cannot be interrupted from its own thread; terminating the
// worker can, and the server's thread stays free to answer.
//
// The worker's source is inline and imports nothing: the release binary is
// `bun build --compile src/cli.ts` with no second entrypoint, so a worker file
// would not be in it. Walking, confinement and reading stay on the server's
// thread (confine.ts); the worker only receives file text and returns the
// matching lines.
//
// Measured on Bun 1.4.4: JavaScriptCore gives up on one catastrophic match
// attempt after about 250 ms and reports no match, so one line never hangs;
// many such lines do, and that sum is what the budget bounds.

const WORKER_SOURCE = `
let regex;
self.onmessage = (event) => {
  const message = event.data;
  if (message.type === "init") {
    regex = new RegExp(message.pattern, message.flags);
    return;
  }
  const matches = [];
  let more = false;
  scan: for (let file = 0; file < message.texts.length; file++) {
    const lines = message.texts[file].split("\\n");
    for (let index = 0; index < lines.length; index++) {
      let line = lines[index];
      if (line.endsWith("\\r")) line = line.slice(0, -1);
      if (!regex.test(line)) continue;
      if (matches.length >= message.limit) {
        more = true;
        break scan;
      }
      matches.push([
        file,
        index + 1,
        line.length > message.keepChars ? line.slice(0, message.keepChars) : line,
      ]);
    }
  }
  postMessage({ matches, more });
};
`;

let workerUrl: string | undefined;

function sourceUrl(): string {
  workerUrl ??= URL.createObjectURL(
    new Blob([WORKER_SOURCE], { type: "application/javascript" }),
  );
  return workerUrl;
}

// One matching line: index of its text in the batch, 1-based line number,
// and the line, cut at keepChars.
export type RegexMatch = readonly [number, number, string];

export interface BatchResult {
  readonly matches: readonly RegexMatch[];
  // More matches existed past `limit`.
  readonly more: boolean;
}

export class RegexTimeout extends Error {}

// One grep call's worker. Every batch spends from one wall-clock budget; past
// it the worker is terminated and match() throws RegexTimeout.
export class RegexWorker {
  private readonly worker: Worker;
  private spentMs = 0;
  private closed = false;

  constructor(
    pattern: string,
    flags: string,
    private readonly budgetMs: number,
    private readonly keepChars: number,
  ) {
    this.worker = new Worker(sourceUrl());
    this.worker.postMessage({ type: "init", pattern, flags });
  }

  match(texts: readonly string[], limit: number): Promise<BatchResult> {
    const left = this.budgetMs - this.spentMs;
    if (this.closed || left <= 0) {
      this.close();
      return Promise.reject(new RegexTimeout());
    }
    const started = performance.now();
    return new Promise<BatchResult>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.close();
        reject(new RegexTimeout());
      }, left);
      this.worker.onmessage = (event: MessageEvent<BatchResult>) => {
        clearTimeout(timer);
        this.spentMs += performance.now() - started;
        resolve(event.data);
      };
      this.worker.onerror = () => {
        clearTimeout(timer);
        this.close();
        reject(new Error("regex worker failed"));
      };
      this.worker.postMessage({
        type: "batch",
        texts,
        limit,
        keepChars: this.keepChars,
      });
    });
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.worker.terminate();
  }
}
