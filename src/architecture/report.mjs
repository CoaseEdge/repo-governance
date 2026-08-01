import { ARCHITECTURE_CONTRACT_FILE } from "./contract.mjs";

function compare(left, right) {
  return Buffer.from(left).compare(Buffer.from(right));
}

function violationFinding(violation) {
  const targetName = violation.targetIdentity;
  const message = violation.code === "forbidden-dependency"
    ? `Layer ${violation.source.layer} cannot depend on ${targetName}.`
    : `Layer ${violation.source.layer} dependency on ${targetName} is not allowed by the architecture contract.`;
  return {
    rule: "RG007",
    code: violation.code,
    message,
    file: violation.source.path,
    severity: "error",
    waivable: false,
    source: { layer: violation.source.layer, module: violation.source.module },
    target: {
      layer: violation.target?.type === "file" ? violation.target.layer : null,
      module: violation.target?.type === "module" ? violation.target.moduleId : violation.target?.module,
      file: violation.target?.type === "file" ? violation.target.path : null,
    },
    dependency: {
      type: violation.edge.type,
      syntax: violation.edge.syntax,
      specifier: violation.edge.specifier,
      resolution: violation.edge.resolution,
    },
  };
}

function cycleFinding(cycle) {
  const file = cycle.scope === "file" ? cycle.nodes[0] : cycle.files?.[0] || null;
  return {
    rule: "RG007",
    code: "circular-dependency",
    message: `${cycle.scope === "file" ? "File" : "Module"} dependency cycle detected: ${cycle.nodes.join(" -> ")}.`,
    file,
    severity: "warning",
    waivable: false,
    cycle: { scope: cycle.scope, nodes: cycle.nodes },
  };
}

export function skippedArchitectureGraph(reason = "architecture-contract-missing") {
  return {
    schemaVersion: 1,
    status: "skipped",
    contractPath: ARCHITECTURE_CONTRACT_FILE,
    reason,
    nodes: [],
    edges: [],
    cycles: [],
    skipped: [],
  };
}

export function buildArchitectureReport(graph, evaluation) {
  const findings = [
    ...evaluation.violations.map(violationFinding),
    ...evaluation.affectedCycles.map(cycleFinding),
  ].sort((left, right) => compare(`${left.severity}\0${left.file || ""}\0${left.code}\0${left.message}`, `${right.severity}\0${right.file || ""}\0${right.code}\0${right.message}`));
  return { findings, architectureGraph: { ...graph, cycles: evaluation.cycles } };
}
