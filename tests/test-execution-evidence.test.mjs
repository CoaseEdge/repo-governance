import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { checkRepository } from "../src/check.mjs";
import { readConfig } from "../src/config.mjs";
import { dependencyPreparationDefinitionHash } from "../src/execution-contract.mjs";
import { resolveCanonicalBase } from "../src/git.mjs";
import { commandDefinitionHash } from "../src/rg004.mjs";
import { executionEvidenceForProfile, loadTestExecutionEvidence, testEvidencePath, verifyTestEntry } from "../src/execution-evidence.mjs";
import { baseConfig, commitAll, git, initGitRepo, write, writeConfig } from "./helpers.mjs";

const definition = "node --test tests/unit/value.test.mjs";

function evidenceConfig(evidenceMode = "execution") {
  const config = baseConfig({
    testCategories: { unit: ["tests/unit/**"] },
    highImpactMappings: [{ businessPaths: ["src/**"], requirements: [{ anyOf: ["unit"], evidenceMode }] }],
    testEntries: [{
      id: "unit-suite",
      type: "command",
      command: definition,
      node: "package.json#test:unit",
      categories: ["unit"],
    }],
    testTiers: { "pr-blocking": ["unit-suite"], nightly: [], "manual-smoke": [] },
    prBlockingCommands: ["package.json#test:unit"],
    publicCommands: [{
      id: "unit-test",
      manifest: "package.json",
      command: "test:unit",
      definitionHash: commandDefinitionHash(definition),
      semantics: "Run the declared unit suite.",
      tier: "pr-blocking",
      consumers: {
        contractTests: ["tests/**"],
        docs: ["README.md"],
        workflows: [".github/workflows/**"],
      },
    }],
  });
  const runtime = config.runtimes[0];
  runtime.packageManager = { name: "npm", version: "10.9.2" };
  const profile = config.executionProfiles[0];
  const preparation = config.executionProfiles[0].dependencyPreparation;
  preparation.id = "npm-ci";
  preparation.adapter = "npm";
  preparation.hookArgv = ["npm", "ci", "--offline", "--ignore-scripts"];
  preparation.ciArgv = ["npm", "ci", "--ignore-scripts"];
  profile.requiredStages[0].commands = ["dependency:npm-ci"];
  preparation.definitionHash = dependencyPreparationDefinitionHash(runtime, preparation);
  return config;
}

function repository(evidenceMode = "execution") {
  const repo = initGitRepo();
  writeConfig(repo, evidenceConfig(evidenceMode));
  write(join(repo, "package.json"), `${JSON.stringify({ scripts: { "test:unit": definition } }, null, 2)}\n`);
  write(join(repo, "README.md"), "# Fixture\n");
  write(join(repo, "src/value.mjs"), "export const value = 1;\n");
  write(join(repo, "tests/unit/value.test.mjs"), "import test from 'node:test';\ntest('value', () => {});\n");
  commitAll(repo, "baseline");
  git(repo, ["switch", "-c", "feature"]);
  write(join(repo, "src/value.mjs"), "export const value = 2;\n");
  commitAll(repo, "feature");
  return repo;
}

test("successful declared execution writes current-diff evidence and satisfies RG001", () => {
  const repo = repository();
  assert.equal(checkRepository(repo, { base: "main" }).ok, false);
  const calls = [];
  const receipt = verifyTestEntry(repo, {
    entryId: "unit-suite",
    base: "main",
    execute(command, args, options) {
      calls.push({ command, args, cwd: options.cwd });
      return { status: 0, stdout: "", stderr: "" };
    },
  });
  assert.deepEqual(calls, [{ command: "npm", args: ["run", "test:unit"], cwd: repo }]);
  assert.equal(receipt.alreadyVerified, false);
  assert.equal(receipt.result, "pass");
  assert.equal(existsSync(testEvidencePath(repo)), true);
  assert.equal(git(repo, ["status", "--porcelain"]), "");

  const check = checkRepository(repo, { base: "main" });
  assert.equal(check.ok, true, JSON.stringify(check.findings));
  assert.deepEqual(check.satisfied[0].actualEvidence, [{ category: "unit", testEntries: ["unit-suite"] }]);
  assert.match(check.capabilityBoundary, /execution receipt.*does not prove/i);
});

test("same diff and command return alreadyVerified without rerunning", () => {
  const repo = repository("either");
  let executions = 0;
  const execute = () => {
    executions += 1;
    return { status: 0, stdout: "", stderr: "" };
  };
  assert.equal(verifyTestEntry(repo, { entryId: "unit-suite", base: "main", execute }).alreadyVerified, false);
  assert.equal(verifyTestEntry(repo, { entryId: "unit-suite", base: "main", execute }).alreadyVerified, true);
  assert.equal(executions, 1);
});

test("a changed diff invalidates prior execution evidence", () => {
  const repo = repository();
  verifyTestEntry(repo, {
    entryId: "unit-suite",
    base: "main",
    execute: () => ({ status: 0, stdout: "", stderr: "" }),
  });
  write(join(repo, "src/value.mjs"), "export const value = 3;\n");
  commitAll(repo, "change diff");
  assert.equal(checkRepository(repo, { base: "main" }).ok, false);
});

test("a changed declared command identity invalidates evidence on the same diff", () => {
  const repo = repository();
  verifyTestEntry(repo, {
    entryId: "unit-suite",
    base: "main",
    execute: () => ({ status: 0, stdout: "", stderr: "" }),
  });
  const config = readConfig(repo);
  config.publicCommands[0].definitionHash = "f".repeat(64);
  const endpoints = resolveCanonicalBase(repo, "main", "HEAD");
  assert.deepEqual(loadTestExecutionEvidence(repo, config, endpoints.canonicalBaseSha, endpoints.headSha), []);
});

test("failed execution does not write a PASS receipt", () => {
  const repo = repository();
  assert.throws(
    () => verifyTestEntry(repo, {
      entryId: "unit-suite",
      base: "main",
      execute: () => ({ status: 1, stdout: "", stderr: "failed" }),
    }),
    /did not report a successful result/,
  );
  assert.equal(existsSync(testEvidencePath(repo)), false);
});

test("receipt stores one diff fingerprint, declared command identity, and PASS result", () => {
  const repo = repository();
  verifyTestEntry(repo, {
    entryId: "unit-suite",
    base: "main",
    execute: () => ({ status: 0, stdout: "", stderr: "" }),
  });
  const stored = JSON.parse(readFileSync(testEvidencePath(repo), "utf8"));
  assert.equal(stored.schemaVersion, 1);
  assert.equal(stored.receipts.length, 1);
  assert.match(stored.receipts[0].diffFingerprint, /^[0-9a-f]{64}$/);
  assert.equal(stored.receipts[0].commandIdentity.testEntryId, "unit-suite");
  assert.equal(stored.receipts[0].commandIdentity.publicCommand.id, "unit-test");
  assert.equal(stored.receipts[0].result, "pass");
});

test("execution profile evidence comes only from reachable declared test entries", () => {
  const repo = repository();
  const config = readConfig(repo);
  config.executionProfiles[0].entry.publicCommand = "unit-test";
  assert.deepEqual(executionEvidenceForProfile(repo, config, config.executionProfiles[0]), [
    { category: "unit", testEntryId: "unit-suite" },
  ]);
});
