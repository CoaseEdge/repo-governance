import { readFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import taskContractSchema from "../schemas/task-contract.schema.json" with { type: "json" };
import { GovernanceError } from "./errors.mjs";

export const TASK_CONTRACT_FILE = ".repo-governance/task-contract.json";

const ENGINEERING_PROFILES = taskContractSchema.$defs.engineeringProfile.enum;
const BUDGET_FIELDS = ["maxDirectories", "maxMigrations", "maxOutOfScopeFiles"];
const V2_BUDGET_FIELDS = ["maxNewFiles", "maxAddedLines", "maxTestFiles", "maxTestAddedLines"];

function compare(left, right) {
  return Buffer.from(left).compare(Buffer.from(right));
}

export function taskContractError(message, details = {}) {
  return new GovernanceError(message, { code: "RG_TASK_CONTRACT", details });
}

function expect(condition, message, details = {}) {
  if (!condition) throw taskContractError(message, details);
}

function validateObjectKeys(value, { required, allowed }, label) {
  expect(value && typeof value === "object" && !Array.isArray(value), `${label} must be an object.`);
  const actual = Object.keys(value).sort(compare);
  const missing = required.filter((key) => !actual.includes(key)).sort(compare);
  const unknown = actual.filter((key) => !allowed.includes(key)).sort(compare);
  expect(missing.length === 0, `${label} is missing required fields: ${missing.join(", ")}.`, { missing });
  expect(unknown.length === 0, `${label} contains unknown fields: ${unknown.join(", ")}.`, { unknown });
}

function stringArray(value, field, { nonEmpty = false, pattern = null } = {}) {
  expect(Array.isArray(value), `${field} must be an array.`);
  if (nonEmpty) expect(value.length > 0, `${field} must not be empty.`);
  expect(
    value.every((item) => typeof item === "string" && item.length > 0 && item === item.trim()),
    `${field} must contain non-empty trimmed strings.`,
  );
  expect(new Set(value).size === value.length, `${field} must not contain duplicates.`);
  if (pattern) expect(value.every((item) => pattern.test(item)), `${field} contains an invalid identifier.`);
  return [...value].sort(compare);
}

function safePathPattern(pattern, field) {
  expect(!isAbsolute(pattern) && !/^[A-Za-z]:\//.test(pattern), `${field} must use repository-relative paths.`, { pattern });
  expect(!pattern.includes("\\"), `${field} must use POSIX separators.`, { pattern });
  expect(!pattern.split("/").includes(".."), `${field} must not escape the repository.`, { pattern });
}

export function validateTaskContract(input) {
  expect(input && typeof input === "object" && !Array.isArray(input), "Task contract must be an object.");
  expect([1, 2].includes(input.schemaVersion), "Unsupported task contract schemaVersion; expected 1 or 2.");
  const schemaVersion = input.schemaVersion;
  const allowedFields = Object.keys(taskContractSchema.properties).filter(
    (field) => schemaVersion === 2 || field !== "engineeringProfile",
  );
  validateObjectKeys(input, {
    required: schemaVersion === 2 ? [...taskContractSchema.required, "engineeringProfile"] : taskContractSchema.required,
    allowed: allowedFields,
  }, "Task contract");
  expect(
    typeof input.taskId === "string" && /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(input.taskId),
    "taskId must be a stable identifier.",
    { taskId: input.taskId },
  );
  expect(typeof input.objective === "string" && input.objective.trim().length > 0, "objective must be a non-empty string.");
  if (schemaVersion === 2) {
    expect(ENGINEERING_PROFILES.includes(input.engineeringProfile), "engineeringProfile must be one of small, standard, high, or critical.");
  }

  const allowedPaths = stringArray(input.allowedPaths, "allowedPaths", { nonEmpty: true });
  const forbiddenPaths = stringArray(input.forbiddenPaths, "forbiddenPaths");
  const migrationPaths = stringArray(input.migrationPaths === undefined ? [] : input.migrationPaths, "migrationPaths");
  for (const pattern of allowedPaths) safePathPattern(pattern, "allowedPaths");
  for (const pattern of forbiddenPaths) safePathPattern(pattern, "forbiddenPaths");
  for (const pattern of migrationPaths) safePathPattern(pattern, "migrationPaths");

  const allowedChangeCategories = stringArray(
    input.allowedChangeCategories === undefined ? [] : input.allowedChangeCategories,
    "allowedChangeCategories",
    { pattern: /^[a-z][a-z0-9-]*$/ },
  );

  const driftInput = input.drift === undefined ? {} : input.drift;
  validateObjectKeys(driftInput, {
    required: [],
    allowed: Object.keys(taskContractSchema.properties.drift.properties),
  }, "Task contract drift");
  const subsystemInputs = driftInput.subsystems === undefined ? [] : driftInput.subsystems;
  expect(Array.isArray(subsystemInputs), "drift.subsystems must be an array.");
  const subsystemIds = new Set();
  const subsystemPatterns = new Set();
  const subsystems = subsystemInputs.map((subsystem, index) => {
    validateObjectKeys(subsystem, {
      required: taskContractSchema.$defs.subsystem.required,
      allowed: Object.keys(taskContractSchema.$defs.subsystem.properties),
    }, `drift.subsystems[${index}]`);
    expect(
      typeof subsystem.id === "string" && /^[a-z][a-z0-9-]*$/.test(subsystem.id),
      `drift.subsystems[${index}].id must be a stable lowercase identifier.`,
      { id: subsystem.id },
    );
    expect(!subsystemIds.has(subsystem.id), `drift.subsystems contains duplicate id ${subsystem.id}.`, { id: subsystem.id });
    subsystemIds.add(subsystem.id);
    const paths = stringArray(subsystem.paths, `drift.subsystems[${index}].paths`, { nonEmpty: true });
    for (const pattern of paths) {
      safePathPattern(pattern, `drift.subsystems[${index}].paths`);
      expect(!subsystemPatterns.has(pattern), `drift.subsystems contains duplicate path pattern ${pattern}.`, { pattern });
      subsystemPatterns.add(pattern);
    }
    return { id: subsystem.id, paths };
  }).sort((left, right) => compare(left.id, right.id));
  const sharedPaths = stringArray(driftInput.sharedPaths === undefined ? [] : driftInput.sharedPaths, "drift.sharedPaths");
  const ciReleasePaths = stringArray(driftInput.ciReleasePaths === undefined ? [] : driftInput.ciReleasePaths, "drift.ciReleasePaths");
  for (const pattern of sharedPaths) safePathPattern(pattern, "drift.sharedPaths");
  for (const pattern of ciReleasePaths) safePathPattern(pattern, "drift.ciReleasePaths");

  validateObjectKeys(input.budget, {
    required: taskContractSchema.$defs.budgetV1.required,
    allowed: Object.keys(taskContractSchema.$defs[schemaVersion === 1 ? "budgetV1" : "budgetV2"].properties),
  }, "Task contract budget");
  expect(Number.isInteger(input.budget.maxFiles) && input.budget.maxFiles >= 1, "budget.maxFiles must be a positive integer.");
  const optionalBudgetFields = schemaVersion === 2 ? [...BUDGET_FIELDS, ...V2_BUDGET_FIELDS] : BUDGET_FIELDS;
  for (const field of optionalBudgetFields) {
    if (input.budget[field] !== undefined) {
      expect(Number.isInteger(input.budget[field]) && input.budget[field] >= 0, `budget.${field} must be a non-negative integer.`);
    }
  }
  expect(input.budget.maxMigrations === undefined || migrationPaths.length > 0, "migrationPaths must not be empty when budget.maxMigrations is declared.");

  const budget = { maxFiles: input.budget.maxFiles };
  for (const field of optionalBudgetFields) {
    if (input.budget[field] !== undefined) budget[field] = input.budget[field];
  }

  return {
    schemaVersion,
    taskId: input.taskId,
    objective: input.objective.trim(),
    ...(schemaVersion === 2 ? { engineeringProfile: input.engineeringProfile } : {}),
    allowedPaths,
    forbiddenPaths,
    migrationPaths,
    allowedChangeCategories,
    drift: { subsystems, sharedPaths, ciReleasePaths },
    budget,
  };
}

export function loadTaskContract(repo) {
  expect(typeof repo === "string" && repo.length > 0, "Repository path must be a non-empty string.");
  const path = join(repo, TASK_CONTRACT_FILE);
  let source;
  try {
    source = readFileSync(path, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw taskContractError(`Unable to read ${TASK_CONTRACT_FILE}: ${error.message}`, {
      path: TASK_CONTRACT_FILE,
      causeCode: error.code || null,
    });
  }

  let input;
  try {
    input = JSON.parse(source);
  } catch (error) {
    throw taskContractError(`Unable to read ${TASK_CONTRACT_FILE}: ${error.message}`, { path: TASK_CONTRACT_FILE });
  }
  return validateTaskContract(input);
}
