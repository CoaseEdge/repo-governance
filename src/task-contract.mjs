import { readFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import taskContractSchema from "../schemas/task-contract.schema.json" with { type: "json" };
import { GovernanceError } from "./errors.mjs";

export const TASK_CONTRACT_FILE = ".repo-governance/task-contract.json";

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
  validateObjectKeys(input, {
    required: taskContractSchema.required,
    allowed: Object.keys(taskContractSchema.properties),
  }, "Task contract");
  expect(input.schemaVersion === 1, "Unsupported task contract schemaVersion; expected 1.");
  expect(
    typeof input.taskId === "string" && /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(input.taskId),
    "taskId must be a stable identifier.",
    { taskId: input.taskId },
  );
  expect(typeof input.objective === "string" && input.objective.trim().length > 0, "objective must be a non-empty string.");

  const allowedPaths = stringArray(input.allowedPaths, "allowedPaths", { nonEmpty: true });
  const forbiddenPaths = stringArray(input.forbiddenPaths, "forbiddenPaths");
  for (const pattern of allowedPaths) safePathPattern(pattern, "allowedPaths");
  for (const pattern of forbiddenPaths) safePathPattern(pattern, "forbiddenPaths");

  const allowedChangeCategories = stringArray(
    input.allowedChangeCategories === undefined ? [] : input.allowedChangeCategories,
    "allowedChangeCategories",
    { pattern: /^[a-z][a-z0-9-]*$/ },
  );

  validateObjectKeys(input.budget, {
    required: taskContractSchema.properties.budget.required,
    allowed: Object.keys(taskContractSchema.properties.budget.properties),
  }, "Task contract budget");
  expect(Number.isInteger(input.budget.maxFiles) && input.budget.maxFiles >= 1, "budget.maxFiles must be a positive integer.");

  return {
    schemaVersion: 1,
    taskId: input.taskId,
    objective: input.objective.trim(),
    allowedPaths,
    forbiddenPaths,
    allowedChangeCategories,
    budget: { maxFiles: input.budget.maxFiles },
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
