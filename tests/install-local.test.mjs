import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { installLocalFromSource } from "../scripts/install-local.mjs";
import { treeDigest } from "../src/tree-digest.mjs";
import { MANAGED_ENTRY_MARKER } from "../src/launcher-install.mjs";
import { PRE_PUSH_PROTOCOL_VERSION, SUPPORTED_EXECUTION_CONTRACT_VERSIONS } from "../src/protocol.mjs";
import { temporaryDirectory, write } from "./helpers.mjs";

function digest(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function fixture() {
  const root = temporaryDirectory("repo-governance-local-source-");
  const cliName = process.platform === "win32" ? "repo-governance.exe" : "repo-governance";
  const dispatcherName = process.platform === "win32" ? "dispatcher.exe" : "dispatcher";
  write(join(root, "package.json"), `${JSON.stringify({ version: "1.0.0" }, null, 2)}\n`);
  write(join(root, "dist", cliName), "cli", 0o755);
  write(join(root, "dist", dispatcherName), "dispatcher", 0o755);
  write(join(root, "adapters", "codex", "skills", "example-skill", "SKILL.md"), "---\nname: example-skill\ndescription: Example source install fixture.\n---\n");
  write(join(root, "adapters", "codex", "skills", "repo-governance-agent-gate", "SKILL.md"), "---\nname: repo-governance-agent-gate\ndescription: Example gate fixture for source installation.\n---\n");
  write(join(root, "adapters", "codex", "adapter-contract.json"), "{}\n");
  write(join(root, "adapters", "claude-code", "CLAUDE.md"), "# Example Claude adapter\n");
  write(join(root, "adapters", "claude-code", "commands", "repo-governance-agent-gate.md"), "# Gate command\n");
  write(join(root, "adapters", "claude-code", "hooks", "settings.example.json"), "{}\n");
  write(join(root, "playbooks", "example-skill.md"), "# Example shared playbook\n");
  write(join(root, "playbooks", "repo-governance-agent-gate.md"), "# Example gate playbook\n");
  return { root, cliName, dispatcherName, commitSha: "b".repeat(40) };
}

function isolatedEnv() {
  const home = temporaryDirectory("repo-governance-local-home-");
  return { ...process.env, HOME: home, XDG_DATA_HOME: join(home, ".local", "share"), CODEX_HOME: join(home, ".codex") };
}

function runner({ commitSha = "b".repeat(40), dirty = "" } = {}) {
  const calls = [];
  const runCommand = (command, args) => {
    calls.push([command, ...args]);
    if (command === "git" && args.join(" ") === "rev-parse HEAD") return `${commitSha}\n`;
    if (command === "git" && args.join(" ") === "status --porcelain") return dirty;
    if (command === "npm") return "";
    throw new Error(`Unexpected command: ${command} ${args.join(" ")}`);
  };
  return { calls, runCommand };
}

test("package.json exposes install:local", () => {
  const packageJson = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
  assert.equal(packageJson.scripts["install:local"], "node scripts/install-local.mjs");
});

test("local source install copies CLI, dispatcher, manifests, versioned Agent assets, and Skills", () => {
  const { root, cliName, dispatcherName, commitSha } = fixture();
  const env = isolatedEnv();
  const fake = runner({ commitSha });
  const result = installLocalFromSource({ root, env, nodeVersion: "22.1.0", runCommand: fake.runCommand });
  const dataRoot = join(env.XDG_DATA_HOME, "repo-governance");
  const engineDirectory = join(dataRoot, "engines", commitSha);
  assert.equal(result.engineDirectory, engineDirectory);
  assert.equal(result.executable, join(engineDirectory, cliName));
  assert.ok(existsSync(join(engineDirectory, cliName)));
  assert.ok(existsSync(join(dataRoot, dispatcherName)));
  assert.ok(existsSync(result.launcherPath));
  assert.ok(existsSync(result.commandPath));
  assert.match(readFileSync(result.commandPath, "utf8"), new RegExp(MANAGED_ENTRY_MARKER));
  assert.equal(result.defaultEngineCommitSha, commitSha);
  assert.equal(result.pathConfigured, false);
  assert.match(result.actionRequired, /export PATH=/);
  assert.ok(existsSync(join(result.skills.root, "example-skill", "SKILL.md")));
  assert.ok(existsSync(join(result.skills.root, "example-skill", "references", "playbook.md")));
  assert.ok(existsSync(join(result.agentAssets, "playbooks", "example-skill.md")));
  assert.ok(existsSync(join(result.agentAssets, "adapters", "claude-code", "CLAUDE.md")));
  assert.ok(existsSync(join(result.agentAssets, "adapters", "claude-code", "commands", "repo-governance-agent-gate.md")));
  assert.ok(existsSync(join(result.agentAssets, "adapters", "claude-code", "hooks", "settings.example.json")));
  assert.deepEqual(fake.calls.filter(([command]) => command === "npm"), [["npm", "run", "check"], ["npm", "run", "build:sea"]]);

  const manifest = JSON.parse(readFileSync(join(engineDirectory, "local-engine-manifest.json"), "utf8"));
  assert.equal(manifest.installKind, "source");
  assert.ok(Number.isFinite(Date.parse(manifest.installedAt)));
  assert.equal(manifest.engineCommitSha, commitSha);
  assert.equal(manifest.engineVersion, "1.0.0");
  assert.equal(manifest.cli.sha256, digest("cli"));
  assert.equal(manifest.dispatcher.sha256, digest("dispatcher"));
  assert.equal(manifest.launcher.sha256, digest("dispatcher"));
  assert.equal(manifest.prePushProtocolVersion, PRE_PUSH_PROTOCOL_VERSION);
  assert.deepEqual(manifest.supportedExecutionContractVersions, SUPPORTED_EXECUTION_CONTRACT_VERSIONS);
  assert.equal(manifest.skillsSha256, treeDigest(join(root, "adapters", "codex", "skills")));
  assert.equal(manifest.playbooksSha256, treeDigest(join(root, "playbooks")));
  assert.equal(manifest.agentAssetsSha256, treeDigest(result.agentAssets));

  const dispatcherManifest = JSON.parse(readFileSync(join(engineDirectory, "engine-manifest.json"), "utf8"));
  assert.ok(Number.isFinite(Date.parse(dispatcherManifest.installedAt)));
  delete dispatcherManifest.installedAt;
  assert.deepEqual(dispatcherManifest, {
    engineVersion: "1.0.0",
    engineCommitSha: commitSha,
    sha256: digest("cli"),
    prePushProtocolVersion: PRE_PUSH_PROTOCOL_VERSION,
    supportedExecutionContractVersions: SUPPORTED_EXECUTION_CONTRACT_VERSIONS,
    agentAssetsSha256: manifest.agentAssetsSha256,
  });
  assert.match(readFileSync(join(engineDirectory, "SHA256SUMS"), "utf8"), new RegExp(`${digest("cli")}  ${cliName}`));
});

test("local source install fails for dirty worktrees before build commands", () => {
  const { root, commitSha } = fixture();
  const fake = runner({ commitSha, dirty: " M README.md\n" });
  assert.throws(() => installLocalFromSource({ root, env: isolatedEnv(), nodeVersion: "22.1.0", runCommand: fake.runCommand }), /clean git working tree/);
  assert.equal(fake.calls.some(([command]) => command === "npm"), false);
});

test("local source install rejects unsupported Node versions and invalid commit IDs", () => {
  const { root } = fixture();
  assert.throws(() => installLocalFromSource({ root, env: isolatedEnv(), nodeVersion: "21.0.0", runCommand: runner().runCommand }), /Node\.js 22/);
  assert.throws(() => installLocalFromSource({ root, env: isolatedEnv(), nodeVersion: "22.1.0", runCommand: runner({ commitSha: "short" }).runCommand }), /40-character/);
});

test("local source install safely migrates an existing v1.1.1 dispatcher", () => {
  const { root, dispatcherName, commitSha } = fixture();
  const env = isolatedEnv();
  write(join(env.XDG_DATA_HOME, "repo-governance", dispatcherName), "existing", 0o755);
  const result = installLocalFromSource({ root, env, nodeVersion: "22.1.0", runCommand: runner({ commitSha }).runCommand });
  assert.equal(readFileSync(join(env.XDG_DATA_HOME, "repo-governance", dispatcherName), "utf8"), "existing");
  assert.ok(existsSync(result.launcherPath));
  assert.ok(existsSync(result.commandPath));
});

test("local source install refuses an unmanaged command entry before creating an engine", () => {
  const { root, commitSha } = fixture();
  const env = isolatedEnv();
  const commandPath = join(env.HOME, ".local", "bin", "repo-governance");
  write(commandPath, "unmanaged\n", 0o755);
  assert.throws(
    () => installLocalFromSource({ root, env, nodeVersion: "22.1.0", runCommand: runner({ commitSha }).runCommand }),
    /unmanaged repo-governance command entry/,
  );
  assert.equal(existsSync(join(env.XDG_DATA_HOME, "repo-governance", "engines", commitSha)), false);
});

test("local source install reports bare command availability only when the bin directory is in PATH", () => {
  const { root, commitSha } = fixture();
  const env = isolatedEnv();
  env.PATH = `${join(env.HOME, ".local", "bin")}:${env.PATH}`;
  const result = installLocalFromSource({ root, env, nodeVersion: "22.1.0", runCommand: runner({ commitSha }).runCommand });
  assert.equal(result.pathConfigured, true);
  assert.equal(result.actionRequired, null);
  assert.match(result.message, /Installed managed repo-governance command entry/);
});

test("README source install commands match the implemented script", () => {
  const chinese = readFileSync(new URL("../README.md", import.meta.url), "utf8");
  const english = readFileSync(new URL("../README.en.md", import.meta.url), "utf8");
  for (const contents of [english, chinese]) {
    assert.match(contents, /git clone https:\/\/github\.com\/CoaseEdge\/repo-governance\.git/);
    assert.match(contents, /cd repo-governance/);
    assert.match(contents, /npm ci/);
    assert.match(contents, /npm run install:local/);
  }
});
