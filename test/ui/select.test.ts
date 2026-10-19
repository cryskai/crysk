import { describe, expect, test } from "bun:test";
import {
  type ConfirmIo,
  type ConfirmSpec,
  confirmReview,
  confirmSizeGate,
  costHint,
  freeBillingMode,
  type KeyReader,
  menuOptions,
  moveCursor,
  parseKey,
  renderMenu,
  runConfirm,
  runSizeGateConfirm,
  sizeGateMenuOptions,
  splitKeys,
} from "#ui/select";

const ESC = String.fromCharCode(27);
const ANSI = new RegExp(`${ESC}\\[[0-9;]*[A-Za-z]`, "g");
const stripAnsi = (text: string): string => text.replace(ANSI, "");

// A scripted reader: the whole point of injecting one is that every branch of
// the menu is reachable with no TTY anywhere in the process.
function fakeReader(chunks: (string | undefined)[], raw = true): KeyReader {
  let i = 0;
  return {
    raw,
    read: () => Promise.resolve(i < chunks.length ? chunks[i++] : undefined),
    close: () => {
      // The close contract is asserted separately, on confirmReview.
    },
  };
}

function recorder(): ConfirmIo & { lines: () => string[]; text: () => string } {
  const out: string[] = [];
  return {
    write: (text) => out.push(text),
    line: (text = "") => out.push(`${text}\n`),
    lines: () =>
      stripAnsi(out.join(""))
        .split("\n")
        .map((l) => l.trimEnd()),
    text: () => out.join(""),
  };
}

const spec = (over: Partial<ConfirmSpec> = {}): ConfirmSpec => ({
  low: 2.85,
  high: 6.14,
  canSkipPost: false,
  details: () => ["details line one", "details line two"],
  styles: false,
  ...over,
});

describe("splitKeys", () => {
  test("keeps a CSI arrow sequence whole", () => {
    expect(splitKeys(`${ESC}[A`)).toEqual([`${ESC}[A`]);
  });

  test("splits several keys arriving in one chunk", () => {
    expect(splitKeys(`${ESC}[B${ESC}[B\r`)).toEqual([
      `${ESC}[B`,
      `${ESC}[B`,
      "\r",
    ]);
  });

  test("splits plain characters", () => {
    expect(splitKeys("yn")).toEqual(["y", "n"]);
  });
});

describe("parseKey", () => {
  test("arrows, enter in both flavours, escape and ctrl-c", () => {
    expect(parseKey(`${ESC}[A`)).toEqual({ type: "up" });
    expect(parseKey(`${ESC}[B`)).toEqual({ type: "down" });
    expect(parseKey("\r")).toEqual({ type: "enter" });
    expect(parseKey("\n")).toEqual({ type: "enter" });
    expect(parseKey("\x03")).toEqual({ type: "ctrl-c" });
    expect(parseKey(ESC)).toEqual({ type: "escape" });
  });

  test("characters are lowercased, control bytes are ignored", () => {
    expect(parseKey("R")).toEqual({ type: "char", char: "r" });
    expect(parseKey("\t")).toEqual({ type: "ignore" });
    expect(parseKey("\x7f")).toEqual({ type: "ignore" });
    expect(parseKey(`${ESC}[5~`)).toEqual({ type: "ignore" });
  });
});

describe("menuOptions", () => {
  test("without posting, the don't-post option does not exist", () => {
    expect(menuOptions(false).map((o) => o.label)).toEqual([
      "Review it",
      "Show details",
      "Cancel",
    ]);
  });

  test("with posting, it sits second and carries post: false", () => {
    const options = menuOptions(true);
    expect(options.map((o) => o.label)).toEqual([
      "Review it",
      "Review, but don't post",
      "Show details",
      "Cancel",
    ]);
    expect(options[0]?.post).toBe(true);
    expect(options[1]?.post).toBe(false);
  });
});

describe("moveCursor", () => {
  test("wraps at both ends", () => {
    expect(moveCursor(0, -1, 4)).toBe(3);
    expect(moveCursor(3, 1, 4)).toBe(0);
    expect(moveCursor(1, 1, 4)).toBe(2);
  });
});

describe("renderMenu", () => {
  test("only the cursor row carries the pointer, and it is plain text", () => {
    const lines = renderMenu(
      [
        {
          action: "review",
          label: "Review it",
          hint: "$1.00 – $2.00",
          shortcuts: ["r"],
          post: false,
        },
        { action: "cancel", label: "Cancel", shortcuts: ["c"], post: false },
      ],
      0,
      false,
    );
    expect(lines[0]).toContain("❯ Review it");
    expect(lines[0]).toContain("$1.00 – $2.00");
    expect(lines[1]).toBe("    Cancel");
    expect(lines.join("")).not.toContain(ESC);
  });
});

describe("costHint", () => {
  test("two decimals with an en dash", () => {
    expect(costHint(2.85, 6.14)).toBe("$2.85 – $6.14");
  });
});

describe("runConfirm — the menu", () => {
  test("enter on the first row reviews", async () => {
    const io = recorder();
    const result = await runConfirm(spec(), fakeReader(["\r"]), io);
    expect(result).toEqual({ kind: "review", post: false });
  });

  test("with posting, enter on the first row keeps posting on", async () => {
    const io = recorder();
    const result = await runConfirm(
      spec({ canSkipPost: true }),
      fakeReader(["\r"]),
      io,
    );
    expect(result).toEqual({ kind: "review", post: true });
  });

  test("arrow down to the don't-post row disables posting", async () => {
    const io = recorder();
    const result = await runConfirm(
      spec({ canSkipPost: true }),
      fakeReader([`${ESC}[B`, "\r"]),
      io,
    );
    expect(result).toEqual({ kind: "review", post: false });
  });

  test("arrow up wraps to the last row, which cancels", async () => {
    const io = recorder();
    const result = await runConfirm(spec(), fakeReader([`${ESC}[A`, "\r"]), io);
    expect(result).toEqual({ kind: "cancel" });
  });

  test("arrow down past the end wraps back to the first row", async () => {
    const io = recorder();
    // Three options without posting: three downs return to the top.
    const result = await runConfirm(
      spec(),
      fakeReader([`${ESC}[B${ESC}[B${ESC}[B`, "\r"]),
      io,
    );
    expect(result).toEqual({ kind: "review", post: false });
  });

  test("shortcuts select without the cursor moving", async () => {
    expect(await runConfirm(spec(), fakeReader(["y"]), recorder())).toEqual({
      kind: "review",
      post: false,
    });
    expect(await runConfirm(spec(), fakeReader(["r"]), recorder())).toEqual({
      kind: "review",
      post: false,
    });
    expect(await runConfirm(spec(), fakeReader(["n"]), recorder())).toEqual({
      kind: "cancel",
    });
    expect(await runConfirm(spec(), fakeReader(["C"]), recorder())).toEqual({
      kind: "cancel",
    });
    expect(
      await runConfirm(
        spec({ canSkipPost: true }),
        fakeReader(["p"]),
        recorder(),
      ),
    ).toEqual({ kind: "review", post: false });
  });

  test("an unbound key is ignored rather than deciding anything", async () => {
    const result = await runConfirm(
      spec(),
      fakeReader(["z", "\t", "y"]),
      recorder(),
    );
    expect(result).toEqual({ kind: "review", post: false });
  });

  test("ctrl-c cancels loudly", async () => {
    const io = recorder();
    const result = await runConfirm(spec(), fakeReader(["\x03"]), io);
    expect(result).toEqual({ kind: "cancel" });
    expect(io.lines()).toContain("^C");
  });

  test("a stdin that ends mid-menu cancels", async () => {
    const result = await runConfirm(spec(), fakeReader([]), recorder());
    expect(result).toEqual({ kind: "cancel" });
  });

  test("show details prints and RE-PRESENTS the menu", async () => {
    const io = recorder();
    const result = await runConfirm(spec(), fakeReader(["d", "y"]), io);
    // Not a terminal choice: the run still had to be decided afterwards.
    expect(result).toEqual({ kind: "review", post: false });
    const lines = io.lines();
    expect(lines).toContain("details line one");
    expect(lines).toContain("details line two");
    // Three options, drawn twice: once before the details and once after.
    expect(lines.filter((l) => l.includes("Cancel")).length).toBe(2);
    expect(lines.filter((l) => l.includes("Review it")).length).toBe(2);
    // The option list composition survives the re-present.
    expect(lines.some((l) => l.includes("don't post"))).toBe(false);
  });

  test("details is not built unless it is asked for", async () => {
    let built = 0;
    await runConfirm(
      spec({
        details: () => {
          built++;
          return [];
        },
      }),
      fakeReader(["y"]),
      recorder(),
    );
    expect(built).toBe(0);
  });

  test("with styles off, not one escape sequence is written", async () => {
    const io = recorder();
    await runConfirm(spec(), fakeReader([`${ESC}[B`, "d", "\r"]), io);
    expect(io.text()).not.toContain(ESC);
  });
});

// The highest-risk path in this module: the watcher spawns review with --yes
// AND stdin: "ignore". --yes short-circuits above the confirm entirely, but a
// non-TTY stdin must still never see raw mode, and an unanswered prompt must
// still read as "no".
describe("runConfirm — the non-TTY fallback", () => {
  test("prompts exactly as the [y/N] confirm it replaced", async () => {
    const io = recorder();
    await runConfirm(spec(), fakeReader(["y\n"], false), io);
    expect(io.text()).toContain(
      "Spend an estimated $2.85–$6.14 on this review? [y/N] ",
    );
    expect(io.text()).not.toContain("❯");
  });

  test("y and yes proceed, in any case and with whitespace", async () => {
    for (const answer of ["y", "yes\n", " Y \n", "YES"]) {
      expect(
        await runConfirm(spec(), fakeReader([answer], false), recorder()),
      ).toEqual({ kind: "review", post: false });
    }
  });

  test("posting is left exactly as it was asked for", async () => {
    expect(
      await runConfirm(
        spec({ canSkipPost: true }),
        fakeReader(["y"], false),
        recorder(),
      ),
    ).toEqual({ kind: "review", post: true });
  });

  test("undefined — an ignored stdin — cancels", async () => {
    expect(
      await runConfirm(spec(), fakeReader([undefined], false), recorder()),
    ).toEqual({ kind: "cancel" });
  });

  test("everything that is not yes cancels", async () => {
    for (const answer of ["n", "", "\n", "ye", "no", "yep"]) {
      expect(
        await runConfirm(spec(), fakeReader([answer], false), recorder()),
      ).toEqual({ kind: "cancel" });
    }
  });
});

describe("confirmReview", () => {
  test("closes the reader on the way out", async () => {
    let closed = 0;
    const reader: KeyReader = {
      raw: true,
      read: () => Promise.resolve("y"),
      close: () => {
        closed++;
      },
    };
    await confirmReview(spec(), reader, recorder());
    expect(closed).toBe(1);
  });

  test("closes the reader even when the menu throws", async () => {
    let closed = 0;
    const reader: KeyReader = {
      raw: true,
      read: () => Promise.reject(new Error("stdin exploded")),
      close: () => {
        closed++;
      },
    };
    await expect(confirmReview(spec(), reader, recorder())).rejects.toThrow(
      "stdin exploded",
    );
    // The load-bearing guarantee: a throw mid-menu never strands a terminal
    // in raw mode.
    expect(closed).toBe(1);
  });
});

describe("sizeGateMenuOptions", () => {
  test("is continue or cancel, nothing else", () => {
    expect(sizeGateMenuOptions().map((o) => o.label)).toEqual([
      "Review anyway",
      "Cancel",
    ]);
  });
});

describe("runSizeGateConfirm — the menu", () => {
  test("enter on Review anyway proceeds", async () => {
    const result = await runSizeGateConfirm(
      false,
      fakeReader(["\r"]),
      recorder(),
    );
    expect(result).toEqual({ kind: "proceed" });
  });

  test("y and r proceed; n, c, q cancel", async () => {
    expect(
      await runSizeGateConfirm(false, fakeReader(["y"]), recorder()),
    ).toEqual({ kind: "proceed" });
    expect(
      await runSizeGateConfirm(false, fakeReader(["r"]), recorder()),
    ).toEqual({ kind: "proceed" });
    expect(
      await runSizeGateConfirm(false, fakeReader(["n"]), recorder()),
    ).toEqual({ kind: "cancel" });
    expect(
      await runSizeGateConfirm(false, fakeReader(["c"]), recorder()),
    ).toEqual({ kind: "cancel" });
    expect(
      await runSizeGateConfirm(false, fakeReader(["q"]), recorder()),
    ).toEqual({ kind: "cancel" });
  });

  test("arrow up wraps to Cancel", async () => {
    const result = await runSizeGateConfirm(
      false,
      fakeReader([`${ESC}[A`, "\r"]),
      recorder(),
    );
    expect(result).toEqual({ kind: "cancel" });
  });

  test("ctrl-c cancels loudly", async () => {
    const io = recorder();
    const result = await runSizeGateConfirm(false, fakeReader(["\x03"]), io);
    expect(result).toEqual({ kind: "cancel" });
    expect(io.text()).toContain("^C");
  });

  test("an unanswered stream cancels rather than spending", async () => {
    const result = await runSizeGateConfirm(
      false,
      fakeReader([undefined]),
      recorder(),
    );
    expect(result).toEqual({ kind: "cancel" });
  });

  test("the plain path is [y/N], and anything but yes cancels", async () => {
    expect(
      await runSizeGateConfirm(false, fakeReader(["yes"], false), recorder()),
    ).toEqual({ kind: "proceed" });
    expect(
      await runSizeGateConfirm(false, fakeReader(["y"], false), recorder()),
    ).toEqual({ kind: "proceed" });
    expect(
      await runSizeGateConfirm(false, fakeReader([""], false), recorder()),
    ).toEqual({ kind: "cancel" });
    expect(
      await runSizeGateConfirm(
        false,
        fakeReader([undefined], false),
        recorder(),
      ),
    ).toEqual({ kind: "cancel" });
  });

  test("styles off means not one escape byte in the frame", async () => {
    const io = recorder();
    await runSizeGateConfirm(false, fakeReader(["y"]), io);
    expect(io.text()).not.toContain(ESC);
    expect(io.text()).toContain("Review anyway");
  });
});

describe("confirmSizeGate", () => {
  test("closes the reader on the way out, including on throw", async () => {
    let closed = 0;
    const reader: KeyReader = {
      raw: true,
      read: () => Promise.reject(new Error("stdin exploded")),
      close: () => {
        closed++;
      },
    };
    await expect(confirmSizeGate(false, reader, recorder())).rejects.toThrow(
      "stdin exploded",
    );
    expect(closed).toBe(1);
  });
});

// One billing verdict, two surfaces: the plan card and the confirm prompt
// quote the same band, so a free route must not read as spend in either. The
// mode is derived once (freeBillingMode) from the same free-step count the
// card uses; the wording below is what the prompt shows for each mode.
describe("freeBillingMode", () => {
  test("every step free is free, some free is mixed, none or unknown is neither", () => {
    expect(freeBillingMode({ free: 5, total: 5 })).toBe("free");
    expect(freeBillingMode({ free: 2, total: 5 })).toBe("mixed");
    expect(freeBillingMode({ free: 0, total: 5 })).toBeUndefined();
    expect(freeBillingMode({ free: 0, total: 0 })).toBeUndefined();
    expect(freeBillingMode(undefined)).toBeUndefined();
  });
});

describe("costHint with a billing mode", () => {
  test("all free: the hint says free route, not billed, with no dollar figure", () => {
    expect(costHint(2.85, 6.14, "free")).toBe("free route (not billed)");
  });

  test("mixed: the band stays and names the free share", () => {
    expect(costHint(2.85, 6.14, "mixed")).toBe(
      "$2.85 – $6.14 (free steps not billed)",
    );
  });

  test("metered (no mode) is unchanged", () => {
    expect(costHint(2.85, 6.14, undefined)).toBe("$2.85 – $6.14");
  });
});

describe("runConfirm — the wording follows the billing mode", () => {
  test("TTY menu, all free: the first row's hint is the free wording, not the band", async () => {
    const io = recorder();
    await runConfirm(spec({ billing: "free" }), fakeReader(["\r"]), io);
    const text = io.text();
    expect(text).toContain("free route (not billed)");
    expect(text).not.toContain("$2.85 – $6.14");
  });

  test("TTY menu, mixed: the band stays and carries the free-steps note", async () => {
    const io = recorder();
    await runConfirm(spec({ billing: "mixed" }), fakeReader(["\r"]), io);
    expect(io.text()).toContain("$2.85 – $6.14 (free steps not billed)");
  });

  test("plain prompt, all free: the sentence names a free route and says not billed", async () => {
    const io = recorder();
    await runConfirm(spec({ billing: "free" }), fakeReader(["n\n"], false), io);
    expect(io.text()).toContain(
      "Run this review on a free route (token-derived $2.85–$6.14, not billed)? [y/N] ",
    );
    expect(io.text()).not.toContain("Spend an estimated");
  });

  test("plain prompt, mixed: the spend sentence keeps the band and appends the note", async () => {
    const io = recorder();
    await runConfirm(
      spec({ billing: "mixed" }),
      fakeReader(["n\n"], false),
      io,
    );
    expect(io.text()).toContain(
      "Spend an estimated $2.85–$6.14 on this review (free steps not billed)? [y/N] ",
    );
  });

  test("plain prompt, metered (no mode): byte-identical to today", async () => {
    const io = recorder();
    await runConfirm(spec(), fakeReader(["n\n"], false), io);
    expect(io.text()).toContain(
      "Spend an estimated $2.85–$6.14 on this review? [y/N] ",
    );
  });

  test("the answer semantics are unchanged on a free route: y proceeds, anything else cancels", async () => {
    expect(
      await runConfirm(
        spec({ billing: "free" }),
        fakeReader(["y\n"], false),
        recorder(),
      ),
    ).toEqual({ kind: "review", post: false });
    expect(
      await runConfirm(
        spec({ billing: "free" }),
        fakeReader(["n\n"], false),
        recorder(),
      ),
    ).toEqual({ kind: "cancel" });
  });
});
