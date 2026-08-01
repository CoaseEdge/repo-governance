import { existsSync, readFileSync } from "node:fs";
import { dirname, extname, join, relative, resolve, sep } from "node:path";
import { repositorySnapshotPaths } from "../git.mjs";
import { matchesAny } from "../glob.mjs";
import { architectureContractError } from "./contract.mjs";
import { ARCHITECTURE_BASELINE_FILE, ARCHITECTURE_CONTRACT_FILE } from "./paths.mjs";
import { languageForPath, scanSource, SUPPORTED_SOURCE_EXTENSIONS } from "./scanner.mjs";

function compare(left, right) {
  return Buffer.from(left).compare(Buffer.from(right));
}

function normalizedRelative(repo, absolute) {
  const value = relative(repo, absolute).split(sep).join("/");
  return value === "" || value === ".." || value.startsWith("../") ? null : value;
}

function owners(path, entries) {
  return entries.filter((entry) => entry.paths.length > 0 && matchesAny(path, entry.paths));
}

function javascriptPackageRoot(specifier) {
  const parts = specifier.split("/");
  return specifier.startsWith("@") ? parts.slice(0, 2).join("/") : parts[0];
}

function pythonPackageRoot(specifier) {
  return specifier.replace(/^\.+/, "").split(".")[0];
}

function uniqueLocalCandidate(repo, pathSet, sourcePath, specifier, language) {
  const sourceDirectory = dirname(resolve(repo, sourcePath));
  let base;
  if (language === "python") {
    const relativeMatch = /^(\.+)(.*)$/.exec(specifier);
    if (relativeMatch) {
      base = sourceDirectory;
      for (let level = 1; level < relativeMatch[1].length; level += 1) base = dirname(base);
      if (relativeMatch[2]) base = join(base, ...relativeMatch[2].split("."));
    } else base = join(repo, ...specifier.split("."));
  } else {
    if (!specifier.startsWith("./") && !specifier.startsWith("../")) return { path: null, reason: "external" };
    base = resolve(sourceDirectory, specifier);
  }
  const relativeBase = normalizedRelative(repo, base);
  if (!relativeBase) return { path: null, reason: "outside-repository" };

  let candidates;
  if (language !== "python" && SUPPORTED_SOURCE_EXTENSIONS.includes(extname(relativeBase).toLowerCase())) candidates = [relativeBase];
  else if (language === "python") candidates = [`${relativeBase}.py`, `${relativeBase}/__init__.py`];
  else candidates = [
    ...SUPPORTED_SOURCE_EXTENSIONS.filter((extension) => extension !== ".py").map((extension) => `${relativeBase}${extension}`),
    ...SUPPORTED_SOURCE_EXTENSIONS.filter((extension) => extension !== ".py").map((extension) => `${relativeBase}/index${extension}`),
  ];
  const existing = candidates.filter((candidate) => pathSet.has(candidate));
  if (existing.length === 1) return { path: existing[0], reason: null };
  return { path: null, reason: existing.length > 1 ? "ambiguous-local-import" : "unresolved-import" };
}

function edgeOrder(left, right) {
  for (const field of ["scope", "from", "to", "type", "syntax", "specifier"]) {
    const order = compare(String(left[field] ?? ""), String(right[field] ?? ""));
    if (order !== 0) return order;
  }
  return 0;
}

export function buildArchitectureGraph(repo, contract) {
  const excludedPaths = new Set([ARCHITECTURE_CONTRACT_FILE, ARCHITECTURE_BASELINE_FILE]);
  const repositoryPaths = repositorySnapshotPaths(repo).filter((path) => !excludedPaths.has(path) && existsSync(join(repo, path)));
  const pathSet = new Set(repositoryPaths);
  const nodes = [];
  const skipped = [];
  const fileNodes = new Map();
  const governedPatterns = contract.layers.flatMap((layer) => layer.paths).concat(contract.modules.flatMap((module) => module.paths));

  for (const path of repositoryPaths) {
    const language = languageForPath(path);
    if (!language && !matchesAny(path, governedPatterns)) continue;
    const layerOwners = owners(path, contract.layers);
    const moduleOwners = owners(path, contract.modules);
    if (layerOwners.length > 1) throw architectureContractError(`Path ${path} is owned by multiple layers.`, { path, layers: layerOwners.map((owner) => owner.id) });
    if (moduleOwners.length > 1) throw architectureContractError(`Path ${path} is owned by multiple modules.`, { path, modules: moduleOwners.map((owner) => owner.id) });
    if (moduleOwners.length === 1 && layerOwners.length === 0) throw architectureContractError(`Module-owned path ${path} has no layer owner.`, { path, module: moduleOwners[0].id });

    let scan;
    try {
      scan = scanSource(path, readFileSync(join(repo, path), "utf8"));
    } catch (error) {
      scan = { status: "skipped", language, imports: [], skipped: [{ reason: "unreadable-source", message: error.message }] };
    }
    const node = {
      id: `file:${path}`,
      type: "file",
      path,
      layer: layerOwners[0]?.id || null,
      module: moduleOwners[0]?.id || null,
      language: scan.language,
      scanStatus: scan.status,
    };
    nodes.push(node);
    fileNodes.set(path, { ...node, imports: scan.imports });
    for (const item of scan.skipped) skipped.push({ file: path, ...item });
  }

  const moduleNodes = new Map();
  for (const module of contract.modules) {
    const node = { id: `module:${module.id}`, type: "module", moduleId: module.id, moduleKind: "contract", paths: module.paths, imports: module.imports };
    nodes.push(node);
    moduleNodes.set(node.id, node);
  }
  const importOwners = new Map(contract.modules.flatMap((module) => module.imports.map((value) => [value, module.id])));
  const fileEdges = [];

  for (const source of [...fileNodes.values()].sort((left, right) => compare(left.path, right.path))) {
    for (const dependency of source.imports) {
      const local = uniqueLocalCandidate(repo, pathSet, source.path, dependency.specifier, source.language);
      let to = null;
      let targetPath = null;
      let resolution = local.reason;
      if (local.path) {
        targetPath = local.path;
        to = `file:${local.path}`;
        resolution = "resolved-file";
      } else if (local.reason === "external" || (source.language === "python" && local.reason === "unresolved-import" && !dependency.specifier.startsWith("."))) {
        const root = source.language === "python" ? pythonPackageRoot(dependency.specifier) : javascriptPackageRoot(dependency.specifier);
        const mapped = importOwners.get(root);
        if (mapped) {
          to = `module:${mapped}`;
          resolution = "mapped-module";
        } else if (root) {
          to = `module:external:${root}`;
          resolution = "external-module";
          if (!moduleNodes.has(to)) {
            const node = { id: to, type: "module", moduleId: root, moduleKind: "external-unmapped", paths: [], imports: [root] };
            nodes.push(node);
            moduleNodes.set(to, node);
          }
        }
      }
      if (!to) skipped.push({ file: source.path, reason: resolution, specifier: dependency.specifier, syntax: dependency.syntax });
      fileEdges.push({
        scope: "file",
        from: source.id,
        to,
        type: dependency.type,
        syntax: dependency.syntax,
        specifier: dependency.specifier,
        resolution,
        targetPath,
      });
    }
  }

  const uniqueFileEdges = [...new Map(fileEdges.map((edge) => [JSON.stringify(edge), edge])).values()].sort(edgeOrder);
  const groupedModuleEdges = new Map();
  for (const edge of uniqueFileEdges) {
    const source = fileNodes.get(edge.from.slice("file:".length));
    if (!source?.module || !edge.to) continue;
    const targetFile = edge.to.startsWith("file:") ? fileNodes.get(edge.to.slice("file:".length)) : null;
    const targetModule = targetFile?.module || (moduleNodes.get(edge.to)?.moduleKind === "contract" ? moduleNodes.get(edge.to).moduleId : null);
    if (!targetModule || targetModule === source.module) continue;
    const key = `${source.module}\0${targetModule}\0${edge.type}`;
    const current = groupedModuleEdges.get(key) || {
      scope: "module",
      from: `module:${source.module}`,
      to: `module:${targetModule}`,
      type: edge.type,
      syntax: "derived",
      specifier: "",
      resolution: "derived-module",
      evidence: [],
    };
    current.evidence.push({ file: source.path, specifier: edge.specifier });
    groupedModuleEdges.set(key, current);
  }
  const moduleEdges = [...groupedModuleEdges.values()].map((edge) => ({
    ...edge,
    evidence: edge.evidence.sort((left, right) => compare(`${left.file}\0${left.specifier}`, `${right.file}\0${right.specifier}`)),
  })).sort(edgeOrder);

  return {
    schemaVersion: 1,
    status: "evaluated",
    contractPath: ARCHITECTURE_CONTRACT_FILE,
    architectureStyle: contract.architectureStyle,
    nodes: nodes.sort((left, right) => compare(left.id, right.id)),
    edges: [...uniqueFileEdges, ...moduleEdges].sort(edgeOrder),
    cycles: [],
    skipped: skipped.sort((left, right) => compare(`${left.file}\0${left.reason}\0${left.specifier || ""}`, `${right.file}\0${right.reason}\0${right.specifier || ""}`)),
  };
}
