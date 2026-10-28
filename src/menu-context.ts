import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

export type RepoContext =
  | { kind: "not-a-repo"; cwd: string }
  | { kind: "unconfigured-repo"; root: string; name: string }
  | {
      kind: "configured-repo";
      root: string;
      name: string;
      defaultBase?: string;
    };

export interface MenuStatusInfo {
  activeReviewsCount?: number;
  upgradeAvailable?: boolean;
  watcherStatus?: "running" | "stopped" | "uninstalled";
  doctorStatus?: "healthy" | "degraded" | "blocking";
}

export type MenuAction =
  | "review"
  | "init"
  | "activity"
  | "watcher"
  | "config"
  | "doctor"
  | "lifecycle"
  | "quit";

export interface MenuItem {
  id: MenuAction;
  label: string;
  desc: string;
  cliHint: string;
  badge?: string;
  isSubmenu?: boolean;
  action: MenuAction;
}

export interface ResolveMenuContextDeps {
  resolveRoot?: (dir: string) => Promise<string | null>;
  exists?: (p: string) => boolean;
  readConfig?: (p: string) => Record<string, unknown>;
}

async function findGitRoot(dir: string): Promise<string | null> {
  try {
    const proc = Bun.spawn(["git", "-C", dir, "rev-parse", "--show-toplevel"], {
      stdout: "pipe",
      stderr: "pipe",
    });
    const exitCode = await proc.exited;
    if (exitCode !== 0) return null;
    const stdout = await new Response(proc.stdout).text();
    const root = stdout.trim();
    return root.length > 0 ? root : null;
  } catch {
    return null;
  }
}

export async function resolveMenuContext(
  cwd: string = process.cwd(),
  deps: ResolveMenuContextDeps = {},
): Promise<RepoContext> {
  const resolveRoot = deps.resolveRoot ?? findGitRoot;
  const exists = deps.exists ?? existsSync;
  const readConfig =
    deps.readConfig ??
    ((p) => {
      try {
        return JSON.parse(readFileSync(p, "utf-8"));
      } catch {
        return {};
      }
    });

  const root = await resolveRoot(cwd);
  if (!root) {
    return { kind: "not-a-repo", cwd };
  }

  const name = path.basename(root) || "repository";
  const configPath = path.join(root, ".prhero", "config.json");

  if (!exists(configPath)) {
    return { kind: "unconfigured-repo", root, name };
  }

  const config = readConfig(configPath);
  const defaultBase =
    typeof config.default_base === "string" ? config.default_base : undefined;

  return {
    kind: "configured-repo",
    root,
    name,
    defaultBase,
  };
}

export function getMenuOptions(
  context: RepoContext,
  status: MenuStatusInfo = {},
): MenuItem[] {
  const items: MenuItem[] = [];

  if (context.kind === "configured-repo") {
    items.push({
      id: "review",
      label: "Review PR",
      desc: "Run multi-agent review on branch or PR",
      cliHint: "review",
      isSubmenu: true,
      action: "review",
    });
  } else if (context.kind === "unconfigured-repo") {
    items.push({
      id: "init",
      label: "Initialize repo",
      desc: "Scaffold <repo>/.prhero/ config & gotchas",
      cliHint: "init",
      action: "init",
    });
  }

  // Activity is present in all contexts
  const activeBadge =
    (status.activeReviewsCount ?? 0) > 0
      ? `${status.activeReviewsCount} running`
      : undefined;

  items.push({
    id: "activity",
    label: "Activity & runs",
    desc: "View active reviews and completed history",
    cliHint: "activity",
    badge: activeBadge,
    action: "activity",
  });

  items.push({
    id: "watcher",
    label: "Watcher daemon",
    desc: "Background branch and PR monitoring daemon",
    cliHint: "watch",
    isSubmenu: true,
    action: "watcher",
  });

  items.push({
    id: "config",
    label: "Configuration",
    desc: "Inspect or edit global and repo settings",
    cliHint: "config",
    isSubmenu: true,
    action: "config",
  });

  items.push({
    id: "doctor",
    label: "Doctor diagnostics",
    desc: "Check system tools, auth & environment readiness",
    cliHint: "doctor",
    action: "doctor",
  });

  const lifecycleBadge = status.upgradeAvailable
    ? "update available"
    : undefined;
  items.push({
    id: "lifecycle",
    label: "Lifecycle & updates",
    desc: "Upgrade, sync skills & managed uninstall",
    cliHint: "upgrade",
    badge: lifecycleBadge,
    isSubmenu: true,
    action: "lifecycle",
  });

  items.push({
    id: "quit",
    label: "Quit",
    desc: "Exit pr-hero TUI",
    cliHint: "exit",
    action: "quit",
  });

  return items;
}
