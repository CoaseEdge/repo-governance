import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { GovernanceError } from "./errors.mjs";
import { commandDefinitionHash } from "./rg004.mjs";
import { governanceOnlyExecutionContract } from "./execution-contract.mjs";
import nodeLibrary from "../presets/node-library.json" with { type: "json" };
import nodeService from "../presets/node-service.json" with { type: "json" };
import reactWeb from "../presets/react-web.json" with { type: "json" };
import tauriDesktop from "../presets/tauri-desktop.json" with { type: "json" };
import pythonService from "../presets/python-service.json" with { type: "json" };
import presetSchema from "../schemas/preset.schema.json" with { type: "json" };

const BUILT_INS = new Map([
  nodeLibrary,
  nodeService,
  reactWeb,
  tauriDesktop,
  pythonService,
].map((preset) => [preset.name, preset]));

function expect(condition, message, details = {}) {
  if (!condition) throw new GovernanceError(message, { code: "RG_PRESET", details });
}

function validateSelector(selector, ids) {
  expect(selector && typeof selector === "object", "Preset selectors must be objects.");
  expect(typeof selector.id === "string" && selector.id.length > 0, "Preset selector id is required.");
  expect(!ids.has(selector.id), `Duplicate preset selector id: ${selector.id}.`);
  ids.add(selector.id);
  if (selector.type === "file") expect(typeof selector.path === "string" && selector.path.length > 0, `File selector ${selector.id} needs path.`);
  else if (selector.type === "package-script") {
    expect(selector.manifest === "package.json", `Package script selector ${selector.id} must use package.json.`);
    expect(typeof selector.command === "string" && selector.command.length > 0, `Package script selector ${selector.id} needs command.`);
  } else throw new GovernanceError(`Unsupported preset selector type: ${selector.type}.`, { code: "RG_PRESET" });
}

export function validatePreset(preset) {
  for (const key of presetSchema.required) expect(Object.hasOwn(preset || {}, key), `Preset is missing schema-required property: ${key}.`);
  const allowed = new Set(Object.keys(presetSchema.properties));
  for (const key of Object.keys(preset || {})) expect(allowed.has(key), `Preset contains unsupported property: ${key}.`);
  expect(preset?.schemaVersion === 1, "Unsupported preset schemaVersion; expected 1.");
  expect(typeof preset.name === "string" && /^[a-z][a-z0-9-]+$/.test(preset.name), "Preset name is invalid.");
  expect(typeof preset.description === "string" && preset.description.length > 0, `Preset ${preset.name} needs description.`);
  for (const key of ["requiredSelectors", "optionalSelectors", "highImpactMappings", "testEntries", "testSupport", "publicCommandCandidates", "workflowAllowedEntryTemplates"]) {
    expect(Array.isArray(preset[key]), `Preset ${preset.name} needs ${key}.`);
  }
  expect(preset.testCategories && typeof preset.testCategories === "object", `Preset ${preset.name} needs testCategories.`);
  if (preset.changeCategoryMappings !== undefined) {
    expect(preset.changeCategoryMappings && typeof preset.changeCategoryMappings === "object" && !Array.isArray(preset.changeCategoryMappings), `Preset ${preset.name} changeCategoryMappings must be an object.`);
    for (const [category, patterns] of Object.entries(preset.changeCategoryMappings)) {
      expect(/^[a-z][a-z0-9-]*$/.test(category), `Preset ${preset.name} has invalid change category ${category}.`);
      expect(
        Array.isArray(patterns)
          && patterns.length > 0
          && patterns.every((pattern) => typeof pattern === "string" && pattern.length > 0)
          && new Set(patterns).size === patterns.length,
        `Preset ${preset.name} has invalid paths for change category ${category}.`,
      );
    }
  }
  expect(preset.testTiers && ["pr-blocking", "nightly", "manual-smoke"].every((tier) => Array.isArray(preset.testTiers[tier])), `Preset ${preset.name} needs all test tiers.`);
  expect(preset.commandAliases && typeof preset.commandAliases === "object", `Preset ${preset.name} needs commandAliases.`);
  expect(preset.hookStrategy === "connect-effective-pre-push", `Preset ${preset.name} has unsupported hookStrategy.`);
  expect(preset.ciCaller?.provider === "github-actions" && preset.ciCaller.commentReporter === false, `Preset ${preset.name} has unsupported ciCaller.`);
  const selectorIds = new Set();
  for (const selector of [...preset.requiredSelectors, ...preset.optionalSelectors]) validateSelector(selector, selectorIds);
  for (const candidate of preset.publicCommandCandidates) {
    expect(selectorIds.has(candidate.selector), `Public command ${candidate.id} references unknown selector ${candidate.selector}.`);
    expect(["pr-blocking", "nightly", "manual-smoke"].includes(candidate.tier), `Public command ${candidate.id} has invalid tier.`);
    for (const kind of ["contractTests", "docs", "workflows"]) expect(Array.isArray(candidate.consumers?.[kind]) && candidate.consumers[kind].length > 0, `Public command ${candidate.id} needs ${kind}.`);
  }
  for (const template of preset.workflowAllowedEntryTemplates) {
    expect(typeof template === "string" && !/\{(?!engineCommitSha\})/.test(template), `Preset ${preset.name} uses an unsupported workflow placeholder.`);
  }
  return preset;
}

export function listPresets() {
  return [...BUILT_INS.keys()].sort();
}

export function loadPreset(name) {
  const preset = BUILT_INS.get(name);
  if (!preset) throw new GovernanceError(`Unknown preset: ${name}.`, { code: "RG_PRESET", details: { available: listPresets() } });
  validatePreset(preset);
  const source = JSON.stringify(preset);
  return {
    preset: structuredClone(preset),
    identity: { name: preset.name, schemaVersion: preset.schemaVersion, sha256: createHash("sha256").update(source).digest("hex") },
  };
}

function selectorMatches(repo, selector) {
  if (selector.type === "file") return existsSync(join(repo, selector.path));
  const manifestPath = join(repo, selector.manifest);
  if (!existsSync(manifestPath)) return false;
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  return typeof manifest.scripts?.[selector.command] === "string";
}

export function materializePreset(repo, loaded, { engineCommitSha }) {
  const { preset, identity } = loaded;
  const matched = new Set();
  const missingRequired = [];
  const missingOptional = [];
  for (const selector of preset.requiredSelectors) {
    if (selectorMatches(repo, selector)) matched.add(selector.id);
    else missingRequired.push(selector.id);
  }
  if (missingRequired.length > 0) throw new GovernanceError("Repository does not satisfy required preset selectors.", { code: "RG_PRESET_MISMATCH", details: { preset: preset.name, missingRequired } });
  for (const selector of preset.optionalSelectors) {
    if (selectorMatches(repo, selector)) matched.add(selector.id);
    else missingOptional.push(selector.id);
  }
  const publicCommands = preset.publicCommandCandidates
    .filter((candidate) => !candidate.advisory && matched.has(candidate.selector))
    .map((candidate) => {
      const manifest = JSON.parse(readFileSync(join(repo, candidate.manifest), "utf8"));
      return {
        id: candidate.id,
        manifest: candidate.manifest,
        command: candidate.command,
        definitionHash: commandDefinitionHash(manifest.scripts[candidate.command]),
        semantics: candidate.semantics,
        tier: candidate.tier,
        consumers: candidate.consumers,
      };
    });
  return {
    identity,
    config: {
      preset: identity,
      executionContractVersion: 1,
      governanceCompleteness: "complete",
      ...governanceOnlyExecutionContract(),
      testCategories: preset.testCategories,
      changeCategoryMappings: preset.changeCategoryMappings || {},
      highImpactMappings: preset.highImpactMappings,
      testEntries: preset.testEntries,
      testSupport: preset.testSupport,
      testTiers: preset.testTiers,
      commandAliases: preset.commandAliases,
      publicCommands,
      prBlockingCommands: [],
      guards: [],
      policyChecks: [],
      workflowAllowedEntries: preset.workflowAllowedEntryTemplates.map((entry) => entry.replaceAll("{engineCommitSha}", engineCommitSha)),
      waiverApprovers: [],
    },
    matchedSelectors: [...matched].sort(),
    missingOptional,
    advisoryCandidates: preset.publicCommandCandidates.filter((candidate) => candidate.advisory && matched.has(candidate.selector)).map((candidate) => ({ id: candidate.id, command: candidate.command })),
  };
}
