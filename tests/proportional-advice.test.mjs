import assert from "node:assert/strict";
import { join } from "node:path";
import test from "node:test";
import { checkRepository } from "../src/check.mjs";
import { main } from "../src/cli.mjs";
import { DEFAULT_VERIFICATION_POLICY, resolveVerificationAdvice } from "../src/engineering-profile.mjs";
import { preparePullRequest } from "../src/prepare-pr.mjs";
import { TASK_CONTRACT_FILE } from "../src/task-contract.mjs";
import { baseConfig, commitAll, git, initGitRepo, write, writeConfig } from "./helpers.mjs";

function contract(overrides = {}) {
  return {
    schemaVersion: 2,
    taskId: "verification-advice",
    objective: "Emit proportional verification and stopping advice",
    engineeringProfile: "small",
    allowedPaths: ["src/**"],
    forbiddenPaths: [],
    allowedChangeCategories: ["source"],
    budget: { maxFiles: 2, maxAddedLines: 10 },
    ...overrides,
  };
}

function featureRepository(contractOverrides = {}, configOverrides = {}) {
  const repo = initGitRepo();
  writeConfig(repo, baseConfig(configOverrides));
  write(join(repo, TASK_CONTRACT_FILE), `${JSON.stringify(contract(contractOverrides), null, 2)}\n`);
  write(join(repo, "src/value.mjs"), "export const value = 1;\n");
  commitAll(repo, "baseline");
  git(repo, ["checkout", "-b", "feature"]);
  write(join(repo, "src/value.mjs"), "export const value = 2;\n");
  commitAll(repo, "feature");
  return repo;
}

function sink() {
  let value = "";
  return { stream: { write(chunk) { value += String(chunk); } }, value: () => value };
}

test("verification advice has deterministic defaults for every effective profile", () => {
  assert.deepEqual(DEFAULT_VERIFICATION_POLICY, {
    small: "targeted",
    standard: "targeted-plus-related",
    high: "broad",
    critical: "full",
  });
  assert.deepEqual(resolveVerificationAdvice({ effective: "critical" }, {}), {
    profile: "critical",
    requiredLevel: "full",
    fullSuiteRequired: true,
  });
  assert.equal(resolveVerificationAdvice(null, {}), null);
});

test("repository profile policy determines verification advice", () => {
  const engineeringProfiles = {
    small: { verification: "targeted-plus-related" },
    standard: { verification: "targeted-plus-related" },
    high: { verification: "broad" },
    critical: { verification: "full" },
  };
  assert.deepEqual(resolveVerificationAdvice({ effective: "small" }, { engineeringProfiles }), {
    profile: "small",
    requiredLevel: "targeted-plus-related",
    fullSuiteRequired: false,
  });
});

test("check and prepare-pr emit the same successful governance advice", () => {
  const repo = featureRepository();
  const check = checkRepository(repo, { base: "main" });
  assert.deepEqual(check.verificationAdvice, {
    profile: "small",
    requiredLevel: "targeted",
    fullSuiteRequired: false,
  });
  assert.equal(check.governanceDecision, "satisfied");
  assert.deepEqual(check.stopAdvice, {
    action: "stop-if-objective-satisfied",
  });

  const prepared = preparePullRequest(repo);
  assert.deepEqual(prepared.verificationAdvice, check.verificationAdvice);
  assert.equal(prepared.governanceDecision, check.governanceDecision);
  assert.deepEqual(prepared.stopAdvice, check.stopAdvice);
  assert.equal(Object.hasOwn(prepared.stopAdvice, "objectiveSatisfied"), false);
});

test("check and prepare-pr JSON commands expose proportional advice", async () => {
  const repo = featureRepository();
  const checkOutput = sink();
  const prepareOutput = sink();
  assert.equal(await main(["check", "--base", "main", "--json"], { cwd: repo, stdout: checkOutput.stream, stderr: sink().stream }), 0);
  assert.equal(await main(["prepare-pr", "--base", "main", "--json"], { cwd: repo, stdout: prepareOutput.stream, stderr: sink().stream }), 0);

  const check = JSON.parse(checkOutput.value());
  const prepared = JSON.parse(prepareOutput.value());
  assert.deepEqual(prepared.verificationAdvice, check.verificationAdvice);
  assert.deepEqual(prepared.stopAdvice, check.stopAdvice);
});

test("blocking findings never produce stop advice", () => {
  const repo = featureRepository({ budget: { maxFiles: 2, maxAddedLines: 0 } });
  const check = checkRepository(repo, { base: "main" });
  assert.equal(check.ok, false);
  assert.equal(check.governanceDecision, "blocked");
  assert.deepEqual(check.stopAdvice, {
    action: "resolve-governance-findings",
  });
  assert.deepEqual(preparePullRequest(repo).stopAdvice, check.stopAdvice);
});

test("scope warnings require confirmation even when the overall check passes", () => {
  const repo = featureRepository();
  write(join(repo, "outside/note.txt"), "outside\n");
  commitAll(repo, "outside scope");

  const check = checkRepository(repo, { base: "main" });
  assert.equal(check.ok, true);
  assert.equal(check.governanceDecision, "needs-confirmation");
  assert.deepEqual(check.stopAdvice, { action: "confirm-scope" });
  const prepared = preparePullRequest(repo);
  assert.equal(prepared.status, "needs_attention");
  assert.equal(prepared.summary.status, "needs-confirmation");
  assert.deepEqual(prepared.nextActions.map((action) => action.id), ["confirm-scope"]);
});

test("medium task drift requires confirmation without an RG008 warning", () => {
  const repo = featureRepository({
    drift: {
      subsystems: [],
      sharedPaths: ["src/**"],
      ciReleasePaths: ["src/**"],
    },
  });

  const check = checkRepository(repo, { base: "main" });
  assert.deepEqual(check.scopeFindings, []);
  assert.equal(check.taskDrift.severity, "medium");
  assert.equal(check.governanceDecision, "needs-confirmation");
  assert.deepEqual(check.stopAdvice, { action: "confirm-scope" });
});
