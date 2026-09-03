import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { GovernanceError } from "./errors.mjs";
import { DIFF_FINGERPRINT_ALGORITHM } from "./fingerprint.mjs";
import { runtimeIdentity } from "./version.mjs";

export const CONFIG_FILE = ".repo-governance.json";
const ENGINEERING_PROFILES = ["small", "standard", "high", "critical"];
const VERIFICATION_LEVELS = ["targeted", "targeted-plus-related", "broad", "full"];

function expect(condition, message, details = {}) {
  if (!condition) {
    throw new GovernanceError(message, { code: "RG_CONFIG", details });
  }
}

export function validateConfig(config, { identity = runtimeIdentity(), enforceEngine = true } = {}) {
  expect(config && typeof config === "object" && !Array.isArray(config), "Governance configuration must be an object.");
  expect(config.schemaVersion === 1, "Unsupported schemaVersion; expected 1.");
  expect(config.executionContractVersion === 1, "executionContractVersion must be 1.");
  expect(config.governanceCompleteness === "complete", "governanceCompleteness must be complete.");
  expect(config.runtime === undefined, "Top-level runtime is forbidden; use the runtimes registry.");
  expect(Array.isArray(config.runtimes) && config.runtimes.length > 0, "runtimes must be a non-empty registry.");
  expect(Array.isArray(config.executionProfiles) && config.executionProfiles.length > 0, "executionProfiles must be a non-empty array.");
  expect(typeof config.engineVersion === "string" && config.engineVersion.length > 0, "engineVersion is required.");
  expect(typeof config.engineCommitSha === "string" && config.engineCommitSha.length > 0, "engineCommitSha is required.");
  expect(config.engineCommitSha === "development" || /^[0-9a-f]{40}$/.test(config.engineCommitSha), "engineCommitSha must be development or a full 40-character commit SHA.");
  expect(config.diffFingerprintAlgorithm === DIFF_FINGERPRINT_ALGORITHM, `diffFingerprintAlgorithm must be ${DIFF_FINGERPRINT_ALGORITHM}.`);
  expect(typeof config.defaultBranch === "string" && config.defaultBranch.length > 0, "defaultBranch is required.");
  if (config.preset !== undefined) {
    expect(config.preset && typeof config.preset === "object", "preset must be an object.");
    expect(typeof config.preset.name === "string" && config.preset.name.length > 0, "preset.name is required.");
    expect(config.preset.schemaVersion === 1, "preset.schemaVersion must be 1.");
    expect(/^[0-9a-f]{64}$/.test(config.preset.sha256 || ""), "preset.sha256 must be a lowercase SHA-256 digest.");
  }
  expect(config.testCategories && typeof config.testCategories === "object", "testCategories is required.");
  if (config.changeCategoryMappings !== undefined) {
    expect(config.changeCategoryMappings && typeof config.changeCategoryMappings === "object" && !Array.isArray(config.changeCategoryMappings), "changeCategoryMappings must be an object.");
    for (const [category, patterns] of Object.entries(config.changeCategoryMappings)) {
      expect(/^[a-z][a-z0-9-]*$/.test(category), `Invalid change category: ${category}.`);
      expect(
        Array.isArray(patterns)
          && patterns.length > 0
          && patterns.every((pattern) => typeof pattern === "string" && pattern.length > 0)
          && new Set(patterns).size === patterns.length,
        `Invalid paths for change category ${category}.`,
      );
    }
  }
  if (config.engineeringProfiles !== undefined) {
    expect(config.engineeringProfiles && typeof config.engineeringProfiles === "object" && !Array.isArray(config.engineeringProfiles), "engineeringProfiles must be an object.");
    expect(Object.keys(config.engineeringProfiles).length === ENGINEERING_PROFILES.length, "engineeringProfiles must declare small, standard, high, and critical.");
    for (const profile of ENGINEERING_PROFILES) {
      const policy = config.engineeringProfiles[profile];
      expect(policy && typeof policy === "object" && !Array.isArray(policy), `engineeringProfiles.${profile} is required.`);
      expect(Object.keys(policy).length === 1 && VERIFICATION_LEVELS.includes(policy.verification), `engineeringProfiles.${profile}.verification is invalid.`);
    }
  }
  if (config.riskZones !== undefined) {
    expect(Array.isArray(config.riskZones), "riskZones must be an array.");
    const riskZoneIds = new Set();
    for (const zone of config.riskZones) {
      expect(zone && typeof zone === "object" && !Array.isArray(zone), "Each risk zone must be an object.");
      expect(Object.keys(zone).every((key) => ["id", "paths", "minimumProfile"].includes(key)), `Risk zone ${zone.id || "<unknown>"} contains unsupported fields.`);
      expect(typeof zone.id === "string" && /^[a-z][a-z0-9-]*$/.test(zone.id) && !riskZoneIds.has(zone.id), `Invalid or duplicate risk zone id: ${zone.id}.`);
      riskZoneIds.add(zone.id);
      expect(Array.isArray(zone.paths) && zone.paths.length > 0 && zone.paths.every((path) => typeof path === "string" && path.length > 0) && new Set(zone.paths).size === zone.paths.length, `Risk zone ${zone.id} needs unique paths.`);
      expect(ENGINEERING_PROFILES.includes(zone.minimumProfile), `Risk zone ${zone.id} has an invalid minimumProfile.`);
    }
  }
  expect(Array.isArray(config.highImpactMappings), "highImpactMappings must be an array.");
  expect(config.testEntries === undefined || Array.isArray(config.testEntries), "testEntries must be an array of executable entries.");
  expect(config.testSupport === undefined || Array.isArray(config.testSupport), "testSupport must be an array of fixture/helper patterns.");
  if (config.testTiers !== undefined) {
    expect(config.testTiers && typeof config.testTiers === "object", "testTiers must be an object.");
    for (const tier of ["pr-blocking", "nightly", "manual-smoke"]) expect(Array.isArray(config.testTiers[tier]), `testTiers.${tier} must be an array.`);
  }
  expect(config.guards === undefined || Array.isArray(config.guards), "guards must be an array.");
  expect(config.policyChecks === undefined || Array.isArray(config.policyChecks), "policyChecks must be an array.");
  expect(config.workflowAllowedEntries === undefined || Array.isArray(config.workflowAllowedEntries), "workflowAllowedEntries must be an array.");
  expect(config.publicCommands === undefined || Array.isArray(config.publicCommands), "publicCommands must be an array.");
  expect(config.prBlockingCommands === undefined || Array.isArray(config.prBlockingCommands), "prBlockingCommands must be an array.");
  for (const runtime of config.runtimes) {
    expect(runtime && typeof runtime === "object" && typeof runtime.id === "string" && runtime.id.length > 0, "Each runtime needs an id.");
    expect(Array.isArray(runtime.systemTools), `Runtime ${runtime.id} needs a systemTools allowlist.`);
    for (const tool of runtime.systemTools) {
      if (tool.platforms !== undefined) {
        expect(
          Array.isArray(tool.platforms)
            && tool.platforms.length > 0
            && tool.platforms.every((platform) => ["darwin", "linux", "win32"].includes(platform))
            && new Set(tool.platforms).size === tool.platforms.length,
          `Runtime ${runtime.id} tool ${tool.name} has invalid platforms.`,
        );
      }
    }
    if (runtime.node !== undefined) expect(typeof runtime.node.version === "string" && runtime.node.version.length > 0, `Runtime ${runtime.id} needs node.version.`);
    if (runtime.python !== undefined) expect(typeof runtime.python.version === "string" && runtime.python.version.length > 0, `Runtime ${runtime.id} needs python.version.`);
    if (runtime.packageManager !== undefined) {
      expect(typeof runtime.packageManager.name === "string" && runtime.packageManager.name.length > 0, `Runtime ${runtime.id} needs packageManager.name.`);
      expect(/^\d+\.\d+\.\d+$/.test(runtime.packageManager.version || ""), `Runtime ${runtime.id} packageManager.version must be exact.`);
    }
  }
  for (const profile of config.executionProfiles) {
    expect(profile && typeof profile === "object" && typeof profile.id === "string" && profile.id.length > 0, "Each execution profile needs an id.");
    expect(profile.runtime === undefined, `Execution profile ${profile.id} must use runtimeId instead of an embedded runtime.`);
    expect(typeof profile.runtimeId === "string" && profile.runtimeId.length > 0, `Execution profile ${profile.id} needs runtimeId.`);
    expect(["pr-blocking", "nightly", "manual-smoke"].includes(profile.tier), `Execution profile ${profile.id} has an invalid tier.`);
    expect(profile.entry && typeof profile.entry.publicCommand === "string" && profile.entry.publicCommand.length > 0, `Execution profile ${profile.id} needs entry.publicCommand.`);
    expect(Array.isArray(profile.entry.argv) && profile.entry.argv.length > 0, `Execution profile ${profile.id} needs entry.argv.`);
    expect(Array.isArray(profile.requiredStages) && profile.requiredStages.length > 0, `Execution profile ${profile.id} needs requiredStages.`);
    for (const stage of profile.requiredStages) {
      expect(typeof stage.id === "string" && Array.isArray(stage.commands) && stage.commands.length > 0, `Execution profile ${profile.id} has an invalid stage.`);
    }
    const preparation = profile.dependencyPreparation;
    expect(preparation && typeof preparation === "object", `Execution profile ${profile.id} needs dependencyPreparation.`);
    for (const field of ["id", "definitionHash", "semantics", "adapter", "workingDirectory"]) expect(typeof preparation[field] === "string" && preparation[field].length > 0, `Execution profile ${profile.id} dependencyPreparation needs ${field}.`);
    expect(/^[0-9a-f]{64}$/.test(preparation.definitionHash), `Execution profile ${profile.id} dependencyPreparation needs a lowercase SHA-256 definitionHash.`);
    expect(preparation.env && typeof preparation.env === "object" && !Array.isArray(preparation.env), `Execution profile ${profile.id} dependencyPreparation.env must be an object.`);
    expect(["forbid", "allow"].includes(preparation.lifecycleScripts?.mode), `Execution profile ${profile.id} has an invalid lifecycleScripts mode.`);
    expect(Array.isArray(preparation.lifecycleScripts.allowlist), `Execution profile ${profile.id} lifecycleScripts.allowlist must be an array.`);
    for (const dependency of preparation.lifecycleScripts.allowlist) {
      expect(typeof dependency.package === "string" && dependency.package.length > 0, `Execution profile ${profile.id} lifecycle allowlist needs package.`);
      expect(/^\d+\.\d+\.\d+$/.test(dependency.version || ""), `Execution profile ${profile.id} lifecycle allowlist needs an exact version.`);
      expect(typeof dependency.integrity === "string" && dependency.integrity.length > 0, `Execution profile ${profile.id} lifecycle allowlist needs integrity.`);
      expect(Array.isArray(dependency.stages) && dependency.stages.length > 0, `Execution profile ${profile.id} lifecycle allowlist needs stages.`);
    }
    expect(Array.isArray(preparation.hookArgv) && Array.isArray(preparation.ciArgv), `Execution profile ${profile.id} dependency preparation needs hookArgv and ciArgv.`);
    for (const kind of ["contractTests", "docs", "workflows"]) expect(Array.isArray(preparation.consumers?.[kind]) && preparation.consumers[kind].length > 0, `Execution profile ${profile.id} dependency preparation needs ${kind} consumers.`);
    expect(Array.isArray(profile.consumers), `Execution profile ${profile.id} needs consumers.`);
    for (const consumer of profile.consumers) {
      expect(["pre-push", "github-actions"].includes(consumer.type), `Execution profile ${profile.id} has an unsupported consumer type.`);
      if (consumer.type === "pre-push") expect(consumer.revisionSource === "pushed-ref-tip", `Execution profile ${profile.id} pre-push consumer must use pushed-ref-tip.`);
      else {
        for (const field of ["workflow", "job", "verificationStep", "trigger", "revisionSource"]) expect(typeof consumer[field] === "string" && consumer[field].length > 0, `Execution profile ${profile.id} GitHub consumer needs ${field}.`);
        expect(["pull-request-head", "pull-request-merge", "push-event-sha"].includes(consumer.revisionSource), `Execution profile ${profile.id} has an invalid workflow revisionSource.`);
        expect(consumer.executionContext && typeof consumer.executionContext === "object", `Execution profile ${profile.id} GitHub consumer needs executionContext.`);
        for (const field of ["workingDirectory", "shell", "continueOnError", "stepIf", "jobIf", "defaultsRun", "matrix", "needs", "env", "runner", "container", "timeoutMinutes"]) {
          expect(Object.hasOwn(consumer.executionContext, field), `Execution profile ${profile.id} executionContext must explicitly declare ${field}.`);
        }
      }
    }
  }
  for (const command of config.publicCommands || []) {
    expect(typeof command.id === "string" && typeof command.manifest === "string" && typeof command.command === "string", "Each public command needs id, manifest, and command.");
    expect(/^[0-9a-f]{64}$/.test(command.definitionHash || ""), `Public command ${command.id} needs a lowercase SHA-256 definitionHash.`);
    expect(typeof command.semantics === "string" && command.semantics.length > 0, `Public command ${command.id} needs semantics.`);
    expect(typeof command.tier === "string" && command.tier.length > 0, `Public command ${command.id} needs a test tier.`);
    for (const kind of ["contractTests", "docs", "workflows"]) expect(Array.isArray(command.consumers?.[kind]) && command.consumers[kind].length > 0, `Public command ${command.id} needs ${kind} consumers.`);
  }

  for (const [category, patterns] of Object.entries(config.testCategories)) {
    expect(Array.isArray(patterns) && patterns.every((item) => typeof item === "string" && item.length > 0), `Invalid paths for test category ${category}.`);
  }
  for (const entry of config.testEntries || []) {
    if (entry.categories !== undefined) {
      expect(
        Array.isArray(entry.categories)
          && entry.categories.length > 0
          && entry.categories.every((category) => Object.hasOwn(config.testCategories, category))
          && new Set(entry.categories).size === entry.categories.length,
        `Test entry ${entry.id} has invalid evidence categories.`,
      );
    }
  }
  for (const mapping of config.highImpactMappings) {
    expect(Array.isArray(mapping.businessPaths) && mapping.businessPaths.length > 0, "Each high-impact mapping needs businessPaths.");
    expect(Array.isArray(mapping.requirements) && mapping.requirements.length > 0, "Each high-impact mapping needs requirements.");
    for (const requirement of mapping.requirements) {
      expect(Array.isArray(requirement.anyOf) && requirement.anyOf.length > 0, "Each mapping requirement needs an anyOf category list.");
      expect(requirement.evidenceMode === undefined || ["change", "execution", "either"].includes(requirement.evidenceMode), "Each mapping requirement has an invalid evidenceMode.");
      for (const category of requirement.anyOf) {
        expect(Object.hasOwn(config.testCategories, category), `Unknown test category in high-impact mapping: ${category}.`);
      }
    }
  }
  if (enforceEngine && identity.commitSha !== "development") {
    expect(
      config.engineVersion === identity.version && config.engineCommitSha === identity.commitSha,
      "Local CLI, hook, and configuration versions differ. Run repo-governance update before checking.",
      { configured: { version: config.engineVersion, commitSha: config.engineCommitSha }, runtime: identity },
    );
  }
  return config;
}

export function readConfig(repo, options) {
  const path = join(repo, CONFIG_FILE);
  let config;
  try {
    config = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    throw new GovernanceError(`Unable to read ${CONFIG_FILE}: ${error.message}`, {
      code: "RG_CONFIG",
      details: {
        path,
        causeCode: error.code || null,
        unreadable: !(error instanceof SyntaxError),
      },
    });
  }
  return validateConfig(config, options);
}

export function writeConfig(repo, config) {
  validateConfig(config, { enforceEngine: false });
  writeFileSync(join(repo, CONFIG_FILE), `${JSON.stringify(config, null, 2)}\n`, { flag: "wx" });
}
