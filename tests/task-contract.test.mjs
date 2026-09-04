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
    drift: {
      subsystems: [
        { id: "search", paths: ["src/search/**"] },
        { id: "admin", paths: ["src/admin/**"] },
      ],
      sharedPaths: ["src/shared/**", "packages/shared/**"],
      ciReleasePaths: ["scripts/release/**", ".github/workflows/**"],
    },
    budget: { maxFiles: 30, maxDirectories: 5, maxMigrations: 2, maxOutOfScopeFiles: 0 },
    ...overrides,
  };
}

function taskContractV2(overrides = {}) {
  return {
    schemaVersion: 2,
    taskId: "fix-login-button",
    objective: "Fix login button alignment",
    engineeringProfile: "small",
    allowedPaths: ["tests/login/**", "src/login/**"],
    forbiddenPaths: [],
    allowedChangeCategories: ["tests", "source"],
    budget: {
      maxFiles: 4,
      maxDirectories: 2,
      maxOutOfScopeFiles: 0,
      maxNewFiles: 1,
      maxAddedLines: 200,
      maxTestFiles: 1,
      maxTestAddedLines: 120,
    },
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
    drift: {
      subsystems: [
        { id: "admin", paths: ["src/admin/**"] },
        { id: "search", paths: ["src/search/**"] },
      ],
      sharedPaths: ["packages/shared/**", "src/shared/**"],
      ciReleasePaths: [".github/workflows/**", "scripts/release/**"],
    },
    budget: { maxFiles: 30, maxDirectories: 5, maxMigrations: 2, maxOutOfScopeFiles: 0 },
  });

  const example = taskContract();
  delete example.allowedChangeCategories;
  delete example.migrationPaths;
  delete example.drift;
  example.budget = { maxFiles: 30 };
  assert.deepEqual(validateTaskContract(example).allowedChangeCategories, []);
  assert.deepEqual(validateTaskContract(example).migrationPaths, []);
  assert.deepEqual(validateTaskContract(example).drift, { subsystems: [], sharedPaths: [], ciReleasePaths: [] });
});

test("version 2 task contracts load with strict deterministic normalization", () => {
  const contract = validateTaskContract(taskContractV2({ objective: "  Fix login button alignment  " }));

  assert.deepEqual(contract, {
    schemaVersion: 2,
    taskId: "fix-login-button",
    objective: "Fix login button alignment",
    engineeringProfile: "small",
    allowedPaths: ["src/login/**", "tests/login/**"],
    forbiddenPaths: [],
    migrationPaths: [],
    allowedChangeCategories: ["source", "tests"],
    drift: { subsystems: [], sharedPaths: [], ciReleasePaths: [] },
    budget: {
      maxFiles: 4,
      maxDirectories: 2,
      maxOutOfScopeFiles: 0,
      maxNewFiles: 1,
      maxAddedLines: 200,
      maxTestFiles: 1,
      maxTestAddedLines: 120,
    },
  });
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
    taskContract({ drift: { unknown: [] } }),
    taskContract({ drift: null }),
    taskContract({ drift: { subsystems: null } }),
    taskContract({ drift: { subsystems: [{ id: "Admin", paths: ["src/admin/**"] }] } }),
    taskContract({ drift: { subsystems: [{ id: "admin", paths: [] }] } }),
    taskContract({ drift: { subsystems: [{ id: "admin", paths: ["../admin/**"] }] } }),
    taskContract({ drift: { subsystems: [{ id: "admin", paths: ["src/admin/**"], unknown: true }] } }),
    taskContract({ drift: { subsystems: [{ id: "admin", paths: ["src/admin/**"] }, { id: "admin", paths: ["admin/**"] }] } }),
    taskContract({ drift: { subsystems: [{ id: "admin", paths: ["src/admin/**"] }, { id: "other", paths: ["src/admin/**"] }] } }),
    taskContract({ drift: { sharedPaths: ["src/shared/**", "src/shared/**"] } }),
    taskContract({ drift: { ciReleasePaths: ["../release/**"] } }),
    taskContract({ budget: { maxFiles: 0 } }),
    taskContract({ budget: { maxFiles: 30, maxDirectories: -1 } }),
    taskContract({ budget: { maxFiles: 30, maxMigrations: 1.5 } }),
    taskContract({ migrationPaths: [], budget: { maxFiles: 30, maxMigrations: 1 } }),
    taskContract({ budget: { maxFiles: 30, maxOutOfScopeFiles: -1 } }),
    taskContract({ budget: { maxFiles: 30, unknown: 1 } }),
    taskContract({ schemaVersion: 3 }),
    taskContract({ engineeringProfile: "small" }),
    taskContract({ budget: { maxFiles: 30, maxNewFiles: 1 } }),
    taskContractV2({ engineeringProfile: "low" }),
    taskContractV2({ engineeringProfile: undefined }),
    taskContractV2({ unexpected: true }),
    taskContractV2({ budget: { maxFiles: 4, maxNewFiles: -1 } }),
    taskContractV2({ budget: { maxFiles: 4, maxAddedLines: 1.5 } }),
    taskContractV2({ budget: { maxFiles: 4, maxTestFiles: -1 } }),
    taskContractV2({ budget: { maxFiles: 4, maxTestAddedLines: -1 } }),
    taskContractV2({ budget: { maxFiles: 4, unknown: 1 } }),
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
