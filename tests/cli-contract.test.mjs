import assert from "node:assert/strict";
import { readFileSync, realpathSync, rmSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { main } from "../src/cli.mjs";
import { baseConfig, commitAll, git, initGitRepo, temporaryDirectory, write, writeConfig } from "./helpers.mjs";

const identity = { version: "1.1.1", commitSha: "a".repeat(40) };

function sink() {
  let value = "";
  return { stream: { write(chunk) { value += String(chunk); } }, value: () => value };
}

function repository() {
  const repo = initGitRepo();
  write(join(repo, "README.md"), "# Fixture\n");
  commitAll(repo, "initial");
  return repo;
}

test("bootstrap CLI emits its stable JSON contract", async () => {
  const stdout = sink();
  const stderr = sink();
  const code = await main(["bootstrap", "--preset", "node-library", "--json"], {
    cwd: repository(), stdout: stdout.stream, stderr: stderr.stream, identity, verifyInstallation: false, registerRepository: () => ({ registered: true }),
  });
  assert.equal(code, 0);
  assert.equal(stderr.value(), "");
  const report = JSON.parse(stdout.value());
  assert.equal(report.schemaVersion, 1);
  assert.equal(report.command, "bootstrap");
  assert.equal(report.status, "succeeded");
  assert.equal(report.preset.name, "node-library");
  assert.equal(report.checkResult.mode, "adoption");
  assert.equal(report.repositoryRegistration.registered, true);
});

test("automation invocation errors retain the stable blocked envelope", async () => {
  const stdout = sink();
  const stderr = sink();
  const repo = repository();
  const code = await main(["bootstrap", "--json"], {
    cwd: repo, stdout: stdout.stream, stderr: stderr.stream, identity, verifyInstallation: false, registerRepository: () => ({ registered: true }),
  });
  assert.equal(code, 2);
  assert.equal(stdout.value(), "");
  const report = JSON.parse(stderr.value());
  assert.equal(report.command, "bootstrap");
  assert.equal(report.status, "blocked");
  assert.equal(report.error.code, "RG_INVOCATION");
});

test("new CLI parses its public arguments and emits the shared automation envelope", async () => {
  const stdout = sink();
  const stderr = sink();
  const parent = temporaryDirectory("repo-governance-cli-new-");
  const env = {
    ...process.env,
    GIT_AUTHOR_NAME: "Test User",
    GIT_AUTHOR_EMAIL: "test@example.com",
    GIT_COMMITTER_NAME: "Test User",
    GIT_COMMITTER_EMAIL: "test@example.com",
  };
  const code = await main(["new", "service", "--preset", "node-service", "--json"], {
    cwd: parent, env, stdout: stdout.stream, stderr: stderr.stream, identity, verifyInstallation: false, registerRepository: () => ({ registered: true }),
  });
  assert.equal(code, 0);
  assert.equal(stderr.value(), "");
  const report = JSON.parse(stdout.value());
  assert.equal(report.command, "new");
  assert.equal(report.initialized, true);
  assert.match(report.initialCommit, /^[0-9a-f]{40}$/);
  assert.equal(report.repositoryRegistration.registered, true);
});

test("clone CLI registers only the successfully created repository", async () => {
  const source = repository();
  const parent = temporaryDirectory("repo-governance-cli-clone-");
  const env = {
    ...process.env,
    GIT_AUTHOR_NAME: "Test User",
    GIT_AUTHOR_EMAIL: "test@example.com",
    GIT_COMMITTER_NAME: "Test User",
    GIT_COMMITTER_EMAIL: "test@example.com",
  };
  const registrations = [];
  const stdout = sink();
  const stderr = sink();
  const code = await main(["clone", source, "copied", "--preset", "node-library", "--json"], {
    cwd: parent,
    env,
    stdout: stdout.stream,
    stderr: stderr.stream,
    identity,
    verifyInstallation: false,
    registerRepository(path) {
      registrations.push(path);
      return { registered: true, path };
    },
  });
  assert.equal(code, 0);
  assert.equal(stderr.value(), "");
  const report = JSON.parse(stdout.value());
  assert.deepEqual(registrations, [report.repoPath]);
  assert.equal(report.repositoryRegistration.registered, true);
});

test("prepare-pr CLI emits the projected check result without remote writes", async () => {
  const repo = initGitRepo();
  writeConfig(repo, baseConfig());
  write(join(repo, "README.md"), "# Baseline\n");
  commitAll(repo, "initial");
  git(repo, ["checkout", "-b", "feature"]);
  write(join(repo, "README.md"), "# Feature\n");
  commitAll(repo, "feature");
  const stdout = sink();
  const stderr = sink();
  const code = await main(["prepare-pr", "--json"], { cwd: repo, stdout: stdout.stream, stderr: stderr.stream });
  assert.equal(code, 0);
  assert.equal(stderr.value(), "");
  const report = JSON.parse(stdout.value());
  assert.equal(report.command, "prepare-pr");
  assert.equal(report.summary.status, "ready");
  assert.equal(report.sourceCheckResult.mode, "standard");
});

test("verify-execution CLI forwards the exact CI profile and event file", async () => {
  const repo = repository();
  const eventFile = join(temporaryDirectory("repo-governance-cli-event-"), "event.json");
  write(eventFile, "{}");
  const stdout = sink();
  let received;
  const code = await main([
    "verify-execution",
    "--profile", "pr-validation",
    "--ci",
    "--event-file", eventFile,
    "--json",
  ], {
    cwd: repo,
    stdout: stdout.stream,
    verifyCiExecution(_repo, options) {
      received = { repo: _repo, ...options };
      return { ok: true };
    },
  });
  assert.equal(code, 0);
  assert.equal(received.repo, realpathSync(repo));
  assert.equal(received.profileId, "pr-validation");
  assert.equal(received.eventFile, eventFile);
  assert.deepEqual(JSON.parse(stdout.value()), { ok: true });
});

test("verify-execution CLI forwards pre-push remote context and captured stdin", async () => {
  const repo = repository();
  const stdout = sink();
  let received;
  const code = await main([
    "verify-execution",
    "--pre-push=true",
    "--remote", "origin",
    "--remote-url", "example",
    "--json",
  ], {
    cwd: repo,
    stdout: stdout.stream,
    prePushInput: "record\n",
    verifyPrePushExecution(_repo, options) {
      received = { repo: _repo, ...options };
      return { mode: "pre-push" };
    },
  });
  assert.equal(code, 0);
  assert.equal(received.repo, realpathSync(repo));
  assert.equal(received.remote, "origin");
  assert.equal(received.remoteUrl, "example");
  assert.equal(received.input, "record\n");
  assert.deepEqual(JSON.parse(stdout.value()), { mode: "pre-push" });
});

test("hooks connect installs the strict repository wrapper through the verified dispatcher", async () => {
  const repo = repository();
  const home = temporaryDirectory("repo-governance-cli-hooks-");
  const env = { ...process.env, HOME: home, XDG_DATA_HOME: join(home, "data") };
  write(join(env.XDG_DATA_HOME, "repo-governance", "dispatcher"), "#!/bin/sh\nexit 0\n", 0o755);
  const stdout = sink();
  const code = await main(["hooks", "connect", "--json"], { cwd: repo, env, stdout: stdout.stream });
  assert.equal(code, 0);
  const report = JSON.parse(stdout.value());
  assert.equal(report.changed, true);
  assert.match(readFileSync(report.path, "utf8"), /umask 077/);
});

test("preflight CLI treats non-Git state as a normal JSON classification", async () => {
  const cwd = temporaryDirectory("repo-governance-cli-preflight-");
  const env = { ...process.env, HOME: cwd, XDG_DATA_HOME: join(cwd, "data") };
  const stdout = sink();
  const stderr = sink();
  const code = await main(["preflight", "--json"], { cwd, env, stdout: stdout.stream, stderr: stderr.stream, identity });
  assert.equal(code, 1);
  assert.equal(stderr.value(), "");
  const report = JSON.parse(stdout.value());
  assert.equal(report.command, "preflight");
  assert.equal(report.ok, true);
  assert.equal(report.status, "needs_attention");
  assert.equal(report.repoState, "not_git_repo");
  assert.equal(report.repoPath, null);
  assert.equal(report.cwd, realpathSync(cwd));
  assert.deepEqual(report.updateAdvisory, {
    available: false,
    currentVersion: identity.version,
    latestVersion: null,
    versionsBehind: 0,
    securityFixAvailable: false,
    shouldWarn: false,
    reason: "catalog_missing",
    catalogStatus: "missing",
  });
});

test("preflight human summary and CLI help expose the public entry point", async () => {
  const cwd = temporaryDirectory("repo-governance-cli-preflight-human-");
  const stdout = sink();
  const stderr = sink();
  assert.equal(await main(["preflight"], { cwd, stdout: stdout.stream, stderr: stderr.stream, identity }), 1);
  assert.match(stdout.value(), /not a Git repository/);
  assert.equal(stderr.value(), "");

  const helpOutput = sink();
  assert.equal(await main(["help"], { stdout: helpOutput.stream }), 0);
  assert.match(helpOutput.value(), /preflight \[--json\]/);
  assert.match(helpOutput.value(), /repositories register \[path\]/);
  assert.match(helpOutput.value(), /engines prune --dry-run/);
  assert.match(helpOutput.value(), /architecture baseline \[--replace\] \[--json\]/);
  assert.match(helpOutput.value(), /architecture drift \[--json\]/);
  assert.match(helpOutput.value(), /version \[check\]/);
});

test("preflight human output adds a yellow advisory without changing its exit code", async () => {
  const stdout = sink();
  const result = {
    ok: true,
    exitCode: 1,
    message: "Preflight needs attention.",
    updateAdvisory: {
      available: true,
      currentVersion: "1.0.0",
      latestVersion: "1.2.0",
      versionsBehind: 2,
      securityFixAvailable: false,
      shouldWarn: true,
    },
  };
  assert.equal(await main(["preflight"], { stdout: stdout.stream, preflightRepository: () => result }), 1);
  assert.match(stdout.value(), /\u001b\[33mUpdate available:/);
  assert.match(stdout.value(), /Run repo-governance version check/);
});

test("version check emits its stable JSON and human contracts without downloading an update", async () => {
  const result = {
    command: "version check",
    ok: true,
    status: "verified",
    exitCode: 0,
    catalogStatus: "verified",
    updateAdvisory: {
      available: true,
      currentVersion: "1.1.1",
      latestVersion: "1.2.0",
      versionsBehind: 1,
      securityFixAvailable: true,
      shouldWarn: true,
      reason: "security_fix_available",
      catalogStatus: "verified",
    },
    message: "Verified release catalog. No update was downloaded.",
  };
  const jsonOut = sink();
  assert.equal(await main(["version", "check", "--json"], { stdout: jsonOut.stream, identity, checkVersion: async () => result }), 0);
  assert.deepEqual(JSON.parse(jsonOut.value()), result);
  const humanOut = sink();
  assert.equal(await main(["version", "check"], { stdout: humanOut.stream, identity, checkVersion: async () => result }), 0);
  assert.equal(humanOut.value(), `${result.message}\n`);
});

test("preflight invocation errors retain the complete blocked contract", async () => {
  const cwd = temporaryDirectory("repo-governance-cli-preflight-invalid-");
  const stdout = sink();
  const stderr = sink();
  const code = await main(["preflight", "unexpected", "--json"], { cwd, stdout: stdout.stream, stderr: stderr.stream, identity });
  assert.equal(code, 2);
  assert.equal(stdout.value(), "");
  const report = JSON.parse(stderr.value());
  assert.equal(report.ok, false);
  assert.equal(report.status, "blocked");
  assert.equal(report.exitCode, 2);
  assert.equal(report.repoState, "blocked");
  assert.equal(report.repoPath, null);
  assert.equal(report.error.code, "RG_INVOCATION");
  assert.deepEqual(Object.keys(report.inspection), ["gitRepository", "configPresent", "configValid", "engineAligned", "hookConnected"]);
});

test("install CLI keeps human PATH guidance separate from its stable JSON contract", async () => {
  const installation = {
    message: "Created the managed command entry, but the current shell cannot use the bare repo-governance command until PATH is updated.",
    commandPath: "/home/test/.local/bin/repo-governance",
    launcherPath: "/data/repo-governance/launcher/repo-governance-launcher",
    defaultEngineCommitSha: "b".repeat(40),
    pathConfigured: false,
    actionRequired: 'export PATH="/home/test/.local/bin:$PATH"',
  };
  const installReleaseBundle = () => installation;
  const jsonOut = sink();
  assert.equal(await main(["install", "--bundle", "/verified", "--json"], {
    stdout: jsonOut.stream,
    installReleaseBundle,
  }), 0);
  assert.deepEqual(JSON.parse(jsonOut.value()), installation);

  const humanOut = sink();
  assert.equal(await main(["install", "--bundle", "/verified"], {
    stdout: humanOut.stream,
    installReleaseBundle,
  }), 0);
  assert.match(humanOut.value(), /current shell cannot use the bare repo-governance command/);
  assert.match(humanOut.value(), /Action required: export PATH=/);
});

test("update CLI emits a stable human message and structured default engine identity", async () => {
  const repo = repository();
  const result = {
    updated: true,
    engineVersion: "1.2.0",
    engineCommitSha: "b".repeat(40),
    defaultEngineCommitSha: "b".repeat(40),
    message: `Updated repo-governance to 1.2.0 (${"b".repeat(40)}).`,
  };
  const jsonOut = sink();
  assert.equal(await main(["update", "--bundle", "/verified", "--json"], {
    cwd: repo,
    stdout: jsonOut.stream,
    controlledUpdate: () => result,
    registerRepository: () => ({ registered: true }),
  }), 0);
  assert.deepEqual(JSON.parse(jsonOut.value()), result);
  assert.equal(result.repositoryRegistration.registered, true);
  const humanOut = sink();
  assert.equal(await main(["update", "--bundle", "/verified"], {
    cwd: repo,
    stdout: humanOut.stream,
    controlledUpdate: () => result,
    registerRepository: () => ({ registered: true }),
  }), 0);
  assert.equal(humanOut.value(), `${result.message}\n`);
});

test("repository registry CLI supports register, list, and missing-path unregister JSON contracts", async () => {
  const repo = initGitRepo();
  writeConfig(repo, baseConfig({ engineVersion: "1.0.0", engineCommitSha: "a".repeat(40) }));
  const home = temporaryDirectory("repo-governance-cli-registry-");
  const env = { ...process.env, HOME: home, XDG_DATA_HOME: join(home, "data") };
  const registerOut = sink();
  assert.equal(await main(["repositories", "register", repo, "--json"], { env, stdout: registerOut.stream }), 0);
  assert.equal(JSON.parse(registerOut.value()).registered, true);
  const listOut = sink();
  assert.equal(await main(["repositories", "list", "--json"], { env, stdout: listOut.stream }), 0);
  assert.equal(JSON.parse(listOut.value()).repositories.length, 1);
  rmSync(repo, { recursive: true, force: true });
  const unregisterOut = sink();
  assert.equal(await main(["repositories", "unregister", repo, "--json"], { env, stdout: unregisterOut.stream }), 0);
  assert.equal(JSON.parse(unregisterOut.value()).unregistered, true);
});
