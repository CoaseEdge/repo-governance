import assert from "node:assert/strict";
import { join } from "node:path";
import test from "node:test";
import { checkAdoption, checkRepository } from "../src/check.mjs";
import { evaluateTaskDrift } from "../src/task-drift.mjs";
import { TASK_CONTRACT_FILE } from "../src/task-contract.mjs";
import { baseConfig, commitAll, git, initGitRepo, write, writeConfig } from "./helpers.mjs";

function taskContract(overrides = {}) {
  return {
    schemaVersion: 1,
    taskId: "task-drift",
    objective: "Score deterministic task drift",
    allowedPaths: ["src/runtime/**"],
    forbiddenPaths: ["src/admin/**"],
    migrationPaths: ["db/migrations/**"],
    allowedChangeCategories: [],
    drift: {
      subsystems: [
        { id: "search", paths: ["src/search/**"] },
        { id: "admin", paths: ["src/admin/**"] },
      ],
      sharedPaths: ["src/shared/**"],
      ciReleasePaths: [".github/workflows/**"],
    },
    budget: { maxFiles: 50 },
    ...overrides,
  };
}

function writeContract(repo, contract = taskContract()) {
  write(join(repo, TASK_CONTRACT_FILE), `${JSON.stringify(contract, null, 2)}\n`);
}

test("task drift scores unique deterministic evidence with additive rules", () => {
  const changed = [
    "src/shared/util.mjs",
    "src/search/b.mjs",
    TASK_CONTRACT_FILE,
    "outside/readme.md",
    "src/admin/auth.mjs",
    ".github/workflows/release.yml",
    "src/search/a.mjs",
    "db/migrations/001.sql",
    "src/search/b.mjs",
  ];
  const expected = {
    taskDriftScore: 80,
    severity: "high",
    reasons: [
      "Changed out-of-scope file: .github/workflows/release.yml.",
      "Changed out-of-scope file: db/migrations/001.sql.",
      "Changed out-of-scope file: outside/readme.md.",
      "Changed out-of-scope file: src/search/a.mjs.",
      "Changed out-of-scope file: src/search/b.mjs.",
      "Changed out-of-scope file: src/shared/util.mjs.",
      "Touched new subsystem: admin.",
      "Touched new subsystem: search.",
      "Modified shared module file: src/shared/util.mjs.",
      "Modified CI/release file: .github/workflows/release.yml.",
      "Changed migration outside task scope: db/migrations/001.sql.",
    ],
  };
  assert.deepEqual(evaluateTaskDrift(taskContract(), changed), expected);
  assert.deepEqual(evaluateTaskDrift(taskContract(), [...changed].reverse()), expected);
});

test("each drift category uses its fixed weight", () => {
  assert.equal(evaluateTaskDrift(taskContract(), ["outside/file.mjs"]).taskDriftScore, 5);
  assert.equal(evaluateTaskDrift(taskContract(), ["src/admin/auth.mjs"]).taskDriftScore, 10);
  assert.equal(evaluateTaskDrift(taskContract({ allowedPaths: ["src/**"] }), ["src/shared/util.mjs"]).taskDriftScore, 5);
  assert.equal(evaluateTaskDrift(taskContract({ allowedPaths: [".github/**"] }), [".github/workflows/ci.yml"]).taskDriftScore, 10);
  assert.equal(evaluateTaskDrift(taskContract({ forbiddenPaths: ["db/**"] }), ["db/migrations/001.sql"]).taskDriftScore, 15);
});

test("severity boundaries and missing contracts are stable", () => {
  const sharedContract = taskContract({
    allowedPaths: ["**"],
    forbiddenPaths: [],
    drift: { subsystems: [], sharedPaths: ["shared/**"], ciReleasePaths: ["ci/**"] },
  });
  assert.deepEqual(evaluateTaskDrift(null, ["outside/file.mjs"]), { taskDriftScore: 0, severity: "none", reasons: [] });
  assert.equal(evaluateTaskDrift(sharedContract, []).severity, "none");
  assert.equal(evaluateTaskDrift(sharedContract, ["shared/a.mjs"]).severity, "low");
  assert.equal(evaluateTaskDrift(sharedContract, ["shared/a.mjs", "shared/b.mjs", "shared/c.mjs"]).severity, "medium");
  assert.equal(evaluateTaskDrift(sharedContract, ["ci/a.yml", "ci/b.yml", "ci/c.yml"]).severity, "high");
});

test("repository checks expose advisory task drift while adoption remains neutral", () => {
  const repo = initGitRepo();
  writeConfig(repo, baseConfig());
  writeContract(repo);
  write(join(repo, "README.md"), "# Baseline\n");
  const base = commitAll(repo, "task drift baseline");
  git(repo, ["switch", "-c", "feature"]);
  write(join(repo, "src", "shared", "util.mjs"), "export const shared = true;\n");
  commitAll(repo, "shared change");

  const result = checkRepository(repo, { base });
  assert.deepEqual(result.taskDrift, {
    taskDriftScore: 10,
    severity: "low",
    reasons: [
      "Changed out-of-scope file: src/shared/util.mjs.",
      "Modified shared module file: src/shared/util.mjs.",
    ],
  });
  assert.equal(result.ok, true);
  assert.equal(result.exitCode, 0);
  assert.equal(result.findings.some((finding) => finding.type === "TASK_DRIFT"), false);

  const adoption = checkAdoption(repo, { base });
  assert.deepEqual(adoption.taskDrift, { taskDriftScore: 0, severity: "none", reasons: [] });
});
