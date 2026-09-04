import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const guide = readFileSync(new URL("../docs/agent-auto-adoption.md", import.meta.url), "utf8");

test("Agent adoption guide contains three complete, valid preflight reports", () => {
  const jsonBlocks = [...guide.matchAll(/```json\n([\s\S]*?)\n```/g)].map((match) => JSON.parse(match[1]));
  const reports = jsonBlocks.filter((value) => value.command === "preflight");
  assert.deepEqual(reports.map((report) => report.repoState), ["unmanaged", "not_git_repo", "misconfigured"]);
  for (const report of reports) {
    for (const field of ["schemaVersion", "command", "cwd", "policy", "nextActions", "ok", "status", "exitCode", "repoPath", "repoState", "inspection", "recommendedAction", "message"]) {
      assert.equal(Object.hasOwn(report, field), true, `${report.repoState} example is missing ${field}`);
    }
  }
  assert.equal(reports[0].ok, true);
  assert.equal(reports[0].status, "needs_attention");
  assert.equal(reports[0].recommendedAction.requiresConfirmation, false);
  assert.equal(reports[2].inspection.hookConnected, false);
  assert.equal(reports[2].error.code, "RG_HOOKS_DISCONNECTED");
});

test("bilingual entry points document the three-layer boundary and unsafe exclusions", () => {
  const chinese = readFileSync(new URL("../README.md", import.meta.url), "utf8");
  const english = readFileSync(new URL("../README.en.md", import.meta.url), "utf8");
  assert.match(chinese, /为什么使用 repo-governance/);
  assert.match(english, /Why repo-governance/);
  for (const contents of [english, chinese]) {
    assert.match(contents, /preflight --json/);
    assert.match(contents, /status/);
    assert.match(contents, /repoState/);
    assert.match(contents, /pre-push/);
    assert.match(contents, /prepare-pr/);
    assert.match(contents, /git clone/);
    assert.match(contents, /git init/);
    assert.match(contents, /github enforce --confirm/);
    assert.match(contents, /ruleset/);
  }
});
