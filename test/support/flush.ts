// Let every pending microtask run before the test takes its next step.
//
// WHY setImmediate and not a fixed number of `await Promise.resolve()`: the
// tests that use this drive a ManualClock whose fireAll() fires every pending
// timer at once, whatever its deadline. A step that must settle before the
// next fireAll() therefore has to settle within the flush, and a counted loop
// only waits a fixed number of microtask turns. How many turns a chain of
// promises takes is a runtime detail: on Bun 1.4.4 an event-sink push needed
// more than the 25 turns that passed on Bun 1.3.14, so the transport's stall
// timer won the race in two conformance tests while production (a real 10 s
// deadline) was unaffected. A setImmediate callback runs only after the
// microtask queue is empty, so the wait no longer depends on that count.
export async function flush(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
}
