import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { GovernanceError } from "../errors.mjs";
import { ARCHITECTURE_CONTRACT_FILE } from "./paths.mjs";

export { ARCHITECTURE_CONTRACT_FILE } from "./paths.mjs";

function compare(left, right) {
  return Buffer.from(left).compare(Buffer.from(right));
}

export function architectureContractError(message, details = {}) {
  return new GovernanceError(message, { code: "RG_ARCHITECTURE_CONTRACT", details });
}

function expect(condition, message, details = {}) {
  if (!condition) throw architectureContractError(message, details);
}

function stringArray(value, field, { nonEmpty = false } = {}) {
  expect(Array.isArray(value), `${field} must be an array.`);
  if (nonEmpty) expect(value.length > 0, `${field} must not be empty.`);
  expect(value.every((item) => typeof item === "string" && item.length > 0 && item === item.trim()), `${field} must contain non-empty trimmed strings.`);
  expect(new Set(value).size === value.length, `${field} must not contain duplicates.`);
  return [...value].sort(compare);
}

function safePathPattern(pattern, field) {
  expect(!isAbsolute(pattern) && !pattern.startsWith("/") && !pattern.startsWith("\\"), `${field} must use repository-relative paths.`, { pattern });
  expect(!pattern.includes("\\"), `${field} must use POSIX separators.`, { pattern });
  expect(!pattern.split("/").includes(".."), `${field} must not escape the repository.`, { pattern });
}

function importRoot(value, field) {
  const valid = /^(?:@[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+|[A-Za-z0-9_.-]+)$/;
  expect(valid.test(value), `${field} must contain JavaScript package roots or Python top-level modules.`, { import: value });
}

export function validateArchitectureContract(input) {
  expect(input && typeof input === "object" && !Array.isArray(input), "Architecture contract must be an object.");
  expect(input.schemaVersion === 1, "Unsupported architecture contract schemaVersion; expected 1.");
  expect(typeof input.architectureStyle === "string" && input.architectureStyle.trim().length > 0, "architectureStyle must be a non-empty string.");
  expect(Array.isArray(input.layers) && input.layers.length > 0, "layers must be a non-empty array.");
  expect(input.modules === undefined || Array.isArray(input.modules), "modules must be an array when present.");

  const ids = new Set();
  const normalizeId = (id, field) => {
    expect(typeof id === "string" && /^[A-Za-z][A-Za-z0-9._-]*$/.test(id), `${field} must be a stable identifier.`, { id });
    expect(!ids.has(id), `Architecture id is duplicated: ${id}.`, { id });
    ids.add(id);
    return id;
  };

  const layers = input.layers.map((layer, index) => {
    expect(layer && typeof layer === "object" && !Array.isArray(layer), `layers[${index}] must be an object.`);
    const id = normalizeId(layer.id, `layers[${index}].id`);
    const paths = stringArray(layer.paths, `layers[${index}].paths`, { nonEmpty: true });
    for (const pattern of paths) safePathPattern(pattern, `layers[${index}].paths`);
    return {
      id,
      paths,
      allowedDependencies: stringArray(layer.allowedDependencies, `layers[${index}].allowedDependencies`),
      forbiddenDependencies: stringArray(layer.forbiddenDependencies, `layers[${index}].forbiddenDependencies`),
    };
  });

  const modules = (input.modules || []).map((module, index) => {
    expect(module && typeof module === "object" && !Array.isArray(module), `modules[${index}] must be an object.`);
    const id = normalizeId(module.id, `modules[${index}].id`);
    const paths = stringArray(module.paths || [], `modules[${index}].paths`);
    const imports = stringArray(module.imports || [], `modules[${index}].imports`);
    expect(paths.length > 0 || imports.length > 0, `modules[${index}] must declare paths or imports.`);
    for (const pattern of paths) safePathPattern(pattern, `modules[${index}].paths`);
    for (const value of imports) importRoot(value, `modules[${index}].imports`);
    return { id, paths, imports };
  });

  for (const layer of layers) {
    const allowed = new Set(layer.allowedDependencies);
    for (const dependency of [...layer.allowedDependencies, ...layer.forbiddenDependencies]) {
      expect(ids.has(dependency), `Layer ${layer.id} references unknown dependency ${dependency}.`, { layer: layer.id, dependency });
      expect(dependency !== layer.id, `Layer ${layer.id} must not declare itself as a dependency boundary.`, { layer: layer.id });
    }
    for (const dependency of layer.forbiddenDependencies) {
      expect(!allowed.has(dependency), `Layer ${layer.id} cannot both allow and forbid ${dependency}.`, { layer: layer.id, dependency });
    }
  }

  const importOwners = new Map();
  for (const module of modules) {
    for (const value of module.imports) {
      expect(!importOwners.has(value), `Import root ${value} is mapped to multiple modules.`, { import: value, modules: [importOwners.get(value), module.id] });
      importOwners.set(value, module.id);
    }
  }

  return {
    schemaVersion: 1,
    architectureStyle: input.architectureStyle,
    layers: layers.sort((left, right) => compare(left.id, right.id)),
    modules: modules.sort((left, right) => compare(left.id, right.id)),
  };
}

export function readArchitectureContract(repo, { changedPaths = [] } = {}) {
  const absolutePath = join(repo, ARCHITECTURE_CONTRACT_FILE);
  if (!existsSync(absolutePath)) {
    if (changedPaths.includes(ARCHITECTURE_CONTRACT_FILE)) {
      throw architectureContractError("Architecture contract was removed; RG007 cannot be silently disabled.", { path: ARCHITECTURE_CONTRACT_FILE });
    }
    return null;
  }
  let input;
  try {
    input = JSON.parse(readFileSync(absolutePath, "utf8"));
  } catch (error) {
    throw architectureContractError(`Unable to read ${ARCHITECTURE_CONTRACT_FILE}: ${error.message}`, { path: ARCHITECTURE_CONTRACT_FILE });
  }
  return validateArchitectureContract(input);
}
