import { describe, expect, test } from "bun:test";
import {
  adjudicationMarker,
  parseAdjudicationMarker,
} from "#triage/adjudication";

const HEAD = "a".repeat(40);

describe("the CI adjudication marker", () => {
  test("round-trips verdict, reply id and head", () => {
    const line = adjudicationMarker({
      verdict: "upheld",
      reply: 4302848786,
      head: HEAD,
    });
    expect(line).toBe(
      `<!-- crysk-adjudication verdict=upheld reply=4302848786 head=${HEAD} -->`,
    );
    expect(parseAdjudicationMarker(`${line}\n\nprose`)).toEqual({
      verdict: "upheld",
      reply: 4302848786,
      head: HEAD,
    });
  });

  test.each([
    ["an unknown verdict", `verdict=accepted reply=1 head=${HEAD}`],
    ["a missing reply", `verdict=upheld head=${HEAD}`],
    ["a non-numeric reply", `verdict=upheld reply=12a head=${HEAD}`],
    ["a zero reply", `verdict=upheld reply=0 head=${HEAD}`],
    ["a short head", "verdict=upheld reply=1 head=abc"],
    [
      "a duplicate field",
      `verdict=upheld verdict=rejected reply=1 head=${HEAD}`,
    ],
    ["an extra field", `verdict=upheld reply=1 head=${HEAD} actor=ci`],
    ["a bare token", `verdict=upheld reply=1 head=${HEAD} trusted`],
  ])("rejects %s", (_label, fields) => {
    expect(
      parseAdjudicationMarker(`<!-- pr-hero-adjudication ${fields} -->`),
    ).toBeNull();
  });

  test("reads only the first line: a marker quoted below prose does not parse", () => {
    const line = adjudicationMarker({
      verdict: "upheld",
      reply: 1,
      head: HEAD,
    });
    expect(parseAdjudicationMarker(`quoting:\n${line}`)).toBeNull();
  });
});
