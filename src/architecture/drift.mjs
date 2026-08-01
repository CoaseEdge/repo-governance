import { readConfig } from "../config.mjs";
import { canonicalJson } from "../execution-contract.mjs";
import { evaluateRg007 } from "../rg007.mjs";
import { architectureContractSha256, architectureGraphSha256, architectureSnapshot, readArchitectureBaseline } from "./baseline.mjs";
import { readArchitectureContract } from "./contract.mjs";
import { ARCHITECTURE_BASELINE_FILE, ARCHITECTURE_CONTRACT_FILE } from "./paths.mjs";

const BLOCKING_THRESHOLD = 70;

function compare(left, right) {
  return Buffer.from(left).compare(Buffer.from(right));
}

function factChanges(before, current) {
  const beforeValues = new Map(before.map((value) => [canonicalJson(value), value]));
  const currentValues = new Map(current.map((value) => [canonicalJson(value), value]));
  return {
    added: [...currentValues.entries()].filter(([key]) => !beforeValues.has(key)).sort(([left], [right]) => compare(left, right)).map(([, value]) => value),
    removed: [...beforeValues.entries()].filter(([key]) => !currentValues.has(key)).sort(([left], [right]) => compare(left, right)).map(([, value]) => value),
  };
}

function classification(score) {
  if (score === 100) return "Healthy";
  if (score >= 90) return "Minor drift";
  if (score >= 70) return "Needs attention";
  return "Architecture degradation";
}

function recommendations(changes) {
  const result = [];
  if (changes.boundaryViolations.added.length > 0) result.push({ code: "resolve-boundary-violations", message: "Resolve newly introduced architecture boundary violations." });
  if (changes.cycles.added.length > 0) result.push({ code: "remove-new-cycles", message: "Break newly introduced file or explicit-module dependency cycles." });
  if (changes.layerDependencies.added.length > 0) result.push({ code: "review-layer-dependencies", message: "Review newly introduced cross-layer dependency directions against the contract." });
  if (changes.moduleDependencies.added.length > 0) result.push({ code: "reduce-module-coupling", message: "Review newly introduced explicit-module dependencies and reduce unnecessary coupling." });
  return result;
}

function skippedReport() {
  return {
    schemaVersion: 1,
    status: "skipped",
    reason: "architecture-baseline-missing",
    baselinePath: ARCHITECTURE_BASELINE_FILE,
    contractSha256: null,
    graphs: { baselineSha256: null, currentSha256: null },
    health: { before: null, after: null, classification: null, blockingThreshold: BLOCKING_THRESHOLD },
    metrics: { baseline: null, current: null, delta: null },
    changes: {
      layerDependencies: { added: [], removed: [] },
      moduleDependencies: { added: [], removed: [] },
      moduleImports: { added: [], removed: [] },
      cycles: { added: [], removed: [] },
      boundaryViolations: { added: [], removed: [] },
    },
    penalties: { boundary: 0, cycles: 0, dependencies: 0, coupling: 0, total: 0 },
    recommendations: [],
  };
}

function metricsDelta(before, current) {
  return Object.fromEntries(Object.keys(before).sort(compare).map((key) => [key, Number((current[key] - before[key]).toFixed(3))]));
}

export function scoreArchitectureChanges(changes) {
  const penalties = {
    boundary: Math.min(40, changes.boundaryViolations.added.length * 10),
    cycles: Math.min(25, changes.cycles.added.length * 5),
    dependencies: Math.min(20, changes.layerDependencies.added.length * 4),
    coupling: Math.min(15, changes.moduleDependencies.added.length),
  };
  penalties.total = penalties.boundary + penalties.cycles + penalties.dependencies + penalties.coupling;
  const score = Math.max(0, 100 - penalties.total);
  return { penalties, score, classification: classification(score) };
}

function driftFinding(score, classificationName, penalties) {
  if (score === 100) return [];
  const severity = score < BLOCKING_THRESHOLD ? "error" : "warning";
  return [{
    rule: "ARCHITECTURE_DRIFT",
    code: severity === "error" ? "architecture-health-below-threshold" : "architecture-drift-detected",
    message: `Architecture health is ${score}/100 (${classificationName}); drift penalties total ${penalties.total}.`,
    severity,
    waivable: false,
    baselineScore: 100,
    score,
  }];
}

function humanSummary(report) {
  if (report.status === "skipped") return `Architecture drift skipped because ${ARCHITECTURE_BASELINE_FILE} is missing.`;
  const labels = [
    ["layer dependencies", report.changes.layerDependencies],
    ["module dependencies", report.changes.moduleDependencies],
    ["module import evidence", report.changes.moduleImports],
    ["cycles", report.changes.cycles],
    ["boundary violations", report.changes.boundaryViolations],
  ];
  const lines = [
    `Architecture health: ${report.health.before} -> ${report.health.after}/100 (${report.health.classification}).`,
    `Changes: ${labels.map(([label, changes]) => `${label} +${changes.added.length}/-${changes.removed.length}`).join("; ")}.`,
  ];
  if (report.recommendations.length > 0) lines.push("Recommendations:", ...report.recommendations.map((item) => `- ${item.message}`));
  return lines.join("\n");
}

export function evaluateArchitectureDrift(repo, contract, graph, changedPaths = []) {
  const baseline = readArchitectureBaseline(repo, { changedPaths, contract });
  if (!baseline) return { findings: [], architectureDrift: skippedReport() };
  const current = architectureSnapshot(contract, graph);
  const changes = {
    layerDependencies: factChanges(baseline.facts.layerDependencies, current.facts.layerDependencies),
    moduleDependencies: factChanges(baseline.facts.moduleDependencies, current.facts.moduleDependencies),
    moduleImports: factChanges(baseline.facts.moduleImports, current.facts.moduleImports),
    cycles: factChanges(baseline.facts.cycles, current.facts.cycles),
    boundaryViolations: factChanges(baseline.facts.boundaryViolations, current.facts.boundaryViolations),
  };
  const scored = scoreArchitectureChanges(changes);
  const { penalties, score } = scored;
  const classificationName = scored.classification;
  const report = {
    schemaVersion: 1,
    status: "evaluated",
    baselinePath: ARCHITECTURE_BASELINE_FILE,
    contractSha256: architectureContractSha256(contract),
    graphs: { baselineSha256: baseline.graphSha256, currentSha256: architectureGraphSha256(graph) },
    health: { before: baseline.healthScore, after: score, classification: classificationName, blockingThreshold: BLOCKING_THRESHOLD },
    metrics: { baseline: baseline.metrics, current: current.metrics, delta: metricsDelta(baseline.metrics, current.metrics) },
    changes,
    penalties,
    recommendations: recommendations(changes),
  };
  return { findings: driftFinding(score, classificationName, penalties), architectureDrift: report };
}

export function reportArchitectureDrift(repo) {
  readConfig(repo);
  const contract = readArchitectureContract(repo);
  const baselineProbe = readArchitectureBaseline(repo, { contract });
  if (!baselineProbe) {
    const report = skippedReport();
    return { ...report, command: "architecture drift", ok: true, exitCode: 0, message: humanSummary(report) };
  }
  const { architectureGraph } = evaluateRg007(repo, contract, [ARCHITECTURE_CONTRACT_FILE]);
  const result = evaluateArchitectureDrift(repo, contract, architectureGraph);
  const blocking = result.findings.some((finding) => finding.severity === "error");
  return {
    ...result.architectureDrift,
    command: "architecture drift",
    ok: !blocking,
    exitCode: blocking ? 1 : 0,
    findings: result.findings,
    message: humanSummary(result.architectureDrift),
  };
}
