import { readConfig } from "./config.mjs";
import { changedPaths, repositorySnapshotPaths, resolveCanonicalBase } from "./git.mjs";
import { evaluateRg001 } from "./rg001.mjs";
import { applyLocalWaivers } from "./waiver.mjs";
import { evaluateRg002 } from "./rg002.mjs";
import { evaluateRg003 } from "./rg003.mjs";
import { evaluateRg004 } from "./rg004.mjs";
import { evaluateRg006 } from "./rg006.mjs";
import { evaluateRg007 } from "./rg007.mjs";
import { readArchitectureContract } from "./architecture/contract.mjs";
import { evaluateArchitectureDrift } from "./architecture/drift.mjs";
import { evaluateWorkflowConsumers } from "./workflow-consumers.mjs";
import { evaluateRg008 } from "./rg008.mjs";
import { loadTaskContract } from "./task-contract.mjs";
import { evaluateTaskDrift } from "./task-drift.mjs";
import { collectChangeMetrics } from "./change-metrics.mjs";
import { evaluateRg009 } from "./rg009.mjs";
import { resolveEngineeringProfile } from "./engineering-profile.mjs";

export function checkRepository(repo, { base, head = "HEAD", now } = {}) {
  const config = readConfig(repo);
  const baseRef = base || config.defaultBranch;
  const endpoints = resolveCanonicalBase(repo, baseRef, head);
  const changed = changedPaths(repo, endpoints.canonicalBaseSha, endpoints.headSha);
  return evaluateRepository(repo, config, endpoints, changed, { now });
}

function evaluateRepository(repo, config, endpoints, changed, { now, mode = "standard", allowWaivers = true } = {}) {
  const rg001 = evaluateRg001(config, changed);
  const waived = allowWaivers
    ? applyLocalWaivers(repo, rg001.findings, endpoints.canonicalBaseSha, endpoints.headSha, now)
    : { findings: rg001.findings, accepted: [] };
  const rg002 = evaluateRg002(repo, config);
  const rg003 = evaluateRg003(repo, config);
  const rg004 = evaluateRg004(repo, config, changed, endpoints.canonicalBaseSha);
  const rg006 = evaluateRg006(repo, config);
  const architectureContract = readArchitectureContract(repo, { changedPaths: changed });
  const rg007 = evaluateRg007(repo, architectureContract, changed);
  const architectureDrift = evaluateArchitectureDrift(repo, architectureContract, rg007.architectureGraph, changed);
  const taskContract = mode === "standard" ? loadTaskContract(repo) : null;
  const rg008 = evaluateRg008(repo, taskContract, changed);
  const changeMetrics = taskContract?.schemaVersion === 2
    ? collectChangeMetrics(repo, config, taskContract, endpoints.canonicalBaseSha, endpoints.headSha)
    : null;
  const rg009 = evaluateRg009(taskContract, changeMetrics);
  const engineeringProfile = resolveEngineeringProfile(taskContract, config, changed);
  const taskDrift = evaluateTaskDrift(taskContract, changed);
  const workflowConsumers = evaluateWorkflowConsumers(repo, config);
  const findings = [...waived.findings, ...rg002.findings, ...rg003.findings, ...rg004.findings, ...rg006.findings, ...workflowConsumers.findings, ...rg007.findings, ...architectureDrift.findings, ...rg008.findings, ...rg009.findings];
  const blockingFindings = findings.filter((finding) => finding.severity !== "warning");
  return {
    schemaVersion: 1,
    mode,
    ok: blockingFindings.length === 0,
    exitCode: blockingFindings.length === 0 ? 0 : 1,
    endpoints,
    changedPaths: changed,
    findings,
    satisfied: rg001.satisfied,
    acceptedWaivers: waived.accepted,
    testCommandGraph: rg002.reachable,
    executionCommandGraphs: rg006.commandGraphs,
    executionContractVerified: rg006.findings.length === 0,
    architectureFindings: rg007.findings,
    architectureGraph: rg007.architectureGraph,
    architectureDriftFindings: architectureDrift.findings,
    architectureDrift: architectureDrift.architectureDrift,
    scopeFindings: rg008.findings,
    taskDrift,
    ...(engineeringProfile ? { engineeringProfile } : {}),
    workflowConsumersVerified: workflowConsumers.verified,
    cleanCheckoutVerified: null,
    cleanCheckoutStatus: "not-run",
    semanticCoverageVerified: false,
    capabilityBoundary: "RG001 verifies mapped companion categories and change evidence only. It does not prove assertion quality, semantic coverage, or business correctness.",
  };
}

export function checkAdoption(repo, { base, head = "HEAD", now } = {}) {
  const config = readConfig(repo);
  const endpoints = resolveCanonicalBase(repo, base || config.defaultBranch, head);
  return evaluateRepository(repo, config, endpoints, repositorySnapshotPaths(repo), {
    now,
    mode: "adoption",
    allowWaivers: false,
  });
}
