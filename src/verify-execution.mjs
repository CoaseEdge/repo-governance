import { createHash } from "node:crypto";
import { accessSync, constants, existsSync, readFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve, sep } from "node:path";
import { checkRepository } from "./check.mjs";
import { readConfig } from "./config.mjs";
import { GovernanceError } from "./errors.mjs";
import { executionEvidenceForProfile } from "./execution-evidence.mjs";
import { resolveCommit } from "./git.mjs";
import { PRE_PUSH_PROTOCOL_VERSION } from "./protocol.mjs";
import { run, runGit } from "./process.mjs";
import { resolveCiRevision, writeCanonicalBaseRef } from "./revisions.mjs";

function fail(message, code = "RG_VERIFY_EXECUTION", details = {}) {
  throw new GovernanceError(message, { code, details });
}

function digest(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function executableFromPath(name, env, platform = process.platform) {
  const candidates = platform === "win32" ? [name, `${name}.exe`, `${name}.cmd`] : [name];
  for (const directory of String(env.PATH || "").split(platform === "win32" ? ";" : ":").filter(Boolean)) {
    for (const candidate of candidates) {
      const path = join(directory, candidate);
      try {
        accessSync(path, constants.X_OK);
        return path;
      } catch {
        // Continue searching the declared PATH.
      }
    }
  }
  return null;
}

function matchesVersion(actual, expected) {
  if (expected === "posix") return true;
  const match = expected.match(/^(\d+)\.x$/);
  if (match) return actual.match(/\d+(?:\.\d+)*/)?.[0]?.split(".")[0] === match[1];
  return actual.match(/\d+(?:\.\d+)*/)?.[0] === expected;
}

function checkedVersion(path, tool, expected, env) {
  if (expected === "posix" && tool === "sh") {
    run(path, ["-c", "exit 0"], { env, errorCode: "RG_RUNTIME" });
    return;
  }
  const result = run(path, ["--version"], { env, errorCode: "RG_RUNTIME" });
  const actual = `${result.stdout || ""}\n${result.stderr || ""}`.trim();
  if (!matchesVersion(actual, expected)) fail(`Runtime tool ${tool} does not match ${expected}.`, "RG_RUNTIME", { tool, expected, actual });
}

function safeWorkingDirectory(repo, relative) {
  if (isAbsolute(relative)) fail("Execution workingDirectory must be repository-relative.", "RG_RUNTIME", { workingDirectory: relative });
  const path = resolve(repo, relative);
  if (path !== repo && !path.startsWith(`${repo}${sep}`)) fail("Execution workingDirectory escapes the repository.", "RG_RUNTIME", { workingDirectory: relative });
  return path;
}

export function verifyRuntime(repo, runtime, preparation, { env = process.env, platform = process.platform } = {}) {
  const paths = [];
  if (runtime.node) {
    if (!matchesVersion(process.versions.node, runtime.node.version)) {
      fail(`Node.js runtime does not match ${runtime.node.version}.`, "RG_RUNTIME", { expected: runtime.node.version, actual: process.versions.node });
    }
    paths.push(dirname(process.execPath));
    if (runtime.packageManager) {
      const nodePath = executableFromPath("node", env, platform);
      if (!nodePath) fail("Declared package-manager execution requires an external Node.js command.", "RG_RUNTIME");
      checkedVersion(nodePath, "node", runtime.node.version, env);
      paths.push(dirname(nodePath));
    }
  }
  for (const tool of runtime.systemTools || []) {
    if (tool.platforms && !tool.platforms.includes(platform)) continue;
    const path = tool.source === "self-contained" ? join(repo, tool.path) : executableFromPath(tool.name, env, platform);
    if (!path || !existsSync(path)) fail(`Allowlisted runtime tool is unavailable: ${tool.name}.`, "RG_RUNTIME", { tool: tool.name });
    if (tool.source === "self-contained") {
      const tracked = runGit(["ls-files", "--error-unmatch", "--", tool.path], { cwd: repo, allowFailure: true });
      if (tracked.status !== 0) fail(`Self-contained runtime tool is not Git tracked: ${tool.path}.`, "RG_RUNTIME", { tool: tool.name, path: tool.path });
    }
    if (tool.sha256 && digest(path) !== tool.sha256) fail(`Runtime tool digest differs: ${tool.name}.`, "RG_RUNTIME", { tool: tool.name });
    if (tool.version) checkedVersion(path, tool.name, tool.version, env);
    paths.push(dirname(path));
  }
  if (runtime.packageManager) {
    const path = executableFromPath(runtime.packageManager.name, env, platform);
    if (!path) fail(`Package manager is unavailable: ${runtime.packageManager.name}.`, "RG_RUNTIME", { packageManager: runtime.packageManager.name });
    checkedVersion(path, runtime.packageManager.name, runtime.packageManager.version, env);
    paths.push(dirname(path));
  }
  paths.push(join(repo, "node_modules", ".bin"));
  const delimiter = platform === "win32" ? ";" : ":";
  const controlledPath = [...new Set(paths)].join(delimiter);
  const controlledEnv = {};
  for (const name of ["HOME", "TMPDIR", "TEMP", "TMP", "CI", "GITHUB_ACTIONS", "GITHUB_EVENT_PATH", "GITHUB_SHA", "GITHUB_WORKSPACE", "RUNNER_OS"]) {
    if (env[name] !== undefined) controlledEnv[name] = env[name];
  }
  return {
    path: controlledPath,
    env: { ...controlledEnv, ...preparation.env, PATH: controlledPath },
    workingDirectory: safeWorkingDirectory(repo, preparation.workingDirectory),
  };
}

function initialWorkspaceState(repo) {
  const status = runGit(["status", "--porcelain=v1", "--untracked-files=all"], { cwd: repo }).stdout;
  const ignored = runGit(["ls-files", "--others", "--ignored", "--exclude-standard", "-z"], { cwd: repo, binary: true }).stdout;
  if (status || ignored.length > 0) {
    fail("Dynamic verification requires an initially clean checkout without staged, unstaged, untracked, or ignored residue.", "RG_CLEAN_CHECKOUT", {
      status: status.trim(),
      ignored: ignored.toString("utf8").split("\0").filter(Boolean),
    });
  }
}

function verifyFinalRevision(repo, testedCommitSha, canonicalBaseInputSha) {
  const finalHead = resolveCommit(repo, "HEAD");
  const finalBase = resolveCommit(repo, "refs/repo-governance/base");
  const staged = runGit(["diff", "--cached", "--quiet"], { cwd: repo, allowFailure: true }).status;
  const unstaged = runGit(["diff", "--quiet"], { cwd: repo, allowFailure: true }).status;
  if (finalHead !== testedCommitSha || finalBase !== canonicalBaseInputSha || staged !== 0 || unstaged !== 0) {
    fail("Dynamic execution changed the tested revision, canonical base ref, or Git-tracked files.", "RG_CLEAN_CHECKOUT", {
      testedCommitSha,
      finalHead,
      canonicalBaseInputSha,
      finalBase,
      staged,
      unstaged,
    });
  }
}

export function verifyExecution(repo, {
  profileId,
  revision,
  dependencyArgv = "ciArgv",
  env = process.env,
  runtimeVerifier = verifyRuntime,
  execute = run,
} = {}) {
  const config = readConfig(repo);
  const profile = config.executionProfiles.find((candidate) => candidate.id === profileId);
  if (!profile) fail(`Unknown execution profile: ${profileId}.`, "RG_VERIFY_EXECUTION", { profileId });
  const testedCommitSha = resolveCommit(repo, "HEAD");
  if (testedCommitSha !== revision.eventCommitSha) {
    fail("Checked-out HEAD does not equal the event or pushed revision.", "RG_REVISION_MISMATCH", { testedCommitSha, eventCommitSha: revision.eventCommitSha });
  }
  initialWorkspaceState(repo);
  writeCanonicalBaseRef(repo, revision.canonicalBaseInputSha);
  const preExecutionCheck = checkRepository(repo, {
    base: "refs/repo-governance/base",
    head: "HEAD",
    executionEvidence: [],
    allowPendingExecutionEvidence: true,
  });
  if (!preExecutionCheck.ok) {
    fail("Candidate governance check failed before dependency preparation.", "RG_STATIC_CHECK", {
      findings: preExecutionCheck.findings,
      testedCommitSha,
    });
  }
  const runtime = config.runtimes.find((candidate) => candidate.id === profile.runtimeId);
  const controlled = runtimeVerifier(repo, runtime, profile.dependencyPreparation, { env });
  const dependency = profile.dependencyPreparation[dependencyArgv];
  if (dependency.length > 0) {
    execute(dependency[0], dependency.slice(1), {
      cwd: controlled.workingDirectory,
      env: controlled.env,
      errorCode: "RG_DEPENDENCY_PREPARATION",
    });
  }
  execute(profile.entry.argv[0], profile.entry.argv.slice(1), {
    cwd: repo,
    env: controlled.env,
    errorCode: "RG_PROFILE_EXECUTION",
  });
  verifyFinalRevision(repo, testedCommitSha, revision.canonicalBaseInputSha);
  const executionEvidence = executionEvidenceForProfile(repo, config, profile);
  const staticCheck = checkRepository(repo, {
    base: "refs/repo-governance/base",
    head: "HEAD",
    executionEvidence,
  });
  if (!staticCheck.ok) {
    fail("Candidate governance check failed after governed execution.", "RG_TEST_EVIDENCE", {
      findings: staticCheck.findings,
      testedCommitSha,
    });
  }
  return {
    schemaVersion: 1,
    profileId,
    revisionSource: revision.revisionSource,
    eventCommitSha: revision.eventCommitSha,
    testedCommitSha,
    sameRevision: revision.eventCommitSha === testedCommitSha,
    canonicalBaseInputSha: revision.canonicalBaseInputSha,
    canonicalBaseSha: staticCheck.endpoints.canonicalBaseSha,
    executionContractVersion: config.executionContractVersion,
    prePushProtocolVersion: PRE_PUSH_PROTOCOL_VERSION,
    executionContractVerified: staticCheck.executionContractVerified,
    workflowConsumersVerified: staticCheck.workflowConsumersVerified,
    cleanCheckoutVerified: true,
    semanticCoverageVerified: false,
    executionEvidence,
    preExecutionCheck,
    staticCheck,
  };
}

export function verifyCiExecution(repo, {
  profileId,
  eventFile,
  env = process.env,
  runtimeVerifier,
  execute,
} = {}) {
  if (!eventFile) fail("--event-file is required for CI execution.", "RG_INVOCATION");
  const config = readConfig(repo);
  const profile = config.executionProfiles.find((candidate) => candidate.id === profileId);
  if (!profile) fail(`Unknown execution profile: ${profileId}.`, "RG_VERIFY_EXECUTION", { profileId });
  const event = JSON.parse(readFileSync(eventFile, "utf8"));
  const revision = resolveCiRevision(repo, { profile, event, githubSha: env.GITHUB_SHA });
  return verifyExecution(repo, { profileId, revision, dependencyArgv: "ciArgv", env, runtimeVerifier, execute });
}
