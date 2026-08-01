import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { validateArchitectureContract } from "../src/architecture/contract.mjs";
import { scanSource } from "../src/architecture/scanner.mjs";
import { checkRepository } from "../src/check.mjs";
import { evaluateRg007 } from "../src/rg007.mjs";
import { baseConfig, commitAll, git, initGitRepo, write, writeConfig } from "./helpers.mjs";

function architectureContract(overrides = {}) {
  return {
    schemaVersion: 1,
    architectureStyle: "clean-architecture",
    layers: [
      { id: "api", paths: ["src/api/**"], allowedDependencies: ["application"], forbiddenDependencies: [] },
      { id: "application", paths: ["src/application/**"], allowedDependencies: ["domain"], forbiddenDependencies: ["infrastructure"] },
      { id: "domain", paths: ["src/domain/**"], allowedDependencies: [], forbiddenDependencies: ["http-client", "infrastructure"] },
      { id: "infrastructure", paths: ["src/infrastructure/**"], allowedDependencies: ["domain"], forbiddenDependencies: [] },
    ],
    modules: [{ id: "http-client", imports: ["axios", "requests"] }],
    ...overrides,
  };
}

function writeContract(repo, contract = architectureContract()) {
  write(join(repo, ".repo-governance", "architecture-contract.json"), `${JSON.stringify(contract, null, 2)}\n`);
}

test("architecture contract schema and runtime validation keep styles configurable", () => {
  const schema = JSON.parse(readFileSync(new URL("../schemas/architecture-contract.schema.json", import.meta.url), "utf8"));
  assert.equal(schema.$id, "https://github.com/CoaseEdge/repo-governance/schemas/architecture-contract.schema.json");
  const contract = architectureContract({ architectureStyle: "team-defined-style" });
  assert.equal(validateArchitectureContract(contract).architectureStyle, "team-defined-style");
  assert.throws(
    () => validateArchitectureContract(architectureContract({ layers: [
      { id: "domain", paths: ["src/**"], allowedDependencies: ["missing"], forbiddenDependencies: [] },
    ], modules: [] })),
    (error) => error.code === "RG_ARCHITECTURE_CONTRACT" && /unknown dependency/.test(error.message),
  );
});

test("scanner extracts supported JavaScript, TypeScript, and Python imports without matching comments or strings", () => {
  const javascript = scanSource("src/example.ts", `
    // require("ignored-comment")
    const text = 'import "ignored-string"';
    import service from "./service.js";
    const database = require("./database.cjs");
    const lazy = import("./lazy.ts");
    const unknown = import(target);
  `);
  assert.deepEqual(javascript.imports.map((entry) => [entry.syntax, entry.specifier]), [
    ["require", "./database.cjs"],
    ["dynamic-import", "./lazy.ts"],
    ["import", "./service.js"],
  ]);
  assert.ok(javascript.skipped.some((entry) => entry.reason === "non-literal-dynamic-import"));

  const python = scanSource("service.py", "import requests.sessions\nfrom .domain.payment import Payment\n");
  assert.deepEqual(python.imports.map((entry) => entry.specifier), [".domain.payment", "requests.sessions"]);
  assert.equal(scanSource("service.rb", "require 'net/http'").status, "skipped");
});

test("RG007 accepts controller to service and rejects domain to infrastructure", () => {
  const repo = initGitRepo();
  write(join(repo, "src", "api", "controller.js"), 'import service from "../application/service.js";\n');
  write(join(repo, "src", "application", "service.js"), "export default {};\n");
  write(join(repo, "src", "domain", "payment.js"), 'import database from "../infrastructure/database.js";\n');
  write(join(repo, "src", "infrastructure", "database.js"), "export default {};\n");

  const passing = evaluateRg007(repo, architectureContract(), ["src/api/controller.js"]);
  assert.deepEqual(passing.findings, []);
  const failing = evaluateRg007(repo, architectureContract(), ["src/domain/payment.js"]);
  assert.equal(failing.findings.length, 1);
  assert.equal(failing.findings[0].code, "forbidden-dependency");
  assert.equal(failing.findings[0].severity, "error");
  assert.equal(failing.findings[0].file, "src/domain/payment.js");
});

test("RG007 rejects explicitly mapped HTTP clients without guessing unmapped packages", () => {
  const repo = initGitRepo();
  write(join(repo, "src", "domain", "payment.js"), 'import axios from "axios/client";\nimport mystery from "mystery-http";\n');
  const result = evaluateRg007(repo, architectureContract(), ["src/domain/payment.js"]);
  assert.equal(result.findings.length, 1);
  assert.equal(result.findings[0].target.module, "http-client");
  assert.ok(result.architectureGraph.nodes.some((node) => node.id === "module:external:mystery-http"));
});

test("file and explicit module cycles are deterministic non-blocking warnings", () => {
  const repo = initGitRepo();
  write(join(repo, "src", "a", "a.js"), 'import b from "../b/b.js";\nexport default b;\n');
  write(join(repo, "src", "b", "b.js"), 'import a from "../a/a.js";\nexport default a;\n');
  const contract = architectureContract({
    layers: [{ id: "core", paths: ["src/**"], allowedDependencies: ["a", "b"], forbiddenDependencies: [] }],
    modules: [
      { id: "a", paths: ["src/a/**"] },
      { id: "b", paths: ["src/b/**"] },
    ],
  });
  const first = evaluateRg007(repo, contract, ["src/a/a.js", "src/b/b.js"]);
  const second = evaluateRg007(repo, contract, ["src/b/b.js", "src/a/a.js"]);
  assert.deepEqual(first, second);
  assert.deepEqual(first.findings.map((finding) => [finding.cycle.scope, finding.severity]), [["file", "warning"], ["module", "warning"]]);
  assert.deepEqual(first.architectureGraph.cycles.map((cycle) => cycle.scope), ["file", "module"]);
});

test("check remains compatible without a contract and warnings do not block", () => {
  const repo = initGitRepo();
  writeConfig(repo, baseConfig());
  write(join(repo, "README.md"), "# Baseline\n");
  const base = commitAll(repo, "baseline");
  git(repo, ["switch", "-c", "feature"]);
  write(join(repo, "README.md"), "# Feature\n");
  commitAll(repo, "feature");
  const skipped = checkRepository(repo, { base });
  assert.deepEqual(skipped.architectureFindings, []);
  assert.equal(skipped.architectureGraph.status, "skipped");
  assert.equal(skipped.executionContractVerified, true);

  git(repo, ["switch", "main"]);
  writeContract(repo, architectureContract({
    layers: [{ id: "core", paths: ["src/**"], allowedDependencies: [], forbiddenDependencies: [] }],
    modules: [],
  }));
  write(join(repo, "src", "a.js"), 'import b from "./b.js";\nexport default b;\n');
  write(join(repo, "src", "b.js"), "export default {};\n");
  const cycleBase = commitAll(repo, "architecture baseline");
  git(repo, ["switch", "-c", "cycle"]);
  write(join(repo, "src", "b.js"), 'import a from "./a.js";\nexport default a;\n');
  commitAll(repo, "add cycle");
  const warning = checkRepository(repo, { base: cycleBase });
  assert.equal(warning.ok, true);
  assert.equal(warning.exitCode, 0);
  assert.equal(warning.architectureFindings[0].severity, "warning");
  assert.ok(warning.findings.includes(warning.architectureFindings[0]));
});

test("changed path filtering preserves history while contract changes evaluate the full graph", () => {
  const repo = initGitRepo();
  writeConfig(repo, baseConfig());
  writeContract(repo);
  write(join(repo, "src", "domain", "payment.js"), 'import database from "../infrastructure/database.js";\n');
  write(join(repo, "src", "infrastructure", "database.js"), "export default {};\n");
  write(join(repo, "README.md"), "# Baseline\n");
  const base = commitAll(repo, "historical violation");
  git(repo, ["switch", "-c", "docs"]);
  write(join(repo, "README.md"), "# Documentation only\n");
  commitAll(repo, "docs");
  assert.deepEqual(checkRepository(repo, { base }).architectureFindings, []);

  git(repo, ["switch", "main"]);
  const contractBase = git(repo, ["rev-parse", "HEAD"]).trim();
  git(repo, ["switch", "-c", "contract-change"]);
  const changedContract = architectureContract({ architectureStyle: "ports-and-adapters" });
  writeContract(repo, changedContract);
  commitAll(repo, "change contract");
  const result = checkRepository(repo, { base: contractBase });
  assert.equal(result.ok, false);
  assert.equal(result.architectureFindings[0].severity, "error");
});

test("removing or corrupting the architecture contract fails closed", () => {
  const repo = initGitRepo();
  writeConfig(repo, baseConfig());
  writeContract(repo);
  write(join(repo, "README.md"), "# Baseline\n");
  const base = commitAll(repo, "baseline");
  git(repo, ["switch", "-c", "remove-contract"]);
  git(repo, ["rm", ".repo-governance/architecture-contract.json"]);
  commitAll(repo, "remove contract");
  assert.throws(
    () => checkRepository(repo, { base }),
    (error) => error.code === "RG_ARCHITECTURE_CONTRACT" && /silently disabled/.test(error.message),
  );

  assert.throws(
    () => validateArchitectureContract({ schemaVersion: 1, architectureStyle: "clean", layers: [] }),
    (error) => error.code === "RG_ARCHITECTURE_CONTRACT",
  );
});
