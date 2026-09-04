import assert from "node:assert/strict";
import { renameSync, rmSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { collectChangeMetrics } from "../src/change-metrics.mjs";
import { baseConfig, commitAll, initGitRepo, write } from "./helpers.mjs";

function contract(overrides = {}) {
  return {
    schemaVersion: 2,
    taskId: "change-metrics",
    objective: "Measure deterministic diff facts",
    engineeringProfile: "small",
    allowedPaths: ["src/**", "tests/**", "migrations/**"],
    forbiddenPaths: [],
    migrationPaths: ["migrations/**"],
    allowedChangeCategories: ["source", "tests"],
    budget: { maxFiles: 10 },
    ...overrides,
  };
}

function config() {
  return baseConfig({
    testCategories: { unit: ["tests/**/*.test.mjs"] },
    testSupport: ["tests/helpers/**"],
  });
}

function lines(prefix, count) {
  return `${Array.from({ length: count }, (_, index) => `${prefix}-${index + 1}`).join("\n")}\n`;
}

test("change metrics count Git diff lines and configured test files", () => {
  const repo = initGitRepo();
  write(join(repo, "README.md"), "# Baseline\n");
  const base = commitAll(repo, "baseline");
  write(join(repo, "src/login/button.mjs"), lines("source", 20));
  write(join(repo, "tests/login/button.test.mjs"), lines("test", 40));
  const head = commitAll(repo, "implementation and tests");

  assert.deepEqual(collectChangeMetrics(repo, config(), contract(), base, head), {
    changedFiles: 2,
    newFiles: 2,
    directories: 2,
    addedLines: 60,
    deletedLines: 0,
    testFiles: 1,
    testAddedLines: 40,
    migrationFiles: 0,
    outOfScopeFiles: 0,
  });
});

test("change metrics reuse migration, scope, and test-support path declarations", () => {
  const repo = initGitRepo();
  write(join(repo, "src/old.mjs"), lines("old", 5));
  const base = commitAll(repo, "baseline");
  rmSync(join(repo, "src/old.mjs"));
  write(join(repo, "migrations/001.sql"), lines("migration", 3));
  write(join(repo, "outside/extra.mjs"), lines("outside", 2));
  write(join(repo, "tests/helpers/fixture.mjs"), lines("fixture", 4));
  const head = commitAll(repo, "mixed changes");

  assert.deepEqual(collectChangeMetrics(repo, config(), contract(), base, head), {
    changedFiles: 4,
    newFiles: 3,
    directories: 4,
    addedLines: 9,
    deletedLines: 5,
    testFiles: 1,
    testAddedLines: 4,
    migrationFiles: 1,
    outOfScopeFiles: 1,
  });
});
test("an exact rename does not consume new-file or added-line budget", () => {
  const repo = initGitRepo();
  write(join(repo, "src/foo.mjs"), lines("source", 800));
  const base = commitAll(repo, "baseline");
  renameSync(join(repo, "src/foo.mjs"), join(repo, "src/bar.mjs"));
  const head = commitAll(repo, "rename");

  const metrics = collectChangeMetrics(repo, config(), contract(), base, head);
  assert.equal(metrics.changedFiles, 1);
  assert.equal(metrics.newFiles, 0);
  assert.equal(metrics.addedLines, 0);
  assert.equal(metrics.deletedLines, 0);
});
