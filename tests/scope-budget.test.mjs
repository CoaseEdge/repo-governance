import assert from "node:assert/strict";
import test from "node:test";
import { evaluateScopeBudget } from "../src/scope-budget.mjs";
import { TASK_CONTRACT_FILE } from "../src/task-contract.mjs";

function taskContract(overrides = {}) {
  return {
    schemaVersion: 1,
    taskId: "scope-budget",
    objective: "Enforce deterministic change budgets",
    allowedPaths: ["src/**", "migrations/**"],
    forbiddenPaths: ["src/admin/**"],
    migrationPaths: ["migrations/**"],
    allowedChangeCategories: [],
    budget: {
      maxFiles: 10,
      maxDirectories: 5,
      maxMigrations: 2,
      maxOutOfScopeFiles: 1,
    },
    ...overrides,
  };
}

test("scope budgets report deterministic metrics below every limit", () => {
  const changed = [
    "src/runtime/b.mjs",
    "README.md",
    "src/runtime/a.mjs",
    TASK_CONTRACT_FILE,
    "src/runtime/a.mjs",
    "migrations/001.sql",
  ];
  const expected = {
    metrics: { files: 4, directories: 3, migrations: 1, outOfScopeFiles: 1, forbiddenFiles: 0 },
    findings: [],
  };
  assert.deepEqual(evaluateScopeBudget(taskContract(), changed), expected);
  assert.deepEqual(evaluateScopeBudget(taskContract(), [...changed].reverse()), expected);
});

test("every declared budget dimension emits a stable blocking finding", () => {
  const contract = taskContract({
    budget: { maxFiles: 2, maxDirectories: 1, maxMigrations: 1, maxOutOfScopeFiles: 0 },
  });
  const result = evaluateScopeBudget(contract, [
    "other/extra.mjs",
    "migrations/002.sql",
    "src/runtime/index.mjs",
    "migrations/001.sql",
  ]);
  assert.deepEqual(result.metrics, { files: 4, directories: 3, migrations: 2, outOfScopeFiles: 1, forbiddenFiles: 0 });
  assert.deepEqual(result.findings.map((finding) => [finding.budget, finding.severity]), [
    ["maxFiles", "error"],
    ["maxDirectories", "error"],
    ["maxMigrations", "error"],
    ["maxOutOfScopeFiles", "error"],
  ]);
  assert.deepEqual(result.findings[0], {
    rule: "RG008",
    type: "BUDGET_EXCEEDED",
    budget: "maxFiles",
    message: "Task changed 4 files, limit is 2.",
    severity: "error",
    waivable: false,
    actualFiles: 4,
    maxFiles: 2,
  });
  assert.deepEqual(result.findings.slice(1).map((finding) => ({
    budget: finding.budget,
    actual: finding.actualDirectories ?? finding.actualMigrations ?? finding.actualOutOfScopeFiles,
    maximum: finding.maxDirectories ?? finding.maxMigrations ?? finding.maxOutOfScopeFiles,
  })), [
    { budget: "maxDirectories", actual: 3, maximum: 1 },
    { budget: "maxMigrations", actual: 2, maximum: 1 },
    { budget: "maxOutOfScopeFiles", actual: 1, maximum: 0 },
  ]);
});

test("forbidden paths are counted separately from the out-of-scope allowance", () => {
  const result = evaluateScopeBudget(taskContract({
    budget: { maxFiles: 10, maxOutOfScopeFiles: 0 },
  }), ["src/admin/auth.mjs", "outside/readme.md"]);
  assert.deepEqual(result.metrics, { files: 2, directories: 2, migrations: 0, outOfScopeFiles: 1, forbiddenFiles: 1 });
  assert.deepEqual(result.findings.map((finding) => finding.budget), ["maxOutOfScopeFiles"]);
});

test("migration counting uses only contract-declared path patterns", () => {
  const result = evaluateScopeBudget(taskContract({
    migrationPaths: ["db/changes/**"],
    budget: { maxFiles: 10, maxMigrations: 0 },
  }), ["migrations/001.sql", "db/changes/001.sql"]);
  assert.equal(result.metrics.migrations, 1);
  assert.deepEqual(result.findings.map((finding) => finding.budget), ["maxMigrations"]);
});
