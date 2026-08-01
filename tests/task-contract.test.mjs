import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import {
  loadTaskContract,
  TASK_CONTRACT_FILE,
  validateTaskContract,
} from "../src/task-contract.mjs";
import { temporaryDirectory, write } from "./helpers.mjs";

function taskContract(overrides = {}) {
  return {
    schemaVersion: 1,
    taskId: "plan-69-75",
    objective: "Implement Plan lifecycle support",
    allowedPaths: ["src/runtime/plan/**", "src/desktop/runtime/**"],
    forbiddenPaths: ["src/admin/**"],
    migrationPaths: ["db/migrations/**", "migrations/**"],
    allowedChangeCategories: ["tests", "source-code"],
    budget: { maxFiles: 30, maxDirectories: 5, maxMigrations: 2, maxOutOfScopeFiles: 0 },
    ...overrides,
  };
}

function writeContract(repo, contract) {
  write(join(repo, TASK_CONTRACT_FILE), typeof contract === "string" ? contract : `${JSON.stringify(contract, null, 2)}\n`);
}

test("valid task contracts load with deterministic normalization", () => {
  const schema = JSON.parse(readFileSync(new URL("../schemas/task-contract.schema.json", import.meta.url), "utf8"));
  assert.equal(schema.$id, "https://github.com/CoaseEdge/repo-governance/schemas/task-contract.schema.json");
  assert.deepEqual(schema.required, ["schemaVersion", "taskId", "objective", "allowedPaths", "forbiddenPaths", "budget"]);

  const repo = temporaryDirectory();
  writeContract(repo, taskContract({ objective: "  Implement Plan lifecycle support  " }));
  assert.deepEqual(loadTaskContract(repo), {
    schemaVersion: 1,
    taskId: "plan-69-75",
    objective: "Implement Plan lifecycle support",
    allowedPaths: ["src/desktop/runtime/**", "src/runtime/plan/**"],
    forbiddenPaths: ["src/admin/**"],
    migrationPaths: ["db/migrations/**", "migrations/**"],
    allowedChangeCategories: ["source-code", "tests"],
    budget: { maxFiles: 30, maxDirectories: 5, maxMigrations: 2, maxOutOfScopeFiles: 0 },
  });

  const example = taskContract();
  delete example.allowedChangeCategories;
  delete example.migrationPaths;
  example.budget = { maxFiles: 30 };
  assert.deepEqual(validateTaskContract(example).allowedChangeCategories, []);
  assert.deepEqual(validateTaskContract(example).migrationPaths, []);
});

test("invalid task contracts are rejected with RG_TASK_CONTRACT", () => {
  const withoutObjective = taskContract();
  delete withoutObjective.objective;
  const invalidContracts = [
    withoutObjective,
    taskContract({ unexpected: true }),
    taskContract({ allowedPaths: ["../outside/**"] }),
    taskContract({ allowedPaths: ["src/**", "src/**"] }),
    taskContract({ migrationPaths: ["../migrations/**"] }),
    taskContract({ migrationPaths: ["migrations/**", "migrations/**"] }),
    taskContract({ allowedChangeCategories: ["Source Code"] }),
    taskContract({ allowedChangeCategories: null }),
    taskContract({ budget: { maxFiles: 0 } }),
    taskContract({ budget: { maxFiles: 30, maxDirectories: -1 } }),
    taskContract({ budget: { maxFiles: 30, maxMigrations: 1.5 } }),
    taskContract({ migrationPaths: [], budget: { maxFiles: 30, maxMigrations: 1 } }),
    taskContract({ budget: { maxFiles: 30, maxOutOfScopeFiles: -1 } }),
    taskContract({ budget: { maxFiles: 30, unknown: 1 } }),
  ];

  for (const contract of invalidContracts) {
    assert.throws(
      () => validateTaskContract(contract),
      (error) => error.code === "RG_TASK_CONTRACT",
    );
  }

  const repo = temporaryDirectory();
  writeContract(repo, "{ invalid json\n");
  assert.throws(
    () => loadTaskContract(repo),
    (error) => error.code === "RG_TASK_CONTRACT" && error.details.path === TASK_CONTRACT_FILE,
  );
});

test("missing task contracts return null", () => {
  assert.equal(loadTaskContract(temporaryDirectory()), null);
});
