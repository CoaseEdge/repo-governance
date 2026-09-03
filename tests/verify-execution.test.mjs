import assert from "node:assert/strict";
import { existsSync, mkdirSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { dependencyPreparationDefinitionHash } from "../src/execution-contract.mjs";
import { testEvidencePath } from "../src/execution-evidence.mjs";
import { commandDefinitionHash } from "../src/rg004.mjs";
import { verifyCiExecution, verifyRuntime } from "../src/verify-execution.mjs";
import { baseConfig, commitAll, git, initGitRepo, temporaryDirectory, write, writeConfig } from "./helpers.mjs";

function fixture() {
  const repo = initGitRepo();
  writeConfig(repo, baseConfig());
  write(join(repo, "README.md"), "# Base\n");
  const base = commitAll(repo, "base");
  git(repo, ["switch", "-c", "feature"]);
  write(join(repo, "README.md"), "# Feature\n");
  const feature = commitAll(repo, "feature");
  const eventFile = join(temporaryDirectory("repo-governance-event-"), "event.json");
  write(eventFile, JSON.stringify({ pull_request: { head: { sha: feature }, base: { sha: base } } }));
  return { repo, base, feature, eventFile };
}

function verifiedRuntime(repo, runtime, preparation) {
  return {
    path: "",
    env: {},
    workingDirectory: join(repo, preparation.workingDirectory),
  };
}

test("CI verification binds the event revision, static check, profile, and clean checkout", () => {
  const { repo, base, feature, eventFile } = fixture();
  const calls = [];
  const report = verifyCiExecution(repo, {
    profileId: "pr-validation",
    eventFile,
    runtimeVerifier: verifiedRuntime,
    execute(command, args, options) {
      calls.push({ command, args, cwd: options.cwd });
      return { status: 0, stdout: "", stderr: "" };
    },
  });
  assert.deepEqual(calls, [{ command: "git", args: ["status", "--porcelain=v1"], cwd: repo }]);
  assert.equal(report.revisionSource, "pull-request-head");
  assert.equal(report.eventCommitSha, feature);
  assert.equal(report.testedCommitSha, feature);
  assert.equal(report.canonicalBaseInputSha, base);
  assert.equal(report.sameRevision, true);
  assert.equal(report.executionContractVerified, true);
  assert.equal(report.workflowConsumersVerified, true);
  assert.equal(report.cleanCheckoutVerified, true);
  assert.equal(report.semanticCoverageVerified, false);
});

test("fresh CI checkout satisfies execution-mode RG001 with same-session evidence", () => {
  const source = initGitRepo();
  const definition = "node --test tests/unit/value.test.mjs";
  const config = baseConfig({
    highImpactMappings: [{ businessPaths: ["src/**"], requirements: [{ anyOf: ["unit"], evidenceMode: "execution" }] }],
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
      semantics: "Run the unit suite.",
      tier: "pr-blocking",
      consumers: { contractTests: ["tests/**"], docs: ["README.md"], workflows: [".github/workflows/**"] },
    }],
  });
  config.executionProfiles[0].entry = { publicCommand: "unit-test", argv: ["node", "--test", "tests/unit/value.test.mjs"] };
  config.executionProfiles[0].requiredStages[1].commands = ["package.json#test:unit"];
  writeConfig(source, config);
  write(join(source, "package.json"), `${JSON.stringify({ scripts: { "test:unit": definition } }, null, 2)}\n`);
  write(join(source, "README.md"), "# Fixture\n");
  write(join(source, "src/value.mjs"), "export const value = 1;\n");
  write(join(source, "tests/unit/value.test.mjs"), "import test from 'node:test';\ntest('value', () => {});\n");
  const base = commitAll(source, "base");
  git(source, ["switch", "-c", "feature"]);
  write(join(source, "src/value.mjs"), "export const value = 2;\n");
  const feature = commitAll(source, "feature");

  const parent = temporaryDirectory("repo-governance-clean-checkout-");
  git(parent, ["clone", "--quiet", source, "checkout"]);
  const repo = join(parent, "checkout");
  const eventFile = join(parent, "event.json");
  write(eventFile, JSON.stringify({ pull_request: { head: { sha: feature }, base: { sha: base } } }));

  const report = verifyCiExecution(repo, {
    profileId: "pr-validation",
    eventFile,
    runtimeVerifier(candidate) {
      return { path: process.env.PATH, env: process.env, workingDirectory: candidate };
    },
  });
  assert.equal(existsSync(testEvidencePath(repo)), false);
  assert.equal(report.preExecutionCheck.pendingTestEvidence.length, 1);
  assert.deepEqual(report.executionEvidence, [{ category: "unit", testEntryId: "unit-suite" }]);
  assert.equal(report.staticCheck.ok, true);
  assert.equal(Object.hasOwn(report.staticCheck, "pendingTestEvidence"), false);
  assert.equal(report.staticCheck.satisfied[0].evidenceMode, "execution");
});

test("CI verification rejects a checkout that differs from the event revision", () => {
  const { repo, eventFile } = fixture();
  git(repo, ["reset", "--hard", "HEAD^"]);
  assert.throws(
    () => verifyCiExecution(repo, { profileId: "pr-validation", eventFile, runtimeVerifier: verifiedRuntime }),
    (error) => error.code === "RG_REVISION_MISMATCH",
  );
});

test("CI verification rejects ignored residue before static checks or execution", () => {
  const { repo, feature, base } = fixture();
  write(join(repo, ".gitignore"), "dist/\n");
  const cleanFeature = commitAll(repo, "declare ignored output");
  mkdirSync(join(repo, "dist"));
  write(join(repo, "dist", "output.txt"), "stale\n");
  const eventFile = join(temporaryDirectory("repo-governance-event-"), "event.json");
  write(eventFile, JSON.stringify({ pull_request: { head: { sha: cleanFeature }, base: { sha: base } } }));
  let executions = 0;
  assert.throws(
    () => verifyCiExecution(repo, {
      profileId: "pr-validation",
      eventFile,
      runtimeVerifier: verifiedRuntime,
      execute() { executions += 1; },
    }),
    (error) => error.code === "RG_CLEAN_CHECKOUT",
  );
  assert.equal(executions, 0);
  assert.notEqual(feature, cleanFeature);
});

test("candidate RG006 findings block before runtime and dependency preparation", () => {
  const { repo, base } = fixture();
  const config = baseConfig();
  config.executionProfiles[0].dependencyPreparation.definitionHash = "0".repeat(64);
  writeConfig(repo, config);
  const feature = commitAll(repo, "break execution contract");
  const eventFile = join(temporaryDirectory("repo-governance-event-"), "event.json");
  write(eventFile, JSON.stringify({ pull_request: { head: { sha: feature }, base: { sha: base } } }));
  let runtimeChecks = 0;
  let executions = 0;
  assert.throws(
    () => verifyCiExecution(repo, {
      profileId: "pr-validation",
      eventFile,
      runtimeVerifier() { runtimeChecks += 1; },
      execute() { executions += 1; },
    }),
    (error) => error.code === "RG_STATIC_CHECK" && error.details.findings.some((finding) => finding.rule === "RG006"),
  );
  assert.equal(runtimeChecks, 0);
  assert.equal(executions, 0);
});

test("dependency preparation runs before the declared public entry", () => {
  const { repo, base } = fixture();
  const config = baseConfig();
  const runtime = config.runtimes[0];
  runtime.packageManager = { name: "npm", version: "10.9.2" };
  const preparation = config.executionProfiles[0].dependencyPreparation;
  preparation.adapter = "npm";
  preparation.hookArgv = ["npm", "ci", "--offline", "--ignore-scripts"];
  preparation.ciArgv = ["npm", "ci", "--ignore-scripts"];
  preparation.definitionHash = dependencyPreparationDefinitionHash(runtime, preparation);
  writeConfig(repo, config);
  const feature = commitAll(repo, "declare npm preparation");
  const eventFile = join(temporaryDirectory("repo-governance-event-"), "event.json");
  write(eventFile, JSON.stringify({ pull_request: { head: { sha: feature }, base: { sha: base } } }));
  const calls = [];
  verifyCiExecution(repo, {
    profileId: "pr-validation",
    eventFile,
    runtimeVerifier: verifiedRuntime,
    execute(command, args) {
      calls.push([command, ...args]);
      return { status: 0, stdout: "", stderr: "" };
    },
  });
  assert.deepEqual(calls, [
    ["npm", "ci", "--ignore-scripts"],
    ["git", "status", "--porcelain=v1"],
  ]);
});

test("tracked mutations produced by the profile fail the final clean-checkout proof", () => {
  const { repo, eventFile } = fixture();
  assert.throws(
    () => verifyCiExecution(repo, {
      profileId: "pr-validation",
      eventFile,
      runtimeVerifier: verifiedRuntime,
      execute() {
        write(join(repo, "README.md"), "# Mutated\n");
        return { status: 0, stdout: "", stderr: "" };
      },
    }),
    (error) => error.code === "RG_CLEAN_CHECKOUT",
  );
});

test("package-manager profiles require an external Node command matching the declared runtime", () => {
  const repo = initGitRepo();
  const bin = temporaryDirectory("repo-governance-runtime-bin-");
  symlinkSync("/usr/bin/false", join(bin, "node"));
  const runtime = {
    id: "node22-npm10",
    node: { version: "22.x" },
    packageManager: { name: "npm", version: "10.9.2" },
    systemTools: [],
  };
  assert.throws(
    () => verifyRuntime(repo, runtime, { env: {}, workingDirectory: "." }, { env: { PATH: bin } }),
    (error) => error.code === "RG_RUNTIME" && /Node\.js|node/.test(error.message),
  );
});

test("runtime verification enforces only system tools declared for the active platform", () => {
  const repo = temporaryDirectory();
  const preparation = { workingDirectory: ".", env: {} };
  const runtime = {
    id: "platform-tools",
    systemTools: [{
      name: "missing-darwin-tool",
      sha256: "0".repeat(64),
      platforms: ["darwin"],
    }],
  };
  assert.doesNotThrow(() => verifyRuntime(repo, runtime, preparation, { env: { PATH: "" }, platform: "linux" }));
  assert.throws(
    () => verifyRuntime(repo, runtime, preparation, { env: { PATH: "" }, platform: "darwin" }),
    (error) => error.code === "RG_RUNTIME" && /unavailable/.test(error.message),
  );
});
