import { ARCHITECTURE_CONTRACT_FILE } from "./contract.mjs";

function compare(left, right) {
  return Buffer.from(left).compare(Buffer.from(right));
}

function stronglyConnected(nodes, edges) {
  const adjacency = new Map(nodes.map((node) => [node, []]));
  for (const edge of edges) if (adjacency.has(edge.from) && adjacency.has(edge.to)) adjacency.get(edge.from).push(edge.to);
  for (const targets of adjacency.values()) targets.sort(compare);
  const indexes = new Map();
  const lowLinks = new Map();
  const stack = [];
  const onStack = new Set();
  const components = [];
  let index = 0;

  function visit(node) {
    indexes.set(node, index);
    lowLinks.set(node, index);
    index += 1;
    stack.push(node);
    onStack.add(node);
    for (const target of adjacency.get(node)) {
      if (!indexes.has(target)) {
        visit(target);
        lowLinks.set(node, Math.min(lowLinks.get(node), lowLinks.get(target)));
      } else if (onStack.has(target)) lowLinks.set(node, Math.min(lowLinks.get(node), indexes.get(target)));
    }
    if (lowLinks.get(node) !== indexes.get(node)) return;
    const component = [];
    while (stack.length > 0) {
      const member = stack.pop();
      onStack.delete(member);
      component.push(member);
      if (member === node) break;
    }
    component.sort(compare);
    if (component.length > 1 || edges.some((edge) => edge.from === node && edge.to === node)) components.push(component);
  }

  for (const node of [...nodes].sort(compare)) if (!indexes.has(node)) visit(node);
  return components.sort((left, right) => compare(left.join("\0"), right.join("\0")));
}

function graphCycles(graph) {
  const governedFiles = graph.nodes.filter((node) => node.type === "file" && node.layer).map((node) => node.id);
  const fileEdges = graph.edges.filter((edge) => edge.scope === "file" && edge.resolution === "resolved-file");
  const fileCycles = stronglyConnected(governedFiles, fileEdges).map((nodes) => ({
    scope: "file",
    nodes: nodes.map((node) => node.slice("file:".length)),
  }));
  const explicitModules = graph.nodes.filter((node) => node.type === "module" && node.moduleKind === "contract" && node.paths.length > 0).map((node) => node.id);
  const moduleEdges = graph.edges.filter((edge) => edge.scope === "module");
  const moduleCycles = stronglyConnected(explicitModules, moduleEdges).map((nodes) => {
    const moduleIds = nodes.map((node) => node.slice("module:".length));
    const members = new Set(nodes);
    const files = moduleEdges.filter((edge) => members.has(edge.from) && members.has(edge.to)).flatMap((edge) => edge.evidence.map((item) => item.file));
    return { scope: "module", nodes: moduleIds, files: [...new Set(files)].sort(compare) };
  });
  return [...fileCycles, ...moduleCycles].sort((left, right) => compare(`${left.scope}\0${left.nodes.join("\0")}`, `${right.scope}\0${right.nodes.join("\0")}`));
}

export function evaluateArchitectureRules(contract, graph, changedPaths) {
  const nodes = new Map(graph.nodes.map((node) => [node.id, node]));
  const layers = new Map(contract.layers.map((layer) => [layer.id, layer]));
  const changed = new Set(changedPaths);
  const fullEvaluation = changed.has(ARCHITECTURE_CONTRACT_FILE);
  const violations = [];

  for (const edge of graph.edges.filter((candidate) => candidate.scope === "file" && candidate.to)) {
    const source = nodes.get(edge.from);
    if (!source?.layer) continue;
    const target = nodes.get(edge.to);
    const targetPath = target?.type === "file" ? target.path : null;
    if (!fullEvaluation && !changed.has(source.path) && !(targetPath && changed.has(targetPath))) continue;
    const targetLayer = target?.type === "file" ? target.layer : null;
    const targetModule = target?.type === "file" ? target.module : target?.moduleKind === "contract" ? target.moduleId : null;
    const identities = [targetLayer, targetModule].filter(Boolean);
    if (identities.length === 0) continue;
    const layer = layers.get(source.layer);
    const forbidden = identities.find((identity) => layer.forbiddenDependencies.includes(identity));
    const crossesLayer = Boolean(targetLayer && targetLayer !== source.layer);
    const crossesModule = Boolean(source.module && targetModule && source.module !== targetModule);
    const mappedModule = edge.resolution === "mapped-module";
    if (forbidden) {
      violations.push({ code: "forbidden-dependency", source, target, targetIdentity: forbidden, edge });
      continue;
    }
    if ((crossesLayer || crossesModule || mappedModule) && !identities.some((identity) => layer.allowedDependencies.includes(identity))) {
      violations.push({ code: "dependency-not-allowed", source, target, targetIdentity: targetModule || targetLayer, edge });
    }
  }

  const cycles = graphCycles(graph);
  const affectedCycles = cycles.filter((cycle) => fullEvaluation || (cycle.scope === "file"
    ? cycle.nodes.some((path) => changed.has(path))
    : (cycle.files || []).some((path) => changed.has(path))));
  return { violations, cycles, affectedCycles };
}
