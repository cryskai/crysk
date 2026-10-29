import { describe, expect, test } from "bun:test";
import {
  renderContextBox,
  renderMenuCard,
  renderPersistentFooter,
  renderSolidHeader,
} from "#ui/menu";
import type { MenuItem, RepoContext } from "../../src/menu-context";

const ANSI = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, "g");
const stripAnsi = (text: string): string => text.replace(ANSI, "");

describe("ui-menu renderers", () => {
  const dummyContext: RepoContext = {
    kind: "configured-repo",
    root: "/Users/juanma/Desktop/pr-hero",
    name: "pr-hero",
    defaultBase: "main",
  };

  const dummyItems: MenuItem[] = [
    {
      id: "review",
      label: "Review PR",
      desc: "Run multi-agent review on branch or PR",
      cliHint: "review",
      isSubmenu: true,
      action: "review",
    },
    {
      id: "activity",
      label: "Activity & runs",
      desc: "View active runs and completed history",
      cliHint: "activity",
      badge: "1 running",
      action: "activity",
    },
    {
      id: "lifecycle",
      label: "Lifecycle & updates",
      desc: "Upgrade, sync skills & uninstaller",
      cliHint: "upgrade",
      badge: "update available",
      isSubmenu: true,
      action: "lifecycle",
    },
  ];

  describe("3.2 renderSolidHeader width tiers", () => {
    test("renders 6-line solid ASCII block banner when width >= 60", () => {
      const lines = renderSolidHeader(80, false);
      expect(lines.length).toBeGreaterThanOrEqual(5);
      expect(lines.join("\n")).toContain("██");
      expect(lines.every((l) => !l.includes("\x1b["))).toBe(true);
    });

    test("renders compact 1-line title when width is between 24 and 59", () => {
      const lines = renderSolidHeader(50, false);
      expect(lines.length).toBe(1);
      expect(lines[0]).toContain("PR-HERO");
    });
  });

  describe("3.2 renderContextBox", () => {
    test("renders double-border context card with repo info", () => {
      const lines = renderContextBox(dummyContext, 80, false);
      expect(lines[0]).toContain("╔");
      expect(lines[0]).toContain("Current Context");
      expect(lines.join("\n")).toContain("pr-hero");
      expect(lines.join("\n")).toContain("main");
      expect(lines.at(-1)).toContain("╚");
    });

    test("renders unconfigured repo context cleanly", () => {
      const unconf: RepoContext = {
        kind: "unconfigured-repo",
        root: "/Users/anon/proj",
        name: "proj",
      };
      const lines = renderContextBox(unconf, 80, false);
      expect(lines.join("\n")).toContain("Unconfigured Repository");
      expect(lines.join("\n")).toContain("proj");
    });

    test("renders not-a-repo context cleanly", () => {
      const notRepo: RepoContext = {
        kind: "not-a-repo",
        cwd: "/Users/anon/somewhere",
      };
      const lines = renderContextBox(notRepo, 80, false);
      expect(lines.join("\n")).toContain("Not inside a repository");
    });
  });

  describe("3.2 renderMenuCard", () => {
    test("renders menu items with selection indicator and badges", () => {
      const lines = renderMenuCard(dummyItems, 0, 80, false);
      expect(lines[0]).toContain("╔");
      expect(lines.join("\n")).toContain("▸ 1. Review PR");
      expect(lines.join("\n")).toContain("2. Activity & runs (1 running)");
      expect(lines.join("\n")).toContain(
        "3. Lifecycle & updates (update available)",
      );
      expect(lines.at(-1)).toContain("╚");
    });

    test("no escape bytes when styles are disabled", () => {
      const lines = renderMenuCard(dummyItems, 1, 80, false);
      expect(lines.join("\n")).not.toContain("\x1b[");
    });

    test("styled render matches plain text after stripping ANSI", () => {
      const styled = renderMenuCard(dummyItems, 1, 80, true);
      const plain = renderMenuCard(dummyItems, 1, 80, false);
      expect(styled.map((l) => stripAnsi(l))).toEqual(plain);
    });
  });

  describe("3.2 renderPersistentFooter", () => {
    test("renders key hints and CLI equivalent for selected item", () => {
      const lines = renderPersistentFooter(dummyItems[0], 80, false);
      expect(lines.join("\n")).toContain("j/k: move");
      expect(lines.join("\n")).toContain("$ crysk review");
    });

    test("shows submenu hint when item is a submenu opener", () => {
      const lines = renderPersistentFooter(dummyItems[0], 80, false);
      expect(lines.join("\n")).toContain("enter: open submenu");
    });
  });
});
