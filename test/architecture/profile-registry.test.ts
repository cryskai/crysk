// odd/tasks/openai-profile.md S11: profiles are pieces the engine plugs in,
// not part of it. Each one is data in its own module under
// src/model/profiles/, and only the registry (src/model/profiles.ts) imports
// them, so engine code reads the active profile and never names one. Adding a
// profile is one module plus one registry line.

import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { MODEL_PROFILES } from "#model/profiles";

const SRC_DIR = path.join(import.meta.dir, "../../src");
const PROFILES_DIR = path.join(SRC_DIR, "model/profiles");
const REGISTRY = path.join(SRC_DIR, "model/profiles.ts");

// `#model/profiles/<id>`, `./profiles/<id>`, `../model/profiles/<id>`, ...
const PROFILE_MODULE_IMPORT =
  /from\s+["'][^"']*model\/profiles\/[^"']+["']|from\s+["']\.\/profiles\/[^"']+["']/;

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(full);
    return entry.name.endsWith(".ts") ? [full] : [];
  });
}

function profileModuleIds(): string[] {
  return readdirSync(PROFILES_DIR)
    .filter((name) => name.endsWith(".ts"))
    .map((name) => name.slice(0, -".ts".length))
    .sort();
}

describe("profiles are lego pieces (S11)", () => {
  test("only the registry imports a profile module", () => {
    const importers = sourceFiles(SRC_DIR)
      .filter((file) => file !== REGISTRY)
      .filter((file) => !file.startsWith(`${PROFILES_DIR}${path.sep}`))
      .filter((file) => PROFILE_MODULE_IMPORT.test(readFileSync(file, "utf8")))
      .map((file) => path.relative(SRC_DIR, file));
    expect(importers).toEqual([]);
  });

  test("every profile module is registered under its file name", () => {
    expect(Object.keys(MODEL_PROFILES).sort()).toEqual(profileModuleIds());
    for (const [id, profile] of Object.entries(MODEL_PROFILES)) {
      expect(profile.id).toBe(id);
    }
  });

  test("a profile module imports only types from the engine", () => {
    for (const id of profileModuleIds()) {
      const text = readFileSync(path.join(PROFILES_DIR, `${id}.ts`), "utf8");
      const valueImports = text
        .split("\n")
        .filter(
          (line) => /^import\s/.test(line) && !/^import type\s/.test(line),
        );
      expect({ id, valueImports }).toEqual({ id, valueImports: [] });
    }
  });
});
