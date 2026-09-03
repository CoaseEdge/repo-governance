import { existsSync, mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { execFileSync } from "node:child_process";
import { DIFF_FINGERPRINT_ALGORITHM } from "../src/fingerprint.mjs";
import { governanceOnlyExecutionContract } from "../src/execution-contract.mjs";
import { thinWorkflow } from "../src/workflow.mjs";

export function temporaryDirectory(prefix = "repo-governance-test-") {
  return mkdtempSync(join(tmpdir(), prefix));
}

export function write(path, content, mode) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content, mode ? { mode } : undefined);
}

export function git(repo, args, options = {}) {
  const env = options.env || {
    ...process.env,
    GIT_CONFIG_GLOBAL: process.platform === "win32" ? "NUL" : "/dev/null",
    GIT_CONFIG_NOSYSTEM: "1",
  };
  return execFileSync("git", args, { cwd: repo, encoding: options.binary ? null : "utf8", env });
}

export function initGitRepo() {
  const repo = temporaryDirectory();
  const env = {
    ...process.env,
    GIT_CONFIG_GLOBAL: process.platform === "win32" ? "NUL" : "/dev/null",
    GIT_CONFIG_NOSYSTEM: "1",
  };
  git(repo, ["init", "-b", "main"], { env });
  git(repo, ["config", "user.name", "Test User"], { env });
  git(repo, ["config", "user.email", "test@example.com"], { env });
  return repo;
}

export function commitAll(repo, message) {
  git(repo, ["add", "-A"]);
  git(repo, ["commit", "-m", message]);
  return git(repo, ["rev-parse", "HEAD"]).trim();
}

export function baseConfig(overrides = {}) {
  const engineCommitSha = overrides.engineCommitSha || "development";
  return {
    schemaVersion: 1,
    executionContractVersion: 1,
    governanceCompleteness: "complete",
    ...governanceOnlyExecutionContract(),
    engineVersion: "0.1.0",
    engineCommitSha,
    diffFingerprintAlgorithm: DIFF_FINGERPRINT_ALGORITHM,
    defaultBranch: "main",
    testCategories: {
      unit: ["tests/unit/**"],
      contract: ["tests/contract/**"],
      integration: ["tests/integration/**"],
      frontend: ["tests/frontend/**"],
      "command-contract": ["tests/commands/**"],
      "build-verification": ["tests/build/**"],
    },
    changeCategoryMappings: {},
    highImpactMappings: [],
    managedFiles: [".repo-governance.json"],
    testEntries: [],
    testSupport: [],
    testTiers: { "pr-blocking": [], nightly: [], "manual-smoke": [] },
    commandAliases: {},
    prBlockingCommands: [],
    guards: [],
    policyChecks: [],
    workflowAllowedEntries: [],
    publicCommands: [],
    ...overrides,
  };
}

export function writeConfig(repo, config) {
  write(join(repo, ".repo-governance.json"), `${JSON.stringify(config, null, 2)}\n`);
  const consumer = config.executionProfiles?.flatMap((profile) => profile.consumers || []).find((candidate) => candidate.type === "github-actions");
  if (consumer && !existsSync(join(repo, consumer.workflow))) {
    const engineCommitSha = /^[0-9a-f]{40}$/.test(config.engineCommitSha) ? config.engineCommitSha : "a".repeat(40);
    write(join(repo, consumer.workflow), thinWorkflow({ engineVersion: config.engineVersion, engineCommitSha }));
  }
}
