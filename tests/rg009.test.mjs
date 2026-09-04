import assert from "node:assert/strict";
import { join } from "node:path";
import test from "node:test";
import { checkRepository } from "../src/check.mjs";
import { evaluateRg009 } from "../src/rg009.mjs";
import { TASK_CONTRACT_FILE } from "../src/task-contract.mjs";
import { baseConfig, commitAll, initGitRepo, write, writeConfig } from "./helpers.mjs";

function contract(overrides = {}) {
  return {
    schemaVersion: 2,
    taskId: "fix-login-button",
    objective: "Fix login button alignment",
    engineeringProfile: "small",
    allowedPaths: ["src/login/**", "tests/login/**"],
    forbiddenPaths: [],
    allowedChangeCategories: ["source", "tests"],
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

function metrics(overrides = {}) {
  return {
    changedFiles: 2,
    newFiles: 1,
    directories: 2,
    addedLines: 60,
    deletedLines: 0,
    testFiles: 1,
    testAddedLines: 40,
    migrationFiles: 0,
    outOfScopeFiles: 0,
    ...overrides,
  };
}

function lines(prefix, count) {
  return `${Array.from({ length: count }, (_, index) => `${prefix}-${index + 1}`).join("\n")}\n`;
}

test("implementation plus proportionate tests stays within every RG009 budget", () => {
  assert.deepEqual(evaluateRg009(contract(), metrics()), { evaluated: true, findings: [] });
});

test("RG009 reports each exceeded version 2 budget in contract order", () => {
  const testHeavy = evaluateRg009(
    contract({ budget: { ...contract().budget, maxAddedLines: 1000 } }),
    metrics({ addedLines: 520, testAddedLines: 500 }),
  );
  assert.deepEqual(testHeavy.findings, [{
    rule: "RG009",
    type: "COMPLEXITY_BUDGET_EXCEEDED",
    budget: "maxTestAddedLines",
    actual: 500,
    limit: 120,
    severity: "error",
    waivable: false,
  }]);

  const sourceHeavy = evaluateRg009(contract(), metrics({ newFiles: 0, addedLines: 900, testFiles: 0, testAddedLines: 0 }));
  assert.deepEqual(sourceHeavy.findings.map((finding) => finding.budget), ["maxAddedLines"]);

  const fileHeavy = evaluateRg009(contract(), metrics({ newFiles: 8, addedLines: 80 }));
  assert.deepEqual(fileHeavy.findings.map((finding) => finding.budget), ["maxNewFiles"]);

  const combined = evaluateRg009(contract(), metrics({ newFiles: 8, addedLines: 900, testFiles: 3, testAddedLines: 500 }));
  assert.deepEqual(combined.findings.map((finding) => finding.budget), [
    "maxNewFiles",
    "maxAddedLines",
    "maxTestFiles",
    "maxTestAddedLines",
  ]);
});

test("version 1 task contracts do not evaluate RG009", () => {
  const version1 = contract({ schemaVersion: 1 });
  delete version1.engineeringProfile;
  version1.budget = { maxFiles: 4 };
  assert.deepEqual(evaluateRg009(version1, metrics({ addedLines: 900 })), { evaluated: false, findings: [] });
});

test("repository checks include blocking RG009 findings from the Git diff", () => {
  const repo = initGitRepo();
  writeConfig(repo, baseConfig({ testCategories: { unit: ["tests/**/*.test.mjs"] } }));
  const taskContract = contract({ budget: { ...contract().budget, maxNewFiles: 2, maxAddedLines: 1000 } });
  write(join(repo, TASK_CONTRACT_FILE), `${JSON.stringify(taskContract, null, 2)}\n`);
  write(join(repo, "src/login/button.mjs"), "baseline\n");
  const base = commitAll(repo, "baseline");
  write(join(repo, "src/login/button.mjs"), `baseline\n${lines("source", 20)}`);
  write(join(repo, "tests/login/button.test.mjs"), lines("test", 500));
  commitAll(repo, "test-heavy change");

  const result = checkRepository(repo, { base });
  assert.equal(result.ok, false);
  assert.deepEqual(result.findings.filter((finding) => finding.rule === "RG009"), [{
    rule: "RG009",
    type: "COMPLEXITY_BUDGET_EXCEEDED",
    budget: "maxTestAddedLines",
    actual: 500,
    limit: 120,
    severity: "error",
    waivable: false,
  }]);
});
