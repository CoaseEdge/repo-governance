import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import test from "node:test";
import { parse } from "yaml";
import { stageCodexSkills } from "../src/agent-assets.mjs";
import { temporaryDirectory } from "./helpers.mjs";

const root = fileURLToPath(new URL("../adapters/codex/skills", import.meta.url));
const playbooks = fileURLToPath(new URL("../playbooks", import.meta.url));
const expected = [
  "architecture-review",
  "bootstrap-repo-governance",
  "change-scope-review",
  "classify-test-tier",
  "plan-change-test-impact",
  "protect-public-commands",
  "repo-governance-agent-gate",
  "triage-ci-failure",
];

function frontmatter(contents) {
  const match = contents.match(/^---\n([\s\S]*?)\n---\n/);
  assert.ok(match, "SKILL.md must begin with YAML frontmatter");
  return parse(match[1]);
}

test("all planned Skills have valid metadata and no scaffold placeholders", () => {
  assert.deepEqual(readdirSync(root).sort(), expected);
  for (const name of expected) {
    const contents = readFileSync(join(root, name, "SKILL.md"), "utf8");
    const metadata = frontmatter(contents);
    assert.equal(metadata.name, name);
    assert.ok(metadata.description.length > 80);
    assert.doesNotMatch(contents, /\bTODO\b|Structuring This Skill/);
    const agent = parse(readFileSync(join(root, name, "agents/openai.yaml"), "utf8"));
    assert.match(agent.interface.default_prompt, new RegExp(`\\$${name}`));
    assert.ok(agent.interface.short_description.length >= 25 && agent.interface.short_description.length <= 64);
  }
});

test("failure triage fixtures cover four classes and insufficient evidence", () => {
  const fixtures = readFileSync(join(playbooks, "triage-ci-failure.md"), "utf8");
  for (const classification of ["true-bug", "stale-test", "stale-workflow", "wrong-ci-tier", "insufficient-evidence"]) {
    assert.match(fixtures, new RegExp(`\\b${classification}\\b`));
  }
  const skill = readFileSync(join(root, "triage-ci-failure", "SKILL.md"), "utf8");
  assert.match(skill, /stop before modifying code/);
});

test("Skills delegate hard decisions to CLI structured output", () => {
  const combined = expected.map((name) => readFileSync(join(root, name, "SKILL.md"), "utf8")).join("\n");
  assert.match(combined, /repo-governance check --json/);
  assert.match(combined, /prepare-pr --json/);
  assert.match(combined, /preflight --json/);
  assert.doesNotMatch(combined, /definitionHash|businessPaths|createHash|globToRegExp/);
  for (const name of expected) assert.ok(readFileSync(join(playbooks, `${name}.md`), "utf8").length > 200);
});

test("architecture review explains one deterministic report without implementing decisions", () => {
  const skill = readFileSync(join(root, "architecture-review", "SKILL.md"), "utf8");
  const playbook = readFileSync(join(playbooks, "architecture-review.md"), "utf8");
  assert.match(skill, /repo-governance check --json/);
  for (const field of ["architectureFindings", "architectureGraph", "architectureDriftFindings", "architectureDrift"]) {
    assert.match(skill, new RegExp(`\\b${field}\\b`));
    assert.match(playbook, new RegExp(`\\b${field}\\b`));
  }
  assert.match(playbook, /skipped[\s\S]+never means the architecture is healthy/);
  assert.match(playbook, /suggestion for review, not a new finding/);
  assert.doesNotMatch(skill, /blockingThreshold|allowedDependencies|forbiddenDependencies|createHash/);
});

test("change scope review preserves RG008 evidence and pauses at the declared boundaries", () => {
  const skill = readFileSync(join(root, "change-scope-review", "SKILL.md"), "utf8");
  const playbook = readFileSync(join(playbooks, "change-scope-review.md"), "utf8");
  assert.match(skill, /repo-governance check --json/);
  for (const field of ["mode", "ok", "exitCode", "scopeFindings", "taskDrift"]) {
    assert.match(skill, new RegExp(`\\b${field}\\b`));
    assert.match(playbook, new RegExp(`\\b${field}\\b`));
  }
  for (const classification of ["blocked", "needs-confirmation", "advisory", "no-scope-signal", "not-evaluated", "incompatible-input"]) {
    assert.match(playbook, new RegExp(`\\b${classification}\\b`));
  }
  const precedence = ["incompatible-input", "not-evaluated", "blocked", "needs-confirmation", "advisory", "no-scope-signal"];
  assert.deepEqual(precedence.map((classification) => playbook.indexOf(`\`${classification}\``)), precedence.map((classification) => playbook.indexOf(`\`${classification}\``)).toSorted((a, b) => a - b));
  assert.match(playbook, /Pause repository modifications and ask the user/);
  assert.match(playbook, /does not prove that a Task Contract exists/);
  assert.doesNotMatch(`${skill}\n${playbook}`, /allowedPaths|forbiddenPaths|migrationPaths|globToRegExp/);
});

test("release staging materializes the canonical playbook as each Skill reference", () => {
  const destination = temporaryDirectory("repo-governance-staged-skills-");
  stageCodexSkills({ skillsSource: root, playbooksSource: playbooks, destination });
  for (const name of expected) {
    const reference = join(destination, name, "references", "playbook.md");
    assert.equal(existsSync(reference), true);
    assert.equal(readFileSync(reference, "utf8"), readFileSync(join(playbooks, `${name}.md`), "utf8"));
  }
});
