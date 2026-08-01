import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { createArchitectureBaseline } from "../src/architecture/baseline.mjs";
import { reportArchitectureDrift, scoreArchitectureChanges } from "../src/architecture/drift.mjs";
import { checkRepository } from "../src/check.mjs";
import { main } from "../src/cli.mjs";
import { baseConfig, commitAll, git, initGitRepo, write, writeConfig } from "./helpers.mjs";

const BASELINE_PATH = ".repo-governance/architecture-baseline.json";

function architectureContract({ forbidData = false } = {}) {
  return {
    schemaVersion: 1,
    architectureStyle: "modular-layers",
    layers: [
      { id: "domain", paths: ["src/domain/**"], allowedDependencies: forbidData ? [] : ["data"], forbiddenDependencies: forbidData ? ["data", "http-client"] : ["http-client"] },
      { id: "data", paths: ["src/data/**"], allowedDependencies: ["domain"], forbiddenDependencies: [] },
    ],
    modules: [
      { id: "domain-module", paths: ["src/domain/**"] },
      { id: "data-module", paths: ["src/data/**"] },
      { id: "http-client", imports: ["axios", "requests"] },
    ],
  };
}

function createRepository(options = {}) {
  const repo = initGitRepo();
  writeConfig(repo, baseConfig());
  write(join(repo, ".repo-governance", "architecture-contract.json"), `${JSON.stringify(architectureContract(options), null, 2)}\n`);
  write(join(repo, "src", "domain", "domain.js"), "export const domain = true;\n");
  write(join(repo, "src", "data", "data.js"), "export const data = true;\n");
  commitAll(repo, "architecture contract");
  createArchitectureBaseline(repo);
  const baselineBytes = readFileSync(join(repo, BASELINE_PATH), "utf8");
  const baselineCommit = commitAll(repo, "architecture baseline");
  return { repo, baselineBytes, baselineCommit };
}

function capture() {
  let value = "";
  return { stream: { write(chunk) { value += chunk; } }, read() { return value; } };
}

test("architecture baseline schemas and deterministic snapshots have stable digests", () => {
  const baselineSchema = JSON.parse(readFileSync(new URL("../schemas/architecture-baseline.schema.json", import.meta.url), "utf8"));
  const driftSchema = JSON.parse(readFileSync(new URL("../schemas/architecture-drift-report.schema.json", import.meta.url), "utf8"));
  assert.equal(baselineSchema.$id, "https://github.com/CoaseEdge/repo-governance/schemas/architecture-baseline.schema.json");
  assert.equal(driftSchema.$id, "https://github.com/CoaseEdge/repo-governance/schemas/architecture-drift-report.schema.json");

  const { repo, baselineBytes } = createRepository();
  const baseline = JSON.parse(baselineBytes);
  assert.equal(baseline.version, 1);
  assert.equal(baseline.healthScore, 100);
  assert.match(baseline.contractSha256, /^[0-9a-f]{64}$/);
  assert.match(baseline.graphSha256, /^[0-9a-f]{64}$/);
  assert.equal(baseline.metrics.explicitLocalModuleCount, 2);
  assert.equal(baseline.metrics.averageCoupling, 0);
  assert.equal(baseline.architectureGraph.nodes.some((node) => node.path === BASELINE_PATH), false);
  assert.throws(() => createArchitectureBaseline(repo), (error) => error.code === "RG_ARCHITECTURE_BASELINE" && /--replace/.test(error.message));
  createArchitectureBaseline(repo, { replace: true });
  assert.equal(readFileSync(join(repo, BASELINE_PATH), "utf8"), baselineBytes);
});

test("baseline writes are atomic and remove temporary files when replacement fails", () => {
  const repo = initGitRepo();
  writeConfig(repo, baseConfig());
  write(join(repo, ".repo-governance", "architecture-contract.json"), `${JSON.stringify(architectureContract(), null, 2)}\n`);
  write(join(repo, "src", "domain", "domain.js"), "export {};\n");
  write(join(repo, "src", "data", "data.js"), "export {};\n");
  assert.throws(() => createArchitectureBaseline(repo, { beforeRename() { throw new Error("injected atomic failure"); } }), /injected atomic failure/);
  assert.equal(existsSync(join(repo, BASELINE_PATH)), false);
  assert.deepEqual(readdirSync(join(repo, ".repo-governance")).filter((name) => name.includes(".tmp-")), []);
});

test("drift metrics produce a deterministic non-blocking warning for allowed coupling", () => {
  const { repo, baselineCommit } = createRepository();
  git(repo, ["switch", "-c", "allowed-drift"]);
  write(join(repo, "src", "domain", "domain.js"), 'import { data } from "../data/data.js";\nexport const domain = data;\n');
  commitAll(repo, "add allowed dependency");

  const first = checkRepository(repo, { base: baselineCommit });
  const second = checkRepository(repo, { base: baselineCommit });
  assert.deepEqual(first.architectureDrift, second.architectureDrift);
  assert.equal(first.architectureDrift.health.after, 95);
  assert.equal(first.architectureDrift.health.classification, "Minor drift");
  assert.deepEqual(first.architectureDrift.penalties, { boundary: 0, cycles: 0, dependencies: 4, coupling: 1, total: 5 });
  assert.equal(first.architectureDrift.metrics.current.averageCoupling, 0.5);
  assert.equal(first.architectureDriftFindings[0].severity, "warning");
  assert.equal(first.architectureDriftFindings[0].rule, "ARCHITECTURE_DRIFT");
  assert.equal(first.ok, true);
  assert.equal(first.exitCode, 0);
  assert.ok(first.findings.includes(first.architectureDriftFindings[0]));
});

test("new boundary violations and cycles can reduce health below the blocking threshold", () => {
  const { repo, baselineCommit } = createRepository({ forbidData: true });
  git(repo, ["switch", "-c", "degradation"]);
  write(join(repo, "src", "domain", "domain.js"), 'import { data } from "../data/data.js";\nimport axios from "axios/client";\nexport const domain = [data, axios];\n');
  write(join(repo, "src", "data", "data.js"), 'import { domain } from "../domain/domain.js";\nexport const data = domain;\n');
  commitAll(repo, "degrade architecture");

  const result = checkRepository(repo, { base: baselineCommit });
  assert.equal(result.architectureDrift.health.after, 59);
  assert.equal(result.architectureDrift.health.classification, "Architecture degradation");
  assert.deepEqual(result.architectureDrift.penalties, { boundary: 20, cycles: 10, dependencies: 8, coupling: 3, total: 41 });
  assert.equal(result.architectureDrift.changes.cycles.added.length, 2);
  assert.equal(result.architectureDriftFindings[0].severity, "error");
  assert.equal(result.ok, false);
  assert.equal(result.exitCode, 1);
  assert.deepEqual(result.architectureDrift.recommendations.map((item) => item.code), [
    "resolve-boundary-violations",
    "remove-new-cycles",
    "review-layer-dependencies",
    "reduce-module-coupling",
  ]);
});

test("health penalties use fixed caps and classification boundaries", () => {
  const changes = {
    boundaryViolations: { added: Array(5).fill({}), removed: [] },
    cycles: { added: Array(6).fill({}), removed: [] },
    layerDependencies: { added: Array(6).fill({}), removed: [] },
    moduleDependencies: { added: Array(20).fill({}), removed: [] },
  };
  assert.deepEqual(scoreArchitectureChanges(changes), {
    penalties: { boundary: 40, cycles: 25, dependencies: 20, coupling: 15, total: 100 },
    score: 0,
    classification: "Architecture degradation",
  });
  changes.boundaryViolations.added = [{}];
  changes.cycles.added = [{}];
  changes.layerDependencies.added = [];
  changes.moduleDependencies.added = [];
  assert.equal(scoreArchitectureChanges(changes).score, 85);
  assert.equal(scoreArchitectureChanges(changes).classification, "Needs attention");
});

test("missing baselines skip while deletion, corruption, and contract mismatch fail closed", () => {
  const repo = initGitRepo();
  writeConfig(repo, baseConfig());
  write(join(repo, ".repo-governance", "architecture-contract.json"), `${JSON.stringify(architectureContract(), null, 2)}\n`);
  write(join(repo, "src", "domain", "domain.js"), "export {};\n");
  write(join(repo, "src", "data", "data.js"), "export {};\n");
  const contractCommit = commitAll(repo, "contract only");
  assert.equal(checkRepository(repo, { base: contractCommit }).architectureDrift.status, "skipped");

  createArchitectureBaseline(repo);
  const baselineCommit = commitAll(repo, "baseline");
  git(repo, ["switch", "-c", "remove-baseline"]);
  git(repo, ["rm", BASELINE_PATH]);
  commitAll(repo, "remove baseline");
  assert.throws(() => checkRepository(repo, { base: baselineCommit }), (error) => error.code === "RG_ARCHITECTURE_BASELINE" && /silently disabled/.test(error.message));

  git(repo, ["switch", "main"]);
  git(repo, ["switch", "-c", "corrupt-baseline"]);
  write(join(repo, BASELINE_PATH), "{}\n");
  commitAll(repo, "corrupt baseline");
  assert.throws(() => checkRepository(repo, { base: baselineCommit }), (error) => error.code === "RG_ARCHITECTURE_BASELINE" && /version/.test(error.message));

  git(repo, ["switch", "main"]);
  git(repo, ["switch", "-c", "contract-mismatch"]);
  const changedContract = { ...architectureContract(), architectureStyle: "ports-and-adapters" };
  write(join(repo, ".repo-governance", "architecture-contract.json"), `${JSON.stringify(changedContract, null, 2)}\n`);
  commitAll(repo, "change architecture contract");
  assert.throws(() => checkRepository(repo, { base: baselineCommit }), (error) => error.code === "RG_ARCHITECTURE_BASELINE" && /digest/.test(error.message));
});

test("architecture baseline and drift CLI commands expose JSON and human contracts", async () => {
  const repo = initGitRepo();
  writeConfig(repo, baseConfig());
  write(join(repo, ".repo-governance", "architecture-contract.json"), `${JSON.stringify(architectureContract(), null, 2)}\n`);
  write(join(repo, "src", "domain", "domain.js"), "export {};\n");
  write(join(repo, "src", "data", "data.js"), "export {};\n");
  commitAll(repo, "contract");

  const baselineOut = capture();
  assert.equal(await main(["architecture", "baseline", "--json"], { cwd: repo, stdout: baselineOut.stream }), 0);
  assert.equal(JSON.parse(baselineOut.read()).status, "created");
  const driftOut = capture();
  assert.equal(await main(["architecture", "drift"], { cwd: repo, stdout: driftOut.stream }), 0);
  assert.match(driftOut.read(), /Architecture health: 100 -> 100\/100 \(Healthy\)/);
  assert.match(driftOut.read(), /boundary violations \+0\/-0/);
  assert.equal(reportArchitectureDrift(repo).health.after, 100);

  const stderr = capture();
  assert.equal(await main(["architecture", "baseline", "--json"], { cwd: repo, stderr: stderr.stream }), 2);
  assert.equal(JSON.parse(stderr.read()).error.code, "RG_ARCHITECTURE_BASELINE");
});
