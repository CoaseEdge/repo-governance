import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { readConfig } from "../config.mjs";
import { canonicalJson } from "../execution-contract.mjs";
import { GovernanceError } from "../errors.mjs";
import { evaluateRg007 } from "../rg007.mjs";
import { readArchitectureContract } from "./contract.mjs";
import { ARCHITECTURE_BASELINE_FILE, ARCHITECTURE_CONTRACT_FILE } from "./paths.mjs";
import { evaluateArchitectureRules } from "./rules.mjs";

export { ARCHITECTURE_BASELINE_FILE } from "./paths.mjs";
export const ARCHITECTURE_BASELINE_VERSION = 1;

const HASH_PREFIX = "repo-governance:architecture:v1\0";

function compare(left, right) {
  return Buffer.from(left).compare(Buffer.from(right));
}

function sortedUnique(values) {
  const entries = new Map(values.map((value) => [canonicalJson(value), value]));
  return [...entries.entries()].sort(([left], [right]) => compare(left, right)).map(([, value]) => value);
}

function digest(kind, value) {
  return createHash("sha256").update(HASH_PREFIX, "utf8").update(`${kind}\0`, "utf8").update(canonicalJson(value), "utf8").digest("hex");
}

export function architectureContractSha256(contract) {
  return digest("contract", contract);
}

export function architectureGraphSha256(graph) {
  return digest("graph", graph);
}

function violationFact(violation) {
  return {
    code: violation.code,
    sourceFile: violation.source.path,
    sourceLayer: violation.source.layer,
    sourceModule: violation.source.module,
    targetFile: violation.target?.type === "file" ? violation.target.path : null,
    targetLayer: violation.target?.type === "file" ? violation.target.layer : null,
    targetModule: violation.target?.type === "module" ? violation.target.moduleId : violation.target?.module || null,
    targetIdentity: violation.targetIdentity,
    dependencyType: violation.edge.type,
    syntax: violation.edge.syntax,
    specifier: violation.edge.specifier,
    resolution: violation.edge.resolution,
  };
}

export function architectureSnapshot(contract, graph) {
  const nodes = new Map(graph.nodes.map((node) => [node.id, node]));
  const layerDependencies = [];
  for (const edge of graph.edges.filter((candidate) => candidate.scope === "file" && candidate.to)) {
    const source = nodes.get(edge.from);
    const target = nodes.get(edge.to);
    if (source?.layer && target?.type === "file" && target.layer && source.layer !== target.layer) {
      layerDependencies.push({ from: source.layer, to: target.layer });
    }
  }
  const moduleEdges = graph.edges.filter((edge) => edge.scope === "module");
  const moduleDependencies = moduleEdges.map((edge) => ({
    from: edge.from.slice("module:".length),
    to: edge.to.slice("module:".length),
  }));
  const moduleImports = moduleEdges.flatMap((edge) => edge.evidence.map((evidence) => ({
    from: edge.from.slice("module:".length),
    to: edge.to.slice("module:".length),
    file: evidence.file,
    specifier: evidence.specifier,
  })));
  const evaluation = evaluateArchitectureRules(contract, graph, [ARCHITECTURE_CONTRACT_FILE]);
  const facts = {
    layerDependencies: sortedUnique(layerDependencies),
    moduleDependencies: sortedUnique(moduleDependencies),
    moduleImports: sortedUnique(moduleImports),
    cycles: sortedUnique(evaluation.cycles.map((cycle) => ({ scope: cycle.scope, nodes: cycle.nodes }))),
    boundaryViolations: sortedUnique(evaluation.violations.map(violationFact)),
  };
  const explicitLocalModuleCount = graph.nodes.filter((node) => node.type === "module" && node.moduleKind === "contract" && node.paths.length > 0).length;
  const fileCycleCount = facts.cycles.filter((cycle) => cycle.scope === "file").length;
  const moduleCycleCount = facts.cycles.filter((cycle) => cycle.scope === "module").length;
  const averageCoupling = explicitLocalModuleCount === 0 ? 0 : Number((facts.moduleDependencies.length / explicitLocalModuleCount).toFixed(3));
  return {
    metrics: {
      fileCount: graph.nodes.filter((node) => node.type === "file").length,
      explicitLocalModuleCount,
      layerDependencyCount: facts.layerDependencies.length,
      moduleDependencyCount: facts.moduleDependencies.length,
      moduleImportCount: facts.moduleImports.length,
      fileCycleCount,
      moduleCycleCount,
      cycleCount: fileCycleCount + moduleCycleCount,
      boundaryViolationCount: facts.boundaryViolations.length,
      averageCoupling,
    },
    facts,
  };
}

export function buildArchitectureBaseline(contract, graph) {
  const snapshot = architectureSnapshot(contract, graph);
  return {
    version: ARCHITECTURE_BASELINE_VERSION,
    contractSha256: architectureContractSha256(contract),
    graphSha256: architectureGraphSha256(graph),
    healthScore: 100,
    architectureGraph: graph,
    metrics: snapshot.metrics,
    facts: snapshot.facts,
  };
}

export function architectureBaselineError(message, details = {}) {
  return new GovernanceError(message, { code: "RG_ARCHITECTURE_BASELINE", details });
}

function expect(condition, message, details = {}) {
  if (!condition) throw architectureBaselineError(message, details);
}

function validateHash(value, field) {
  expect(typeof value === "string" && /^[0-9a-f]{64}$/.test(value), `${field} must be a lowercase SHA-256 digest.`);
}

export function validateArchitectureBaseline(input, contract) {
  expect(input && typeof input === "object" && !Array.isArray(input), "Architecture baseline must be an object.");
  expect(input.version === ARCHITECTURE_BASELINE_VERSION, `Unsupported architecture baseline version; expected ${ARCHITECTURE_BASELINE_VERSION}.`);
  validateHash(input.contractSha256, "contractSha256");
  validateHash(input.graphSha256, "graphSha256");
  expect(input.healthScore === 100, "Architecture baseline healthScore must be 100.");
  expect(input.architectureGraph?.status === "evaluated", "Architecture baseline must contain an evaluated architectureGraph.");
  for (const field of ["nodes", "edges", "cycles", "skipped"]) expect(Array.isArray(input.architectureGraph[field]), `Architecture baseline graph ${field} must be an array.`);
  expect(input.metrics && typeof input.metrics === "object" && !Array.isArray(input.metrics), "Architecture baseline metrics must be an object.");
  expect(input.facts && typeof input.facts === "object" && !Array.isArray(input.facts), "Architecture baseline facts must be an object.");
  for (const field of ["layerDependencies", "moduleDependencies", "moduleImports", "cycles", "boundaryViolations"]) expect(Array.isArray(input.facts[field]), `Architecture baseline facts.${field} must be an array.`);
  expect(contract, "An architecture baseline cannot be used without an architecture contract.", { path: ARCHITECTURE_BASELINE_FILE });
  expect(input.contractSha256 === architectureContractSha256(contract), "Architecture contract digest does not match the baseline. Run architecture baseline --replace after reviewing the contract change.", { path: ARCHITECTURE_BASELINE_FILE });
  expect(input.graphSha256 === architectureGraphSha256(input.architectureGraph), "Architecture baseline graph digest is invalid.", { path: ARCHITECTURE_BASELINE_FILE });
  let snapshot;
  try {
    snapshot = architectureSnapshot(contract, input.architectureGraph);
  } catch (error) {
    throw architectureBaselineError(`Architecture baseline graph is invalid: ${error.message}`, { path: ARCHITECTURE_BASELINE_FILE });
  }
  expect(canonicalJson(input.metrics) === canonicalJson(snapshot.metrics), "Architecture baseline metrics do not match its graph.", { path: ARCHITECTURE_BASELINE_FILE });
  expect(canonicalJson(input.facts) === canonicalJson(snapshot.facts), "Architecture baseline facts do not match its graph.", { path: ARCHITECTURE_BASELINE_FILE });
  return input;
}

export function readArchitectureBaseline(repo, { changedPaths = [], contract } = {}) {
  const absolutePath = join(repo, ARCHITECTURE_BASELINE_FILE);
  if (!existsSync(absolutePath)) {
    if (changedPaths.includes(ARCHITECTURE_BASELINE_FILE)) {
      throw architectureBaselineError("Architecture baseline was removed; drift governance cannot be silently disabled.", { path: ARCHITECTURE_BASELINE_FILE });
    }
    return null;
  }
  let input;
  try {
    input = JSON.parse(readFileSync(absolutePath, "utf8"));
  } catch (error) {
    throw architectureBaselineError(`Unable to read ${ARCHITECTURE_BASELINE_FILE}: ${error.message}`, { path: ARCHITECTURE_BASELINE_FILE });
  }
  return validateArchitectureBaseline(input, contract);
}

export function writeArchitectureBaseline(repo, baseline, { replace = false, beforeRename } = {}) {
  const absolutePath = join(repo, ARCHITECTURE_BASELINE_FILE);
  const existed = existsSync(absolutePath);
  if (existed && !replace) throw architectureBaselineError(`Architecture baseline already exists at ${ARCHITECTURE_BASELINE_FILE}; use --replace to reset it explicitly.`, { path: ARCHITECTURE_BASELINE_FILE });
  mkdirSync(dirname(absolutePath), { recursive: true });
  const temporaryPath = `${absolutePath}.tmp-${process.pid}-${Date.now()}`;
  try {
    writeFileSync(temporaryPath, `${JSON.stringify(baseline, null, 2)}\n`, { flag: "wx" });
    if (beforeRename) beforeRename(temporaryPath);
    renameSync(temporaryPath, absolutePath);
  } finally {
    rmSync(temporaryPath, { force: true });
  }
  return { path: ARCHITECTURE_BASELINE_FILE, replaced: existed };
}

export function createArchitectureBaseline(repo, { replace = false, beforeRename } = {}) {
  readConfig(repo);
  const contract = readArchitectureContract(repo);
  if (!contract) throw architectureBaselineError(`Architecture contract is required before creating ${ARCHITECTURE_BASELINE_FILE}.`, { path: ARCHITECTURE_CONTRACT_FILE });
  const { architectureGraph } = evaluateRg007(repo, contract, [ARCHITECTURE_CONTRACT_FILE]);
  const baseline = buildArchitectureBaseline(contract, architectureGraph);
  const written = writeArchitectureBaseline(repo, baseline, { replace, beforeRename });
  const status = written.replaced ? "replaced" : "created";
  return {
    schemaVersion: 1,
    command: "architecture baseline",
    ok: true,
    exitCode: 0,
    status,
    baselinePath: ARCHITECTURE_BASELINE_FILE,
    baseline,
    message: `Architecture baseline ${status} at ${ARCHITECTURE_BASELINE_FILE} with health score 100.`,
  };
}
