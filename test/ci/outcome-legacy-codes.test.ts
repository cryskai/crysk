// The error codes were renamed from PRH-* to CRYSK-*. Outcome comments already posted on
// pull requests keep their old PRH-* headings and their links to the old docs anchors, so
// these tests pin what still reads them: parseOutcomeCode maps an old heading to the code
// it became, and the docs keep an anchor under each old name.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";
import {
  ERROR_CODES,
  OUTCOME_MARKER_PREFIX,
  parseOutcomeCode,
  renderCode,
} from "../../src/ci/outcome";
import { CANCELLED_STATUS_DESCRIPTION } from "../../src/ci/publish";

const DOCS = path.resolve(import.meta.dir, "../../docs/github-actions.md");
const DOCS_URL_PREFIX =
  "https://github.com/cryskai/crysk/blob/v0/docs/github-actions.md#";

function outcomeBody(heading: string): string {
  return `${OUTCOME_MARKER_PREFIX}v=1 head=unknown run=7 attempt=1 -->\n\n### ${heading}\n\nbody`;
}

function legacyOutcomeBody(heading: string): string {
  return `<!-- pr-hero-outcome v=1 head=unknown run=7 attempt=1 -->\n\n### ${heading}\n\nbody`;
}

describe("parseOutcomeCode reads comments posted before the rename", () => {
  test("an old PRH-CRED-MISSING heading reads as CRYSK-CRED-MISSING", () => {
    expect(parseOutcomeCode(outcomeBody("PRH-CRED-MISSING"))).toBe(
      "CRYSK-CRED-MISSING",
    );
    expect(parseOutcomeCode(legacyOutcomeBody("PRH-CRED-MISSING"))).toBe(
      "CRYSK-CRED-MISSING",
    );
  });

  test("an old headline with a colon reads as the renamed bare code", () => {
    expect(
      parseOutcomeCode(legacyOutcomeBody("PRH-CANCELLED: not reviewed")),
    ).toBe("CRYSK-CANCELLED");
  });

  test("every catalogued code reads back under its old name", () => {
    for (const code of ERROR_CODES) {
      const old = `PRH-${code.slice("CRYSK-".length)}`;
      expect(parseOutcomeCode(outcomeBody(old)), old).toBe(code);
    }
  });

  test("a removed code reads as no code, under either name", () => {
    expect(parseOutcomeCode(outcomeBody("PRH-ROUTING-INVALID"))).toBeNull();
    expect(parseOutcomeCode(outcomeBody("CRYSK-ROUTING-INVALID"))).toBeNull();
  });

  test("an old code outside an outcome comment is still no code", () => {
    expect(parseOutcomeCode("### PRH-CRED-MISSING\n\nquoted")).toBeNull();
  });
});

describe("docs anchors after the rename", () => {
  const docs = readFileSync(DOCS, "utf8");
  const headingSlugs = new Set(
    [...docs.matchAll(/^### (CRYSK-[A-Z-]+)$/gm)].map((match) =>
      (match[1] ?? "").toLowerCase(),
    ),
  );

  test("every rendered docs link points at a CRYSK-* heading", () => {
    for (const code of ERROR_CODES) {
      const rendered = renderCode(code, {}, "action");
      expect(rendered.annotation).toContain(DOCS_URL_PREFIX);
      const anchor = rendered.annotation.slice(
        rendered.annotation.lastIndexOf("#") + 1,
      );
      expect(anchor, `${code} anchor`).toBe(code.toLowerCase());
      expect(headingSlugs.has(anchor), `${code} anchor ${anchor}`).toBe(true);
    }
  });

  test("every code keeps its old prh-* anchor, on its own line right before its heading", () => {
    for (const code of ERROR_CODES) {
      const legacy = `prh-${code.slice("CRYSK-".length).toLowerCase()}`;
      // An HTML block runs until a blank line, so the anchor needs one before the
      // heading or it swallows it.
      expect(
        docs.includes(`\n\n<a id="${legacy}"></a>\n\n### ${code}\n`),
        `${legacy} anchor before ### ${code}`,
      ).toBe(true);
    }
  });

  test("every in-page link to an error code resolves to a heading or an old anchor", () => {
    const legacyIds = new Set(
      [...docs.matchAll(/^<a id="(prh-[a-z-]+)"><\/a>$/gm)].map(
        (match) => match[1] ?? "",
      ),
    );
    const links = [...docs.matchAll(/\]\(#((?:crysk|prh)-[a-z-]+)\)/g)].map(
      (match) => match[1] ?? "",
    );
    expect(links.length).toBeGreaterThan(0);
    for (const link of links) {
      expect(
        headingSlugs.has(link) || legacyIds.has(link),
        `#${link} resolves`,
      ).toBe(true);
      expect(link.startsWith("crysk-"), `#${link} uses the new name`).toBe(
        true,
      );
    }
  });
});

describe("the cancelled status", () => {
  test("names the renamed code and the /crysk review command", () => {
    expect(CANCELLED_STATUS_DESCRIPTION).toBe(
      "CRYSK-CANCELLED: not reviewed — /crysk review reviews this head",
    );
  });
});
