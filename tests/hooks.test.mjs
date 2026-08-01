import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import {
  connectEffectiveRepositoryHook,
  disconnectEffectiveRepositoryHook,
  doctorHooks,
  installFutureHooks,
  uninstallFutureHooks,
} from "../src/hooks.mjs";
import { installRuntimeEntries } from "../src/launcher-install.mjs";
import { git, initGitRepo, temporaryDirectory, write } from "./helpers.mjs";

function isolatedEnv() {
  const home = temporaryDirectory("repo-governance-home-");
  return {
    ...process.env,
    HOME: home,
    XDG_CONFIG_HOME: join(home, ".config"),
    XDG_DATA_HOME: join(home, ".local", "share"),
    GIT_CONFIG_NOSYSTEM: "1",
  };
}

function dispatcher(env) {
  const path = join(env.HOME, "dispatcher-source");
  write(path, "#!/bin/sh\nexit 0\n", 0o755);
  return path;
}

test("future hook installation and uninstall are reversible in an isolated HOME", () => {
  const env = isolatedEnv();
  const installed = installFutureHooks({ env, dispatcherSource: dispatcher(env) });
  assert.equal(git(env.HOME, ["config", "--global", "--get", "init.templateDir"], { env }).trim(), installed.managedTemplate);
  assert.match(readFileSync(join(installed.managedTemplate, "hooks", "pre-push"), "utf8"), /stable-dispatcher/);
  const result = uninstallFutureHooks({ env });
  assert.equal(result.restoredTemplate, null);
  assert.equal(existsSync(installed.managedTemplate), false);
  assert.equal(existsSync(join(env.XDG_DATA_HOME, "repo-governance", "dispatcher")), true);
});

test("existing global template requires compose and preserves its pre-push as a sidecar", () => {
  const env = isolatedEnv();
  const original = join(env.HOME, "original-template");
  mkdirSync(join(original, "hooks"), { recursive: true });
  git(env.HOME, ["config", "--global", "init.templateDir", original], { env });
  assert.throws(() => installFutureHooks({ env, dispatcherSource: dispatcher(env) }), /already exists/);
  write(join(original, "hooks", "pre-push"), "#!/bin/sh\necho original\n", 0o755);
  const installed = installFutureHooks({ env, dispatcherSource: dispatcher(env), compose: true });
  assert.equal(git(env.HOME, ["config", "--global", "--get", "init.templateDir"], { env }).trim(), installed.managedTemplate);
  assert.equal(readFileSync(join(installed.managedTemplate, "hooks", "pre-push.repo-governance-original"), "utf8"), "#!/bin/sh\necho original\n");
});

test("doctor blocks a stale composition after the original template changes", () => {
  const env = isolatedEnv();
  const original = join(env.HOME, "original-template");
  write(join(original, "description"), "original\n");
  git(env.HOME, ["config", "--global", "init.templateDir", original], { env });
  installFutureHooks({ env, dispatcherSource: dispatcher(env), compose: true });
  const repo = initGitRepo();
  assert.equal(doctorHooks(repo, { env }).ok, true);
  assert.equal(doctorHooks(repo, { env, strict: true }).ok, false);
  assert.equal(doctorHooks(repo, { env, strict: true }).hookConnected, false);
  write(join(original, "description"), "changed later\n");
  const result = doctorHooks(repo, { env });
  assert.equal(result.ok, false);
  assert.match(result.issues.join("\n"), /changed after composition/);
});

test("uninstall refuses to overwrite a newer user template setting", () => {
  const env = isolatedEnv();
  installFutureHooks({ env, dispatcherSource: dispatcher(env) });
  const newer = join(env.HOME, "newer-template");
  git(env.HOME, ["config", "--global", "init.templateDir", newer], { env });
  assert.throws(() => uninstallFutureHooks({ env }), /refusing to overwrite/);
});

test("Husky pre-push keeps existing commands and gains the governance dispatcher", () => {
  const env = isolatedEnv();
  write(join(env.XDG_DATA_HOME, "repo-governance", "dispatcher"), "#!/bin/sh\nexit 0\n", 0o755);
  const repo = initGitRepo();
  mkdirSync(join(repo, ".husky"), { recursive: true });
  write(join(repo, ".husky", "pre-push"), "#!/bin/sh\nnpm test\n", 0o755);
  git(repo, ["config", "core.hooksPath", ".husky"]);
  const connected = connectEffectiveRepositoryHook(repo, { env });
  assert.equal(connected.mode, "husky");
  const contents = readFileSync(join(repo, ".husky", "pre-push"), "utf8");
  assert.match(contents, /stable-dispatcher/);
  assert.match(readFileSync(join(repo, ".husky", "pre-push.repo-governance-original"), "utf8"), /npm test/);
  const diagnosis = doctorHooks(repo, { env });
  assert.equal(diagnosis.issues.some((issue) => /core\.hooksPath/.test(issue)), false);
});

test("doctor detects a later hooksPath change that bypasses governance", () => {
  const env = isolatedEnv();
  const repo = initGitRepo();
  mkdirSync(join(repo, ".husky"), { recursive: true });
  write(join(repo, ".husky", "pre-push"), "#!/bin/sh\nnpm test\n", 0o755);
  git(repo, ["config", "core.hooksPath", ".husky"]);
  const result = doctorHooks(repo, { env });
  assert.equal(result.ok, false);
  assert.match(result.issues.join("\n"), /does not reach/);
});

test("hook connection rejects a stale dispatcher marker without overwriting it", () => {
  const env = isolatedEnv();
  const repo = initGitRepo();
  const hookPath = join(repo, ".git", "hooks", "pre-push");
  const stale = "#!/bin/sh\n# repo-governance:stable-dispatcher\n\"/stale/dispatcher\" pre-push \"$@\"\nextra\n";
  write(hookPath, stale, 0o755);
  assert.throws(() => connectEffectiveRepositoryHook(repo, { env }), /unrecognized governance marker/);
  assert.equal(readFileSync(hookPath, "utf8"), stale);
});

test("hook reconnect atomically refreshes only a verified managed launcher digest", () => {
  const env = isolatedEnv();
  const repo = initGitRepo();
  const firstLauncher = join(env.HOME, "launcher-first");
  const secondLauncher = join(env.HOME, "launcher-second");
  write(firstLauncher, "#!/bin/sh\nexit 0\n", 0o755);
  write(secondLauncher, "#!/bin/sh\nexit 1\n", 0o755);
  installRuntimeEntries({ launcherSource: firstLauncher, engineVersion: "1.3.0", engineCommitSha: "a".repeat(40), env });
  const connected = connectEffectiveRepositoryHook(repo, { env, requireDispatcher: true });
  const manifestPath = `${connected.path}.repo-governance-manifest.json`;
  const before = JSON.parse(readFileSync(manifestPath, "utf8"));

  installRuntimeEntries({ launcherSource: secondLauncher, engineVersion: "1.4.0", engineCommitSha: "b".repeat(40), env });
  assert.match(doctorHooks(repo, { env, strict: true }).issues.join("\n"), /dispatcher digest differs/);
  const refreshed = connectEffectiveRepositoryHook(repo, { env, requireDispatcher: true });
  const after = JSON.parse(readFileSync(manifestPath, "utf8"));
  assert.equal(refreshed.changed, true);
  assert.equal(refreshed.refreshed, true);
  assert.notEqual(after.dispatcher.sha256, before.dispatcher.sha256);
  assert.equal(doctorHooks(repo, { env, strict: true }).ok, true);
});

test("hook reconnect rejects dispatcher drift without a verified managed launcher", () => {
  const env = isolatedEnv();
  const repo = initGitRepo();
  const installedDispatcher = join(env.XDG_DATA_HOME, "repo-governance", "dispatcher");
  write(installedDispatcher, "#!/bin/sh\nexit 0\n", 0o755);
  const connected = connectEffectiveRepositoryHook(repo, { env, requireDispatcher: true });
  const manifestPath = `${connected.path}.repo-governance-manifest.json`;
  const before = readFileSync(manifestPath, "utf8");
  write(installedDispatcher, "#!/bin/sh\nexit 1\n", 0o755);
  assert.throws(() => connectEffectiveRepositoryHook(repo, { env, requireDispatcher: true }), /failed manifest verification/);
  assert.equal(readFileSync(manifestPath, "utf8"), before);
});

test("wrapper gives byte-identical stdin to the preserved sidecar and dispatcher, then disconnect restores exact bytes", () => {
  const env = isolatedEnv();
  const repo = initGitRepo();
  const hook = join(repo, ".git", "hooks", "pre-push");
  const original = "#!/bin/sh\ncat > \"$SIDECAR_CAPTURE\"\n";
  write(hook, original, 0o755);
  const installedDispatcher = join(env.XDG_DATA_HOME, "repo-governance", "dispatcher");
  write(installedDispatcher, "#!/bin/sh\ncat > \"$DISPATCH_CAPTURE\"\n", 0o755);
  const connected = connectEffectiveRepositoryHook(repo, { env, requireDispatcher: true });
  const wrapper = readFileSync(hook, "utf8");
  assert.match(wrapper, /umask 077/);
  assert.match(wrapper, /mktemp/);
  assert.match(wrapper, /trap/);
  assert.equal(doctorHooks(repo, { env, strict: true }).ok, true);

  const sidecarCapture = join(env.HOME, "sidecar.stdin");
  const dispatchCapture = join(env.HOME, "dispatcher.stdin");
  const input = `refs/heads/feature ${"a".repeat(40)} refs/heads/feature ${"b".repeat(40)}\n`;
  const result = spawnSync("/bin/sh", [hook, "origin", "example"], {
    cwd: repo,
    env: { ...env, SIDECAR_CAPTURE: sidecarCapture, DISPATCH_CAPTURE: dispatchCapture },
    input,
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(readFileSync(sidecarCapture, "utf8"), input);
  assert.equal(readFileSync(dispatchCapture, "utf8"), input);

  assert.deepEqual(disconnectEffectiveRepositoryHook(repo, { env }), { restored: true, path: connected.path });
  assert.equal(readFileSync(hook, "utf8"), original);
  assert.equal(existsSync(`${hook}.repo-governance-original`), false);
  assert.equal(existsSync(`${hook}.repo-governance-manifest.json`), false);
});
