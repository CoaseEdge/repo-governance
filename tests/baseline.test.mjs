import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { main } from "../src/cli.mjs";
import {
  TASK_BASELINE_FILE,
  classifyTestFailures,
  compareTaskBaseline,
  createTaskBaseline,
  loadTestResults,
  readTaskBaseline,
  validateTaskBaseline,
  validateTestResults,
} from "../src/test-baseline/index.mjs";
import { baseConfig, initGitRepo, temporaryDirectory, write, writeConfig } from "./helpers.mjs";

const CREATED_AT = "2026-08-01T09:30:00.000Z";

function repository() {
  const repo = initGitRepo();
  writeConfig(repo, baseConfig());
  return repo;
}

function results(tests) {
  return { schemaVersion: 1, tests };
}

function capture() {
  let value = "";
  return { stream: { write(chunk) { value += String(chunk); } }, read() { return value; } };
}

test("schemas and validators normalize suites and failures deterministically", () => {
  const resultsSchema = JSON.parse(readFileSync(new URL("../schemas/test-results.schema.json", import.meta.url), "utf8"));
  const baselineSchema = JSON.parse(readFileSync(new URL("../schemas/task-baseline.schema.json", import.meta.url), "utf8"));
  assert.equal(resultsSchema.$id, "https://github.com/CoaseEdge/repo-governance/schemas/test-results.schema.json");
  assert.equal(baselineSchema.$id, "https://github.com/CoaseEdge/repo-governance/schemas/task-baseline.schema.json");

  const normalized = validateTestResults(results({ vitest: { failed: ["z.test.mjs", "a.test.mjs"] }, playwright: { failed: [] } }));
  assert.deepEqual(Object.keys(normalized.tests), ["playwright", "vitest"]);
  assert.deepEqual(normalized.tests.vitest.failed, ["a.test.mjs", "z.test.mjs"]);
  assert.throws(() => validateTestResults({ ...normalized, unknown: true }), (error) => error.code === "RG_TASK_BASELINE" && /unknown/.test(error.message));
  assert.throws(() => validateTestResults(results({ vitest: { failed: ["same", "same"] } })), (error) => error.code === "RG_TASK_BASELINE" && /duplicates/.test(error.message));
  assert.throws(() => validateTestResults(results({ "bad suite": { failed: [] } })), (error) => error.code === "RG_TASK_BASELINE" && /suite identifier/.test(error.message));
  assert.throws(() => validateTaskBaseline({ schemaVersion: 1, createdAt: "2026-08-01T09:30:00Z", tests: {} }), (error) => error.code === "RG_TASK_BASELINE" && /canonical UTC/.test(error.message));
});

test("baseline creation is deterministic and replacement is explicit", () => {
  const repo = repository();
  const input = results({ vitest: { failed: ["z.test.mjs", "a.test.mjs"] }, playwright: { failed: ["auth.spec.ts"] } });
  const created = createTaskBaseline(repo, input, { createdAt: CREATED_AT });
  const firstBytes = readFileSync(join(repo, TASK_BASELINE_FILE), "utf8");
  assert.equal(created.status, "created");
  assert.deepEqual(readTaskBaseline(repo), created.baseline);
  assert.throws(() => createTaskBaseline(repo, input, { createdAt: CREATED_AT }), (error) => error.code === "RG_TASK_BASELINE" && /--replace/.test(error.message));
  const replaced = createTaskBaseline(repo, input, { createdAt: CREATED_AT, replace: true });
  assert.equal(replaced.status, "replaced");
  assert.equal(readFileSync(join(repo, TASK_BASELINE_FILE), "utf8"), firstBytes);
});

test("atomic baseline failures leave no partial file or temporary residue", () => {
  const repo = repository();
  assert.throws(() => createTaskBaseline(repo, results({ vitest: { failed: [] } }), {
    createdAt: CREATED_AT,
    beforeRename() { throw new Error("injected failure"); },
  }), /injected failure/);
  assert.equal(existsSync(join(repo, TASK_BASELINE_FILE)), false);
  assert.deepEqual(readdirSync(join(repo, ".repo-governance")).filter((name) => name.includes("task-baseline.json.tmp-")), []);

  createTaskBaseline(repo, results({ vitest: { failed: ["old.test.mjs"] } }), { createdAt: CREATED_AT });
  const original = readFileSync(join(repo, TASK_BASELINE_FILE), "utf8");
  assert.throws(() => createTaskBaseline(repo, results({ vitest: { failed: ["new.test.mjs"] } }), {
    createdAt: CREATED_AT,
    replace: true,
    beforeRename() { throw new Error("injected replacement failure"); },
  }), /injected replacement failure/);
  assert.equal(readFileSync(join(repo, TASK_BASELINE_FILE), "utf8"), original);
  assert.deepEqual(readdirSync(join(repo, ".repo-governance")).filter((name) => name.includes("task-baseline.json.tmp-")), []);
});

test("comparison classifies new, existing, and fixed failures in stable suite order", () => {
  const baseline = {
    schemaVersion: 1,
    createdAt: CREATED_AT,
    tests: {
      vitest: { failed: ["fixed.test.mjs", "shared.test.mjs"] },
      playwright: { failed: ["old.spec.ts"] },
    },
  };
  const current = results({ vitest: { failed: ["new.test.mjs", "shared.test.mjs"] }, playwright: { failed: ["old.spec.ts"] } });
  assert.deepEqual(classifyTestFailures(baseline, current), {
    newFailures: [{ suite: "vitest", test: "new.test.mjs" }],
    existingFailures: [
      { suite: "playwright", test: "old.spec.ts" },
      { suite: "vitest", test: "shared.test.mjs" },
    ],
    fixedFailures: [{ suite: "vitest", test: "fixed.test.mjs" }],
  });

  const repo = repository();
  createTaskBaseline(repo, { schemaVersion: 1, tests: baseline.tests }, { createdAt: CREATED_AT });
  const report = compareTaskBaseline(repo, current);
  assert.equal(report.ok, true);
  assert.equal(report.exitCode, 0);
  assert.equal(report.newFailures.length, 1);
});

test("loaders reject missing, damaged, and structurally invalid JSON with RG_TASK_BASELINE", () => {
  const directory = temporaryDirectory("repo-governance-results-");
  const missing = join(directory, "missing.json");
  assert.throws(() => loadTestResults(missing), (error) => error.code === "RG_TASK_BASELINE" && error.details.causeCode === "ENOENT");
  const damaged = join(directory, "damaged.json");
  write(damaged, "{");
  assert.throws(() => loadTestResults(damaged), (error) => error.code === "RG_TASK_BASELINE" && /Unable to read/.test(error.message));
  const invalid = join(directory, "invalid.json");
  write(invalid, JSON.stringify({ schemaVersion: 1, tests: { vitest: { failed: [], skipped: [] } } }));
  assert.throws(() => loadTestResults(invalid), (error) => error.code === "RG_TASK_BASELINE" && /unknown/.test(error.message));
  assert.throws(() => readTaskBaseline(repository()), (error) => error.code === "RG_TASK_BASELINE" && /missing/.test(error.message));
});

test("baseline CLI exposes JSON and human reports without running tests or blocking on new failures", async () => {
  const repo = repository();
  const directory = temporaryDirectory("repo-governance-cli-baseline-");
  const initialPath = join(directory, "initial.json");
  const currentPath = join(directory, "current.json");
  write(initialPath, `${JSON.stringify(results({ vitest: { failed: ["old.test.mjs"] } }))}\n`);
  write(currentPath, `${JSON.stringify(results({ vitest: { failed: ["old.test.mjs", "new.test.mjs"] } }))}\n`);

  const createOut = capture();
  assert.equal(await main(["baseline", "create", "--results", initialPath, "--created-at", CREATED_AT, "--json"], { cwd: repo, stdout: createOut.stream }), 0);
  assert.equal(JSON.parse(createOut.read()).status, "created");

  const compareOut = capture();
  assert.equal(await main(["baseline", "compare", "--results", currentPath, "--json"], { cwd: repo, stdout: compareOut.stream }), 0);
  const report = JSON.parse(compareOut.read());
  assert.equal(report.ok, true);
  assert.equal(report.exitCode, 0);
  assert.deepEqual(report.newFailures, [{ suite: "vitest", test: "new.test.mjs" }]);

  const humanOut = capture();
  assert.equal(await main(["baseline", "compare", "--results", currentPath], { cwd: repo, stdout: humanOut.stream }), 0);
  assert.match(humanOut.read(), /1 new, 1 existing, 0 fixed/);

  const errorOut = capture();
  assert.equal(await main(["baseline", "create", "--results", initialPath, "--json"], { cwd: repo, stderr: errorOut.stream }), 2);
  assert.equal(JSON.parse(errorOut.read()).error.code, "RG_INVOCATION");

  const bareFlagOut = capture();
  assert.equal(await main(["baseline", "compare", "--results", "--json"], { cwd: repo, stderr: bareFlagOut.stream }), 2);
  assert.equal(JSON.parse(bareFlagOut.read()).error.code, "RG_INVOCATION");

  const missingResultsOut = capture();
  assert.equal(await main(["baseline", "compare", "--results", join(directory, "missing.json"), "--json"], { cwd: repo, stderr: missingResultsOut.stream }), 2);
  assert.equal(JSON.parse(missingResultsOut.read()).error.code, "RG_TASK_BASELINE");

  const noBaselineRepo = repository();
  const missingBaselineOut = capture();
  assert.equal(await main(["baseline", "compare", "--results", currentPath, "--json"], { cwd: noBaselineRepo, stderr: missingBaselineOut.stream }), 2);
  assert.equal(JSON.parse(missingBaselineOut.read()).error.code, "RG_TASK_BASELINE");
});
