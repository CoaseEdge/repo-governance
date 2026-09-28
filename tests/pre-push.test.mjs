import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import test from "node:test";
import { verifyPrePushExecution } from "../src/pre-push.mjs";
import { baseConfig, commitAll, git, initGitRepo, temporaryDirectory, write, writeConfig } from "./helpers.mjs";

const ZERO_SHA = "0".repeat(40);

function fixture() {
  const repo = initGitRepo();
  writeConfig(repo, baseConfig());
  write(join(repo, "README.md"), "# Base\n");
  const base = commitAll(repo, "base");
  const remote = join(temporaryDirectory("repo-governance-pre-push-remote-"), "remote.git");
  git(repo, ["init", "--bare", "-b", "main", remote]);
  git(repo, ["remote", "add", "origin", remote]);
  git(repo, ["push", "-u", "origin", "main"]);
  git(repo, ["switch", "-c", "feature"]);
  write(join(repo, "README.md"), "# Feature\n");
  const feature = commitAll(repo, "feature");
  return { repo, remote, base, feature };
}

test("pre-push verifies the pushed tip in an isolated checkout and reports the exact base", () => {
  const { repo, remote, base, feature } = fixture();
  write(join(repo, "dist", "stale.txt"), "source-only ignored residue\n");
  write(join(repo, ".git", "info", "exclude"), "dist/\n");
  const result = verifyPrePushExecution(repo, {
    remote: "origin",
    remoteUrl: remote,
    input: `refs/heads/feature ${feature} refs/heads/feature ${ZERO_SHA}\n`,
  });
  assert.equal(result.reports.length, 1);
  assert.equal(result.reports[0].pushedCommitSha, feature);
  assert.equal(result.reports[0].testedCommitSha, feature);
  assert.equal(result.reports[0].sameRevision, true);
  assert.equal(result.reports[0].canonicalBaseInputSha, base);
  assert.equal(result.reports[0].cleanCheckoutVerified, true);
});

test("multiple refs with the same tip and base execute once and retain every ref report", () => {
  const { repo, remote, feature } = fixture();
  git(repo, ["tag", "release-candidate", feature]);
  let executions = 0;
  let isolatedCheckout;
  const result = verifyPrePushExecution(repo, {
    remote: "origin",
    remoteUrl: remote,
    input: [
      `refs/heads/feature ${feature} refs/heads/feature ${ZERO_SHA}`,
      `refs/tags/release-candidate ${feature} refs/tags/release-candidate ${ZERO_SHA}`,
    ].join("\n"),
    verify(checkout, options) {
      executions += 1;
      isolatedCheckout = checkout;
      assert.equal(options.revision.eventCommitSha, feature);
      return {
        testedCommitSha: feature,
        canonicalBaseSha: options.revision.canonicalBaseInputSha,
        executionContractVersion: 1,
        prePushProtocolVersion: 1,
        executionContractVerified: true,
        workflowConsumersVerified: true,
        cleanCheckoutVerified: true,
        semanticCoverageVerified: false,
      };
    },
  });
  assert.equal(executions, 1);
  assert.deepEqual(result.reports.map((report) => report.ref), ["refs/heads/feature", "refs/tags/release-candidate"]);
  assert.equal(existsSync(isolatedCheckout), false);
});

test("deletion-only push skips execution", () => {
  const { repo, remote } = fixture();
  let executions = 0;
  const result = verifyPrePushExecution(repo, {
    remote: "origin",
    remoteUrl: remote,
    input: `(delete) ${ZERO_SHA} refs/heads/old ${"a".repeat(40)}\n`,
    verify() { executions += 1; },
  });
  assert.equal(executions, 0);
  assert.deepEqual(result.skipped, [{ ref: "refs/heads/old", reason: "delete" }]);
});

test("real worktree pushes isolate hook Git variables and preserve the source worktree", (t) => {
  const root = temporaryDirectory("repo-governance-worktree-push-");
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const repo = join(root, "repo");
  const worktree = join(root, "worktree");
  const remote = join(root, "remote.git");
  const home = join(root, "home");
  const template = join(root, "template");
  mkdirSync(home);
  mkdirSync(template);
  const env = {
    ...process.env,
    HOME: home,
    XDG_CONFIG_HOME: home,
    GIT_CONFIG_GLOBAL: process.platform === "win32" ? "NUL" : "/dev/null",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_TEMPLATE_DIR: template,
  };
  const isolatedGit = (cwd, args, gitEnv = env) => git(cwd, args, { env: gitEnv }).trim();
  isolatedGit(root, ["init", "-b", "main", repo]);
  isolatedGit(root, ["init", "--bare", "-b", "main", remote]);
  isolatedGit(repo, ["config", "user.name", "Test User"]);
  isolatedGit(repo, ["config", "user.email", "test@example.com"]);
  writeConfig(repo, baseConfig());
  write(join(repo, "README.md"), "base\n");
  isolatedGit(repo, ["add", "."]);
  isolatedGit(repo, ["commit", "-m", "base"]);
  const base = isolatedGit(repo, ["rev-parse", "HEAD"]);
  isolatedGit(repo, ["remote", "add", "origin", remote]);
  isolatedGit(repo, ["push", "-u", "origin", "main"]);
  isolatedGit(repo, ["worktree", "add", "-b", "feature", worktree]);
  write(join(worktree, "README.md"), "candidate\n");
  isolatedGit(worktree, ["commit", "-am", "candidate"]);
  const candidate = isolatedGit(worktree, ["rev-parse", "HEAD"]);
  write(join(worktree, "README.md"), "later HEAD\n");
  isolatedGit(worktree, ["commit", "-am", "later"]);
  write(join(worktree, "README.md"), "staged\n");
  isolatedGit(worktree, ["add", "README.md"]);
  write(join(worktree, "README.md"), "unstaged\n");
  write(join(worktree, "untracked.txt"), "untracked\n");

  const index = resolve(worktree, isolatedGit(worktree, ["rev-parse", "--git-path", "index"]));
  const snapshot = () => ({
    head: isolatedGit(worktree, ["rev-parse", "HEAD"]),
    branch: isolatedGit(worktree, ["symbolic-ref", "HEAD"]),
    index: readFileSync(index).toString("hex"),
    file: readFileSync(join(worktree, "README.md"), "utf8"),
    untracked: readFileSync(join(worktree, "untracked.txt"), "utf8"),
  });
  const before = snapshot();
  const reportPath = join(root, "report.json");
  const runner = join(root, "hook.mjs");
  write(runner, `
import { readFileSync, writeFileSync } from "node:fs";
import { verifyPrePushExecution } from ${JSON.stringify(new URL("../src/pre-push.mjs", import.meta.url).href)};
const hookGitDir = process.env.GIT_DIR;
const result = verifyPrePushExecution(process.cwd(), {
  remote: process.argv[2], remoteUrl: process.argv[3], input: readFileSync(0, "utf8"),
});
writeFileSync(${JSON.stringify(reportPath)}, JSON.stringify({ hookGitDir, result }));
`);
  const shellQuote = (value) => `'${value.replaceAll("'", "'\\''")}'`;
  write(join(repo, ".git", "hooks", "pre-push"),
    `#!/bin/sh\nexec ${shellQuote(process.execPath)} ${shellQuote(runner)} "$@"\n`, 0o755);

  for (const [name, gitEnv] of [
    ["natural", env],
    ["explicit", { ...env, GIT_WORK_TREE: worktree, GIT_COMMON_DIR: join(repo, ".git"), GIT_INDEX_FILE: index }],
  ]) {
    isolatedGit(worktree, ["push", "origin", `${candidate}:refs/heads/${name}`], gitEnv);
    const { hookGitDir, result } = JSON.parse(readFileSync(reportPath, "utf8"));
    assert.ok(hookGitDir, "Git must supply the real worktree Hook environment");
    assert.equal(result.reports.length, 1);
    assert.equal(result.reports[0].testedCommitSha, candidate);
    assert.equal(result.reports[0].sameRevision, true);
    assert.equal(result.reports[0].canonicalBaseInputSha, base);
    assert.equal(result.reports[0].cleanCheckoutVerified, true);
    assert.equal(isolatedGit(remote, ["rev-parse", `refs/heads/${name}`]), candidate);
    assert.deepEqual(snapshot(), before);
  }
});
