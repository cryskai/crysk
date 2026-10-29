import { describe, expect, test } from "bun:test";
import {
  getMenuOptions,
  type MenuStatusInfo,
  type RepoContext,
  resolveMenuContext,
} from "../src/menu-context";

describe("menu-context", () => {
  describe("3.1 resolveMenuContext", () => {
    test("classifies not-a-repo when resolveRoot returns null", async () => {
      const ctx = await resolveMenuContext("/Users/anon/somedir", {
        resolveRoot: async () => null,
      });

      expect(ctx.kind).toBe("not-a-repo");
      if (ctx.kind === "not-a-repo") {
        expect(ctx.cwd).toBe("/Users/anon/somedir");
      }
    });

    test("classifies unconfigured-repo when .crysk config is absent", async () => {
      const ctx = await resolveMenuContext("/Users/anon/my-project", {
        resolveRoot: async () => "/Users/anon/my-project",
        exists: (p) => !p.includes(".crysk"),
      });

      expect(ctx.kind).toBe("unconfigured-repo");
      if (ctx.kind === "unconfigured-repo") {
        expect(ctx.root).toBe("/Users/anon/my-project");
        expect(ctx.name).toBe("my-project");
      }
    });

    test("classifies configured-repo when .crysk config exists", async () => {
      const ctx = await resolveMenuContext("/Users/anon/my-project/src", {
        resolveRoot: async () => "/Users/anon/my-project",
        exists: (p) => p.includes(".crysk"),
        readConfig: () => ({ default_base: "main" }),
      });

      expect(ctx.kind).toBe("configured-repo");
      if (ctx.kind === "configured-repo") {
        expect(ctx.root).toBe("/Users/anon/my-project");
        expect(ctx.name).toBe("my-project");
        expect(ctx.defaultBase).toBe("main");
      }
    });
  });

  describe("3.1 getMenuOptions contextual filtering", () => {
    test("in not-a-repo: omits Review and Ledger; includes Activity, Watcher, Config, Doctor, Lifecycle, Quit", () => {
      const ctx: RepoContext = { kind: "not-a-repo", cwd: "/tmp" };
      const options = getMenuOptions(ctx);
      const ids = options.map((o) => o.id);

      expect(ids).not.toContain("review");
      expect(ids).not.toContain("init");
      expect(ids).not.toContain("ledger");
      expect(ids).toContain("activity");
      expect(ids).toContain("watcher");
      expect(ids).toContain("config");
      expect(ids).toContain("doctor");
      expect(ids).toContain("lifecycle");
      expect(ids).toContain("quit");
    });

    test("in unconfigured-repo: Init is first item; Review and Ledger omitted", () => {
      const ctx: RepoContext = {
        kind: "unconfigured-repo",
        root: "/Users/x/proj",
        name: "proj",
      };
      const options = getMenuOptions(ctx);
      const ids = options.map((o) => o.id);

      expect(options[0].id).toBe("init");
      expect(ids).not.toContain("review");
      expect(ids).not.toContain("ledger");
      expect(ids).toContain("activity");
      expect(ids).toContain("lifecycle");
    });

    test("in configured-repo: Review is first item; Init and Ledger omitted", () => {
      const ctx: RepoContext = {
        kind: "configured-repo",
        root: "/Users/x/proj",
        name: "proj",
        defaultBase: "main",
      };
      const options = getMenuOptions(ctx);
      const ids = options.map((o) => o.id);

      expect(options[0].id).toBe("review");
      expect(ids).not.toContain("ledger");
      expect(ids).not.toContain("init");
      expect(ids).toContain("activity");
      expect(ids).toContain("lifecycle");
    });

    test("renders dynamic status badges for activity and lifecycle upgrade", () => {
      const ctx: RepoContext = { kind: "not-a-repo", cwd: "/tmp" };
      const status: MenuStatusInfo = {
        activeReviewsCount: 2,
        upgradeAvailable: true,
      };

      const options = getMenuOptions(ctx, status);
      const activityItem = options.find((o) => o.id === "activity");
      const lifecycleItem = options.find((o) => o.id === "lifecycle");

      expect(activityItem?.badge).toContain("2 running");
      expect(lifecycleItem?.badge).toContain("update available");
    });
  });
});
