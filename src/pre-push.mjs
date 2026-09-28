import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readConfig } from "./config.mjs";
import { GovernanceError } from "./errors.mjs";
import { runGit, withGitEnvironment } from "./process.mjs";
import { resolvePrePushCandidates } from "./revisions.mjs";
import { verifyExecution } from "./verify-execution.mjs";

function fail(message, code = "RG_PRE_PUSH_EXECUTION", details = {}) {
  throw new GovernanceError(message, { code, details });
}

function cloneCandidate(sourceRepo, candidate, env) {
  const temporaryRoot = mkdtempSync(join(tmpdir(), "repo-governance-pre-push-"));
  const checkout = join(temporaryRoot, "checkout");
  const gitEnv = {
    ...env,
    GIT_LFS_SKIP_SMUDGE: "1",
    GIT_OPTIONAL_LOCKS: "0",
  };
  try {
    // Hook-local Git variables point at the source repository, not the clone.
    const localVariables = runGit(["rev-parse", "--local-env-vars"], { cwd: sourceRepo, env }).stdout;
    for (const name of localVariables.trim().split(/\s+/)) delete gitEnv[name];
    runGit(["clone", "--local", "--no-hardlinks", "--no-checkout", "--", sourceRepo, checkout], { cwd: sourceRepo, env: gitEnv });
    runGit(["checkout", "--detach", "--no-recurse-submodules", candidate.pushedCommitSha], { cwd: checkout, env: gitEnv });
    return { temporaryRoot, checkout, env: gitEnv };
  } catch (error) {
    rmSync(temporaryRoot, { recursive: true, force: true });
    throw error;
  }
}

function prePushProfiles(repo) {
  const config = readConfig(repo);
  const profiles = config.executionProfiles.filter((profile) => profile.consumers.some(
    (consumer) => consumer.type === "pre-push" && consumer.revisionSource === "pushed-ref-tip",
  ));
  if (profiles.length === 0) fail("Candidate execution contract has no pushed-ref-tip pre-push profile.", "RG_PRE_PUSH_CONFIG");
  return profiles;
}

function cleanupOnSignals(path) {
  const handlers = new Map();
  for (const signal of ["SIGHUP", "SIGINT", "SIGTERM"]) {
    const handler = () => {
      for (const [registeredSignal, registeredHandler] of handlers) process.off(registeredSignal, registeredHandler);
      rmSync(path, { recursive: true, force: true });
      process.kill(process.pid, signal);
    };
    handlers.set(signal, handler);
    process.once(signal, handler);
  }
  return () => {
    for (const [signal, handler] of handlers) process.off(signal, handler);
  };
}

export function verifyPrePushExecution(sourceRepo, {
  remote,
  remoteUrl,
  input,
  env = process.env,
  verify = verifyExecution,
} = {}) {
  if (!remote || !remoteUrl) fail("Pre-push execution requires the configured remote name and URL.", "RG_INVOCATION");
  const sourceGitEnv = { ...env, GIT_OPTIONAL_LOCKS: "0" };
  const resolved = resolvePrePushCandidates(sourceRepo, { remote, remoteUrl, input, env: sourceGitEnv });
  const reports = [];
  for (const candidate of resolved.candidates) {
    const isolated = cloneCandidate(sourceRepo, candidate, env);
    const removeSignalHandlers = cleanupOnSignals(isolated.temporaryRoot);
    try {
      for (const profile of prePushProfiles(isolated.checkout)) {
        // Scope implicit Git calls in the verifier without changing process.env.
        const report = withGitEnvironment(isolated.env, () => verify(isolated.checkout, {
          profileId: profile.id,
          revision: {
            revisionSource: "pushed-ref-tip",
            eventCommitSha: candidate.pushedCommitSha,
            canonicalBaseInputSha: candidate.canonicalBaseInputSha,
          },
          dependencyArgv: "hookArgv",
          env: isolated.env,
        }));
        for (const ref of candidate.refs) {
          reports.push({
            ref: ref.ref,
            remote,
            remoteRef: ref.remoteRef,
            profileId: profile.id,
            pushedObjectSha: ref.pushedObjectSha,
            pushedCommitSha: ref.pushedCommitSha,
            testedCommitSha: report.testedCommitSha,
            sameRevision: ref.pushedCommitSha === report.testedCommitSha,
            baseSource: ref.baseSource,
            canonicalBaseInputSha: ref.canonicalBaseInputSha,
            canonicalBaseSha: report.canonicalBaseSha,
            executionContractVersion: report.executionContractVersion,
            prePushProtocolVersion: report.prePushProtocolVersion,
            executionContractVerified: report.executionContractVerified,
            workflowConsumersVerified: report.workflowConsumersVerified,
            cleanCheckoutVerified: report.cleanCheckoutVerified,
            semanticCoverageVerified: report.semanticCoverageVerified,
          });
        }
      }
    } finally {
      removeSignalHandlers();
      rmSync(isolated.temporaryRoot, { recursive: true, force: true });
    }
  }
  return {
    schemaVersion: 1,
    command: "verify-execution",
    mode: "pre-push",
    remote,
    reports,
    skipped: resolved.skipped,
  };
}

export function readPrePushStdin(path = 0) {
  return readFileSync(path, "utf8");
}
