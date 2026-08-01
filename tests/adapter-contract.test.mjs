import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import test from "node:test";

const root = fileURLToPath(new URL("..", import.meta.url));
const codexRoot = join(root, "adapters", "codex");
const claudeRoot = join(root, "adapters", "claude-code");
const fixtures = JSON.parse(readFileSync(join(root, "tests", "fixtures", "agent-reports.json"), "utf8"));

function contract(directory) {
  return JSON.parse(readFileSync(join(directory, "adapter-contract.json"), "utf8"));
}

function neutral(value) {
  const { adapter, ...shared } = value;
  return shared;
}

function hasPath(value, dottedPath) {
  return dottedPath.split(".").every((segment) => {
    if (value === null || typeof value !== "object" || !(segment in value)) return false;
    value = value[segment];
    return true;
  });
}

test("Codex and Claude adapters declare the same structured decision contract", () => {
  const codex = contract(codexRoot);
  const claude = contract(claudeRoot);
  assert.equal(codex.adapter, "codex");
  assert.equal(claude.adapter, "claude-code");
  assert.deepEqual(neutral(codex), neutral(claude));
  assert.equal(codex.schemaVersion, 1);
  assert.equal(codex.reportSchemaVersion, 1);
  for (const playbook of codex.playbooks) {
    assert.ok(playbook.commandTemplates.every((command) => command.endsWith("--json") || command.includes("--json")));
  }
});

test("both adapter declarations consume the same versioned report fixtures", () => {
  for (const adapterRoot of [codexRoot, claudeRoot]) {
    const adapter = contract(adapterRoot);
    for (const playbook of adapter.playbooks) {
      const fixture = fixtures[playbook.fixture];
      assert.ok(fixture, `missing fixture ${playbook.fixture}`);
      assert.equal(fixture.schemaVersion, adapter.reportSchemaVersion);
      for (const field of playbook.consumes) assert.equal(hasPath(fixture, field), true, `${playbook.id} cannot consume ${field}`);
    }
  }
  assert.ok(fixtures["prepare-pr"].requiredTests.every((entry) => entry.semanticCoverageVerified === false));
  assert.equal(fixtures.preflight.ok, true);
  assert.equal(fixtures.preflight.status, "needs_attention");
  assert.equal(fixtures.preflight.repoState, "unmanaged");
});

test("architecture advisors consume the same RG007 and drift report fields", () => {
  const expectedFields = ["architectureFindings", "architectureGraph", "architectureDriftFindings", "architectureDrift"];
  for (const adapterRoot of [codexRoot, claudeRoot]) {
    const playbook = contract(adapterRoot).playbooks.find(({ id }) => id === "architecture-review");
    assert.deepEqual(playbook.commandTemplates, ["repo-governance check --json"]);
    assert.equal(playbook.fixture, "architecture-review");
    assert.deepEqual(playbook.consumes, expectedFields);
  }
  const fixture = fixtures["architecture-review"];
  assert.equal(fixture.schemaVersion, 1);
  assert.equal(fixture.architectureFindings[0].rule, "RG007");
  assert.equal(fixture.architectureFindings[0].target.module, "database");
  assert.equal(fixture.architectureDriftFindings[0].rule, "ARCHITECTURE_DRIFT");
  assert.equal(fixture.architectureDrift.health.after, 86);
});

test("change scope advisors consume the same RG008 and task drift report fields", () => {
  const expectedFields = ["mode", "ok", "exitCode", "scopeFindings", "taskDrift"];
  const expectedLabels = ["blocked", "needs-confirmation", "advisory", "no-scope-signal", "not-evaluated", "incompatible-input"];
  for (const adapterRoot of [codexRoot, claudeRoot]) {
    const playbook = contract(adapterRoot).playbooks.find(({ id }) => id === "change-scope-review");
    assert.deepEqual(playbook.commandTemplates, ["repo-governance check --json"]);
    assert.equal(playbook.fixture, "change-scope-review");
    assert.deepEqual(playbook.consumes, expectedFields);
    assert.deepEqual(playbook.classificationLabels, expectedLabels);
  }
  const fixture = fixtures["change-scope-review"];
  assert.equal(fixture.schemaVersion, 1);
  assert.deepEqual(fixture.scopeFindings.map(({ type }) => type), ["FORBIDDEN_PATH", "OUT_OF_SCOPE_CHANGE", "BUDGET_EXCEEDED"]);
  assert.deepEqual(fixture.scopeFindings.map(({ severity }) => severity), ["error", "warning", "error"]);
  assert.equal(fixture.scopeFindings[2].actualFiles, 4);
  assert.equal(fixture.scopeFindings[2].maxFiles, 3);
  assert.equal(fixture.taskDrift.taskDriftScore, 35);
  assert.equal(fixture.taskDrift.severity, "high");
  assert.equal(fixture.taskDrift.reasons.length, 2);
});

test("Claude prompt templates map one-to-one to canonical Playbooks and contract IDs", () => {
  const claude = contract(claudeRoot);
  for (const playbook of claude.playbooks) {
    const canonical = join(root, "playbooks", `${playbook.id}.md`);
    const command = join(claudeRoot, "commands", `${playbook.id}.md`);
    assert.equal(existsSync(canonical), true);
    assert.equal(existsSync(command), true);
    const contents = readFileSync(command, "utf8");
    assert.ok(contents.includes(`Playbook ID: \`${playbook.id}\``));
    assert.match(contents, new RegExp(`${playbook.id}\\.md`));
  }
});

test("Agent wrappers contain no known governance rule implementation primitives", () => {
  const files = [
    join(claudeRoot, "CLAUDE.md"),
    ...contract(claudeRoot).playbooks.map(({ id }) => join(claudeRoot, "commands", `${id}.md`)),
    ...contract(codexRoot).playbooks.map(({ id }) => join(codexRoot, "skills", id, "SKILL.md")),
  ];
  const combined = files.map((path) => readFileSync(path, "utf8")).join("\n");
  assert.doesNotMatch(combined, /definitionHash|businessPaths|highImpactMappings|workflowAllowedEntries|createHash|globToRegExp/);
  assert.doesNotMatch(combined, /blockingThreshold|allowedDependencies|forbiddenDependencies|stronglyConnectedComponents/);
  assert.doesNotMatch(combined, /allowedPaths|forbiddenPaths|migrationPaths/);
  assert.doesNotMatch(combined, /taskDriftScore\s*[+*\/-]/);
  assert.match(combined, /semanticCoverageVerified: false/);
});
