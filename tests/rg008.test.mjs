import assert from "node:assert/strict";
import { join } from "node:path";
import test from "node:test";
import { checkAdoption, checkRepository } from "../src/check.mjs";
import { evaluateRg008 } from "../src/rg008.mjs";
import { TASK_CONTRACT_FILE } from "../src/task-contract.mjs";
import { baseConfig, commitAll, git, initGitRepo, write, writeConfig } from "./helpers.mjs";

function taskContract(overrides = {}) {
  return {
    schemaVersion: 1,
    taskId: "scope-analyzer",
    objective: "Analyze task scope",
    allowedPaths: ["src/runtime/**"],
    forbiddenPaths: ["src/admin/**"],
    allowedChangeCategories: [],
    budget: { maxFiles: 10 },
    ...overrides,
  };
}

function writeContract(repo, contract = taskContract()) {
  write(join(repo, TASK_CONTRACT_FILE), `${JSON.stringify(contract, null, 2)}\n`);
}

test("allowed paths pass and missing contracts skip", () => {
  assert.deepEqual(evaluateRg008("/repo", taskContract(), ["src/runtime/plan/index.mjs"]), { findings: [] });
  assert.deepEqual(evaluateRg008("/repo", null, ["src/admin/auth.mjs"]), { findings: [] });
});

test("forbidden paths take precedence over deterministic out-of-scope findings", () => {
  const changed = [
    "src/unrelated/view.mjs",
    TASK_CONTRACT_FILE,
    "src/admin/auth.mjs",
    "src/admin/auth.mjs",
  ];
  const expected = [
    {
      rule: "RG008",
      type: "FORBIDDEN_PATH",
      path: "src/admin/auth.mjs",
      message: "File matches a forbidden task path.",
      severity: "error",
      waivable: false,
    },
    {
      rule: "RG008",
      type: "OUT_OF_SCOPE_CHANGE",
      path: "src/unrelated/view.mjs",
      message: "File is outside declared task scope.",
      severity: "warning",
      waivable: false,
    },
  ];
  assert.deepEqual(evaluateRg008("/repo", taskContract(), changed).findings, expected);
  assert.deepEqual(evaluateRg008("/repo", taskContract(), [...changed].reverse()).findings, expected);
});

test("file budgets count unique changes, exclude the task contract, and block", () => {
  const result = evaluateRg008("/repo", taskContract({
    allowedPaths: ["src/**"],
    forbiddenPaths: [],
    budget: { maxFiles: 2 },
  }), ["src/c.mjs", TASK_CONTRACT_FILE, "src/a.mjs", "src/c.mjs", "src/b.mjs"]);
  assert.deepEqual(result.findings, [{
    rule: "RG008",
    type: "BUDGET_EXCEEDED",
    budget: "maxFiles",
    message: "Task changed 3 files, limit is 2.",
    severity: "error",
    waivable: false,
    actualFiles: 3,
    maxFiles: 2,
  }]);

  const combined = evaluateRg008("/repo", taskContract({ budget: { maxFiles: 1 } }), [
    "src/unrelated/view.mjs",
    "src/runtime/plan/index.mjs",
  ]);
  assert.deepEqual(combined.findings.map((finding) => finding.type), ["OUT_OF_SCOPE_CHANGE", "BUDGET_EXCEEDED"]);
});

test("repository checks block forbidden paths while adoption skips scope findings", () => {
  const repo = initGitRepo();
  writeConfig(repo, baseConfig());
  writeContract(repo);
  write(join(repo, "README.md"), "# Baseline\n");
  const base = commitAll(repo, "task scope baseline");
  git(repo, ["switch", "-c", "feature"]);
  write(join(repo, "src", "admin", "auth.mjs"), "export const auth = true;\n");
  commitAll(repo, "forbidden change");

  const result = checkRepository(repo, { base });
  assert.equal(result.ok, false);
  assert.equal(result.exitCode, 1);
  assert.equal(result.scopeFindings.length, 1);
  assert.equal(result.scopeFindings[0].type, "FORBIDDEN_PATH");
  assert.equal(result.scopeFindings[0].severity, "error");
  assert.ok(result.findings.includes(result.scopeFindings[0]));

  const adoption = checkAdoption(repo, { base });
  assert.deepEqual(adoption.scopeFindings, []);
  assert.equal(adoption.findings.some((finding) => finding.rule === "RG008"), false);
});

test("out-of-scope warnings remain advisory until their declared budget is exceeded", () => {
  const allowed = evaluateRg008("/repo", taskContract({
    budget: { maxFiles: 10, maxOutOfScopeFiles: 1 },
  }), ["outside/one.mjs"]);
  assert.deepEqual(allowed.findings.map((finding) => [finding.type, finding.severity]), [["OUT_OF_SCOPE_CHANGE", "warning"]]);

  const blocked = evaluateRg008("/repo", taskContract({
    budget: { maxFiles: 10, maxOutOfScopeFiles: 0 },
  }), ["outside/one.mjs"]);
  assert.deepEqual(blocked.findings.map((finding) => [finding.type, finding.severity]), [
    ["OUT_OF_SCOPE_CHANGE", "warning"],
    ["BUDGET_EXCEEDED", "error"],
  ]);
});

test("repository checks block when the out-of-scope allowance is exceeded", () => {
  const repo = initGitRepo();
  writeConfig(repo, baseConfig());
  writeContract(repo, taskContract({ budget: { maxFiles: 10, maxOutOfScopeFiles: 0 } }));
  write(join(repo, "README.md"), "# Baseline\n");
  const base = commitAll(repo, "task scope baseline");
  git(repo, ["switch", "-c", "feature"]);
  write(join(repo, "outside", "one.mjs"), "export const outside = true;\n");
  commitAll(repo, "out-of-scope change");

  const result = checkRepository(repo, { base });
  assert.equal(result.ok, false);
  assert.equal(result.exitCode, 1);
  assert.deepEqual(result.scopeFindings.map((finding) => [finding.type, finding.severity]), [
    ["OUT_OF_SCOPE_CHANGE", "warning"],
    ["BUDGET_EXCEEDED", "error"],
  ]);
  assert.ok(result.scopeFindings.every((finding) => result.findings.includes(finding)));
});
