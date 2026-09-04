import assert from "node:assert/strict";
import { join } from "node:path";
import test from "node:test";
import { listPresets, loadPreset, materializePreset, validatePreset } from "../src/presets.mjs";
import { commandDefinitionHash } from "../src/rg004.mjs";
import { initGitRepo, write } from "./helpers.mjs";

test("all built-in presets validate and remain explicitly named", () => {
  assert.deepEqual(listPresets(), ["node-library", "node-service", "python-service", "react-web", "tauri-desktop"]);
  for (const name of listPresets()) assert.equal(validatePreset(loadPreset(name).preset).name, name);
});

test("optional package commands materialize exact contracts without inventing missing candidates", () => {
  const repo = initGitRepo();
  write(join(repo, "package.json"), JSON.stringify({ scripts: { test: "node --test" } }));
  const result = materializePreset(repo, loadPreset("node-library"), { engineCommitSha: "a".repeat(40) });
  assert.deepEqual(result.config.publicCommands.map((entry) => entry.id), ["test"]);
  assert.equal(result.config.publicCommands[0].definitionHash, commandDefinitionHash("node --test"));
  assert.ok(result.missingOptional.includes("build-command"));
  assert.ok(result.config.workflowAllowedEntries[0].endsWith(`@${"a".repeat(40)}`));
  assert.equal(result.config.executionContractVersion, 1);
  assert.equal(result.config.governanceCompleteness, "complete");
  assert.equal(result.config.executionProfiles[0].consumers.some((consumer) => consumer.type === "pre-push"), true);
  assert.equal(result.config.executionProfiles[0].consumers.some((consumer) => consumer.type === "github-actions"), true);
  assert.deepEqual(result.config.changeCategoryMappings, loadPreset("node-library").preset.changeCategoryMappings);
});

test("required selectors fail before configuration materialization", () => {
  const loaded = loadPreset("node-library");
  loaded.preset.requiredSelectors.push({ id: "required-file", type: "file", path: "required.txt" });
  const repo = initGitRepo();
  assert.throws(() => materializePreset(repo, loaded, { engineCommitSha: "a".repeat(40) }), /required preset selectors/);
});

test("Python command candidates stay advisory instead of creating unverifiable RG004 contracts", () => {
  const repo = initGitRepo();
  write(join(repo, "pyproject.toml"), "[project]\nname = \"fixture\"\n");
  const result = materializePreset(repo, loadPreset("python-service"), { engineCommitSha: "a".repeat(40) });
  assert.deepEqual(result.config.publicCommands, []);
  assert.deepEqual(result.advisoryCandidates.map((entry) => entry.id), ["pytest", "python-static", "python-build"]);
});
