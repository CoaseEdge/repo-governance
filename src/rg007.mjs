import { buildArchitectureGraph } from "./architecture/graph.mjs";
import { buildArchitectureReport, skippedArchitectureGraph } from "./architecture/report.mjs";
import { evaluateArchitectureRules } from "./architecture/rules.mjs";
import { validateArchitectureContract } from "./architecture/contract.mjs";

export function evaluateRg007(repo, architectureContract, changedPaths = []) {
  if (!architectureContract) return { findings: [], architectureGraph: skippedArchitectureGraph() };
  const contract = validateArchitectureContract(architectureContract);
  const graph = buildArchitectureGraph(repo, contract);
  return buildArchitectureReport(graph, evaluateArchitectureRules(contract, graph, changedPaths));
}
