import assert from "node:assert/strict";
import { join } from "node:path";
import test from "node:test";
import { checkRepository } from "../src/check.mjs";
import { evaluateRg001 } from "../src/rg001.mjs";
import { baseConfig, commitAll, git, initGitRepo, write, writeConfig } from "./helpers.mjs";

function configuredRepo() {
  const repo = initGitRepo();
  writeConfig(repo, baseConfig({
    highImpactMappings: [
      { businessPaths: ["src/api/**"], requirements: [{ anyOf: ["contract", "integration"] }] },
      { businessPaths: ["src/ui/**"], requirements: [{ anyOf: ["frontend"] }] },
      { businessPaths: ["package.json", "scripts/build/**"], requirements: [{ anyOf: ["command-contract"] }, { anyOf: ["build-verification"] }] },
    ],
  }));
  write(join(repo, "README.md"), "base\n");
  commitAll(repo, "base");
  git(repo, ["switch", "-c", "feature"]);
  return repo;
}

test("API change plus unrelated frontend test still fails", () => {
  const repo = configuredRepo();
  write(join(repo, "src/api/result.js"), "export const result = { ok: true };\n");
  write(join(repo, "tests/frontend/button.test.js"), "// unrelated\n");
  commitAll(repo, "api with unrelated test");
  const result = checkRepository(repo, { base: "main" });
  assert.equal(result.ok, false);
  assert.deepEqual(result.findings[0].requiredTestCategories, ["contract", "integration"]);
  assert.equal(result.findings[0].semanticCoverageVerified, false);
  assert.doesNotMatch(result.findings[0].message, /coverage.*verified/i);
});

test("API change plus mapped contract evidence passes without claiming semantic coverage", () => {
  const repo = configuredRepo();
  write(join(repo, "src/api/result.js"), "export const result = { ok: true };\n");
  write(join(repo, "tests/contract/result.test.js"), "// companion evidence\n");
  commitAll(repo, "api with contract test");
  const result = checkRepository(repo, { base: "main" });
  assert.equal(result.ok, true);
  assert.equal(result.satisfied[0].semanticCoverageVerified, false);
  assert.match(result.capabilityBoundary, /does not prove/i);
});

test("UI change requires frontend evidence rather than unit evidence", () => {
  const repo = configuredRepo();
  write(join(repo, "src/ui/button.js"), "export const label = 'Save';\n");
  write(join(repo, "tests/unit/button.test.js"), "// wrong category\n");
  commitAll(repo, "ui with unit test");
  assert.equal(checkRepository(repo, { base: "main" }).ok, false);
  write(join(repo, "tests/frontend/button.test.js"), "// correct category\n");
  commitAll(repo, "add frontend test");
  assert.equal(checkRepository(repo, { base: "main" }).ok, true);
});

test("build command requires command contract and build verification", () => {
  const repo = configuredRepo();
  write(join(repo, "package.json"), "{\"scripts\":{\"build\":\"new-build\"}}\n");
  write(join(repo, "tests/commands/build.test.js"), "// contract only\n");
  commitAll(repo, "build contract only");
  let result = checkRepository(repo, { base: "main" });
  assert.equal(result.ok, false);
  assert.deepEqual(result.findings[0].requiredTestCategories, ["build-verification"]);
  write(join(repo, "tests/build/package.test.js"), "// build verify\n");
  commitAll(repo, "add build verification");
  result = checkRepository(repo, { base: "main" });
  assert.equal(result.ok, true);
});

test("omitted evidenceMode preserves exact change-evidence output", () => {
  const config = baseConfig({
    highImpactMappings: [{ businessPaths: ["src/**"], requirements: [{ anyOf: ["unit"] }] }],
  });
  const result = evaluateRg001(config, ["src/value.js", "tests/unit/value.test.js"], [{ category: "unit", testEntryId: "unit" }]);
  assert.deepEqual(result.satisfied, [{
    rule: "RG001",
    businessPaths: ["src/value.js"],
    requiredTestCategories: ["unit"],
    actualEvidence: [{ category: "unit", paths: ["tests/unit/value.test.js"] }],
    message: "Required companion test category and change evidence are present; semantic coverage is not asserted.",
    semanticCoverageVerified: false,
    waivable: true,
  }]);
});

test("execution and either modes consume only matching current-diff evidence", () => {
  const executionConfig = baseConfig({
    highImpactMappings: [{ businessPaths: ["src/**"], requirements: [{ anyOf: ["unit", "integration"], evidenceMode: "execution" }] }],
  });
  const missing = evaluateRg001(executionConfig, ["src/value.js", "tests/unit/value.test.js"]);
  assert.equal(missing.findings.length, 1);
  const executed = evaluateRg001(executionConfig, ["src/value.js"], [{ category: "unit", testEntryId: "unit-suite" }]);
  assert.deepEqual(executed.satisfied[0].actualEvidence, [{ category: "unit", testEntries: ["unit-suite"] }]);
  assert.equal(executed.satisfied[0].evidenceMode, "execution");

  const eitherConfig = baseConfig({
    highImpactMappings: [{ businessPaths: ["src/**"], requirements: [{ anyOf: ["unit"], evidenceMode: "either" }] }],
  });
  assert.equal(evaluateRg001(eitherConfig, ["src/value.js", "tests/unit/value.test.js"]).satisfied.length, 1);
  assert.equal(evaluateRg001(eitherConfig, ["src/value.js"], [{ category: "unit", testEntryId: "unit-suite" }]).satisfied.length, 1);
});
