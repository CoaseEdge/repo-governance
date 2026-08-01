import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import taskBaselineSchema from "../../schemas/task-baseline.schema.json" with { type: "json" };
import testResultsSchema from "../../schemas/test-results.schema.json" with { type: "json" };
import { readConfig } from "../config.mjs";
import { GovernanceError } from "../errors.mjs";

export const TASK_BASELINE_FILE = ".repo-governance/task-baseline.json";

function compare(left, right) {
  return Buffer.from(left).compare(Buffer.from(right));
}

export function taskBaselineError(message, details = {}) {
  return new GovernanceError(message, { code: "RG_TASK_BASELINE", details });
}

function expect(condition, message, details = {}) {
  if (!condition) throw taskBaselineError(message, details);
}

function validateObjectKeys(input, schema, label) {
  expect(input && typeof input === "object" && !Array.isArray(input), `${label} must be an object.`);
  const actual = Object.keys(input).sort(compare);
  const required = schema.required || [];
  const allowed = Object.keys(schema.properties || {});
  const missing = required.filter((key) => !actual.includes(key)).sort(compare);
  const unknown = actual.filter((key) => !allowed.includes(key)).sort(compare);
  expect(missing.length === 0, `${label} is missing required fields: ${missing.join(", ")}.`, { missing });
  expect(unknown.length === 0, `${label} contains unknown fields: ${unknown.join(", ")}.`, { unknown });
}

function normalizeTests(tests, label) {
  expect(tests && typeof tests === "object" && !Array.isArray(tests), `${label}.tests must be an object.`);
  const suitePattern = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
  const normalized = {};
  for (const suite of Object.keys(tests).sort(compare)) {
    expect(suitePattern.test(suite), `${label}.tests contains an invalid suite identifier.`, { suite });
    const suiteResults = tests[suite];
    validateObjectKeys(suiteResults, testResultsSchema.$defs.suiteResults, `${label}.tests.${suite}`);
    expect(Array.isArray(suiteResults.failed), `${label}.tests.${suite}.failed must be an array.`);
    expect(
      suiteResults.failed.every((failure) => typeof failure === "string" && failure.length > 0 && failure === failure.trim()),
      `${label}.tests.${suite}.failed must contain non-empty trimmed strings.`,
    );
    expect(new Set(suiteResults.failed).size === suiteResults.failed.length, `${label}.tests.${suite}.failed must not contain duplicates.`);
    normalized[suite] = { failed: [...suiteResults.failed].sort(compare) };
  }
  return normalized;
}

export function validateTestResults(input) {
  validateObjectKeys(input, testResultsSchema, "Test results");
  expect(input.schemaVersion === 1, "Unsupported test results schemaVersion; expected 1.");
  return { schemaVersion: 1, tests: normalizeTests(input.tests, "Test results") };
}

export function validateTaskBaseline(input) {
  validateObjectKeys(input, taskBaselineSchema, "Task baseline");
  expect(input.schemaVersion === 1, "Unsupported task baseline schemaVersion; expected 1.");
  expect(
    typeof input.createdAt === "string"
      && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(input.createdAt)
      && !Number.isNaN(Date.parse(input.createdAt))
      && new Date(input.createdAt).toISOString() === input.createdAt,
    "Task baseline createdAt must be a canonical UTC timestamp.",
  );
  return {
    schemaVersion: 1,
    createdAt: input.createdAt,
    tests: normalizeTests(input.tests, "Task baseline"),
  };
}

function readJson(path, label) {
  let source;
  try {
    source = readFileSync(path, "utf8");
  } catch (error) {
    throw taskBaselineError(`Unable to read ${label}: ${error.message}`, { path, causeCode: error.code || null });
  }
  try {
    return JSON.parse(source);
  } catch (error) {
    throw taskBaselineError(`Unable to read ${label}: ${error.message}`, { path });
  }
}

export function loadTestResults(path) {
  expect(typeof path === "string" && path.length > 0, "Test results path must be a non-empty string.");
  return validateTestResults(readJson(path, "test results"));
}

export function readTaskBaseline(repo) {
  expect(typeof repo === "string" && repo.length > 0, "Repository path must be a non-empty string.");
  const path = join(repo, TASK_BASELINE_FILE);
  if (!existsSync(path)) throw taskBaselineError(`Task baseline is missing at ${TASK_BASELINE_FILE}.`, { path: TASK_BASELINE_FILE });
  return validateTaskBaseline(readJson(path, TASK_BASELINE_FILE));
}

export function writeTaskBaseline(repo, baseline, { replace = false, beforeRename } = {}) {
  const normalized = validateTaskBaseline(baseline);
  const path = join(repo, TASK_BASELINE_FILE);
  const existed = existsSync(path);
  if (existed && !replace) throw taskBaselineError(`Task baseline already exists at ${TASK_BASELINE_FILE}; use --replace to reset it explicitly.`, { path: TASK_BASELINE_FILE });
  mkdirSync(dirname(path), { recursive: true });
  const temporaryPath = `${path}.tmp-${process.pid}-${Date.now()}`;
  try {
    writeFileSync(temporaryPath, `${JSON.stringify(normalized, null, 2)}\n`, { flag: "wx" });
    if (beforeRename) beforeRename(temporaryPath);
    renameSync(temporaryPath, path);
  } finally {
    rmSync(temporaryPath, { force: true });
  }
  return { path: TASK_BASELINE_FILE, replaced: existed, baseline: normalized };
}

export function createTaskBaseline(repo, results, { createdAt, replace = false, beforeRename } = {}) {
  readConfig(repo);
  const normalizedResults = validateTestResults(results);
  const written = writeTaskBaseline(repo, {
    schemaVersion: 1,
    createdAt,
    tests: normalizedResults.tests,
  }, { replace, beforeRename });
  const status = written.replaced ? "replaced" : "created";
  return {
    schemaVersion: 1,
    command: "baseline create",
    ok: true,
    exitCode: 0,
    status,
    baselinePath: TASK_BASELINE_FILE,
    baseline: written.baseline,
    message: `Task failure baseline ${status} at ${TASK_BASELINE_FILE}.`,
  };
}

function failures(tests) {
  return Object.entries(tests).flatMap(([suite, result]) => result.failed.map((test) => ({ suite, test })));
}

function failureKey(failure) {
  return `${failure.suite}\0${failure.test}`;
}

export function classifyTestFailures(baseline, current) {
  const baselineFailures = failures(validateTaskBaseline(baseline).tests);
  const currentFailures = failures(validateTestResults(current).tests);
  const baselineKeys = new Set(baselineFailures.map(failureKey));
  const currentKeys = new Set(currentFailures.map(failureKey));
  return {
    newFailures: currentFailures.filter((failure) => !baselineKeys.has(failureKey(failure))),
    existingFailures: currentFailures.filter((failure) => baselineKeys.has(failureKey(failure))),
    fixedFailures: baselineFailures.filter((failure) => !currentKeys.has(failureKey(failure))),
  };
}

export function compareTaskBaseline(repo, results) {
  readConfig(repo);
  const baseline = readTaskBaseline(repo);
  const normalizedResults = validateTestResults(results);
  const classification = classifyTestFailures(baseline, normalizedResults);
  return {
    schemaVersion: 1,
    command: "baseline compare",
    ok: true,
    exitCode: 0,
    baselinePath: TASK_BASELINE_FILE,
    ...classification,
    message: `Test failure comparison: ${classification.newFailures.length} new, ${classification.existingFailures.length} existing, ${classification.fixedFailures.length} fixed.`,
  };
}
