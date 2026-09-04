import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { buildCommandGraph, reachableCommands } from "./command-graph.mjs";
import { readConfig } from "./config.mjs";
import { canonicalJson } from "./execution-contract.mjs";
import { GovernanceError } from "./errors.mjs";
import { diffFingerprint } from "./fingerprint.mjs";
import { resolveCanonicalBase } from "./git.mjs";
import { run, runGit } from "./process.mjs";
import { commandDefinitionHash } from "./rg004.mjs";

const RECEIPT_VERSION = 1;

function fail(message, details = {}) {
  throw new GovernanceError(message, { code: "RG_TEST_EVIDENCE", details });
}

function compare(left, right) {
  return Buffer.from(left).compare(Buffer.from(right));
}

export function testEvidencePath(repo) {
  const value = runGit(["rev-parse", "--git-path", "repo-governance/test-evidence.json"], { cwd: repo }).stdout.trim();
  return isAbsolute(value) ? value : resolve(repo, value);
}

function readReceipts(repo) {
  const path = testEvidencePath(repo);
  if (!existsSync(path)) return [];
  let value;
  try {
    value = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    fail(`Unable to read local test evidence: ${error.message}`, { path });
  }
  if (value?.schemaVersion !== RECEIPT_VERSION || !Array.isArray(value.receipts) || value.receipts.some((receipt) => (
    !receipt
      || receipt.result !== "pass"
      || !/^[0-9a-f]{64}$/.test(receipt.diffFingerprint || "")
      || typeof receipt.commandIdentity?.testEntryId !== "string"
  ))) {
    fail("Local test evidence has an unsupported format.", { path });
  }
  return value.receipts;
}

function commandIdentity(config, entry) {
  if (entry?.type !== "command" || typeof entry.node !== "string" || !Array.isArray(entry.categories)) return null;
  const separator = entry.node.lastIndexOf("#");
  if (separator <= 0 || separator === entry.node.length - 1) return null;
  const manifest = entry.node.slice(0, separator);
  const command = entry.node.slice(separator + 1);
  const publicCommands = (config.publicCommands || []).filter((candidate) => candidate.manifest === manifest && candidate.command === command);
  if (publicCommands.length !== 1) return null;
  const publicCommand = publicCommands[0];
  return {
    testEntryId: entry.id,
    testCommand: entry.command,
    node: entry.node,
    categories: [...entry.categories].sort(compare),
    publicCommand: {
      id: publicCommand.id,
      manifest: publicCommand.manifest,
      command: publicCommand.command,
      definitionHash: publicCommand.definitionHash,
      tier: publicCommand.tier,
    },
  };
}

function receiptMatches(receipt, fingerprint, identity) {
  return receipt?.result === "pass"
    && receipt.diffFingerprint === fingerprint
    && canonicalJson(receipt.commandIdentity) === canonicalJson(identity);
}

export function loadTestExecutionEvidence(repo, config, canonicalBaseSha, headSha) {
  const fingerprint = diffFingerprint(repo, canonicalBaseSha, headSha);
  const entries = new Map((config.testEntries || []).map((entry) => [entry.id, entry]));
  const evidence = [];
  for (const receipt of readReceipts(repo)) {
    const identity = commandIdentity(config, entries.get(receipt?.commandIdentity?.testEntryId));
    if (!identity || !receiptMatches(receipt, fingerprint, identity)) continue;
    for (const category of identity.categories) evidence.push({ category, testEntryId: identity.testEntryId });
  }
  return evidence.sort((left, right) => compare(`${left.category}\0${left.testEntryId}`, `${right.category}\0${right.testEntryId}`));
}

export function executionEvidenceForProfile(repo, config, profile) {
  const publicCommand = (config.publicCommands || []).find((command) => command.id === profile.entry.publicCommand);
  if (!publicCommand) return [];
  const root = `${publicCommand.manifest}#${publicCommand.command}`;
  const reachable = reachableCommands(buildCommandGraph(repo, config), [root]);
  return (config.testEntries || [])
    .filter((entry) => entry.type === "command" && reachable.has(entry.id))
    .flatMap((entry) => (entry.categories || []).map((category) => ({ category, testEntryId: entry.id })))
    .sort((left, right) => compare(`${left.category}\0${left.testEntryId}`, `${right.category}\0${right.testEntryId}`));
}

function assertClean(repo, phase) {
  const status = runGit(["status", "--porcelain=v1", "--untracked-files=all"], { cwd: repo }).stdout.trim();
  if (status) fail(`Test execution requires a clean worktree ${phase}.`, { status });
}

function resolveExecution(config, repo, entry) {
  const identity = commandIdentity(config, entry);
  if (!identity) fail(`Test entry ${entry?.id || "<unknown>"} is not bound to one declared public command.`, { testEntryId: entry?.id });
  const manifestPath = join(repo, identity.publicCommand.manifest);
  let manifest;
  try {
    manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  } catch (error) {
    fail(`Unable to read declared command manifest: ${error.message}`, { manifest: identity.publicCommand.manifest });
  }
  const definition = manifest.scripts?.[identity.publicCommand.command];
  if (typeof definition !== "string" || commandDefinitionHash(definition) !== identity.publicCommand.definitionHash) {
    fail("Declared public command definition does not match the current manifest.", { publicCommand: identity.publicCommand.id });
  }
  const graph = buildCommandGraph(repo, config);
  if (!reachableCommands(graph, [entry.node]).has(entry.id)) {
    fail(`Declared public command does not reach test entry ${entry.id}.`, { testEntryId: entry.id, node: entry.node });
  }
  const managerNames = [...new Set((config.executionProfiles || [])
    .filter((profile) => profile.tier === identity.publicCommand.tier)
    .map((profile) => config.runtimes.find((runtime) => runtime.id === profile.runtimeId)?.packageManager?.name)
    .filter(Boolean))];
  if (managerNames.length !== 1 || !["npm", "pnpm", "bun"].includes(managerNames[0])) {
    fail("Test evidence requires one declared npm, pnpm, or bun runtime for the public command tier.", { tier: identity.publicCommand.tier });
  }
  return { identity, argv: [managerNames[0], "run", identity.publicCommand.command], cwd: dirname(manifestPath) };
}

function writeReceipt(repo, receipt) {
  const path = testEvidencePath(repo);
  const receipts = readReceipts(repo)
    .filter((candidate) => candidate.diffFingerprint === receipt.diffFingerprint)
    .filter((candidate) => canonicalJson(candidate.commandIdentity) !== canonicalJson(receipt.commandIdentity));
  receipts.push(receipt);
  receipts.sort((left, right) => compare(left.commandIdentity.testEntryId, right.commandIdentity.testEntryId));
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify({ schemaVersion: RECEIPT_VERSION, receipts }, null, 2)}\n`, { mode: 0o600 });
  return path;
}

export function verifyTestEntry(repo, { entryId, base, env = process.env, execute = run } = {}) {
  const config = readConfig(repo);
  const entry = (config.testEntries || []).find((candidate) => candidate.id === entryId);
  if (!entry) fail(`Unknown test entry: ${entryId}.`, { entryId });
  const endpoints = resolveCanonicalBase(repo, base || config.defaultBranch, "HEAD");
  const fingerprint = diffFingerprint(repo, endpoints.canonicalBaseSha, endpoints.headSha);
  const execution = resolveExecution(config, repo, entry);
  assertClean(repo, "before using or running the declared command");
  const existing = readReceipts(repo).find((receipt) => receiptMatches(receipt, fingerprint, execution.identity));
  if (existing) {
    return {
      schemaVersion: 1,
      command: "verify-test",
      testEntryId: entry.id,
      categories: execution.identity.categories,
      result: "pass",
      diffFingerprint: fingerprint,
      alreadyVerified: true,
    };
  }

  const result = execute(execution.argv[0], execution.argv.slice(1), { cwd: execution.cwd, env, errorCode: "RG_TEST_EVIDENCE" });
  if (result?.status !== 0) fail("Declared test command did not report a successful result.", { status: result?.status });
  assertClean(repo, "after running the declared command");
  const finalEndpoints = resolveCanonicalBase(repo, base || config.defaultBranch, "HEAD");
  const finalFingerprint = diffFingerprint(repo, finalEndpoints.canonicalBaseSha, finalEndpoints.headSha);
  if (canonicalJson(finalEndpoints) !== canonicalJson(endpoints) || finalFingerprint !== fingerprint) {
    fail("Repository revision or diff changed during test execution.", { before: endpoints, after: finalEndpoints });
  }
  writeReceipt(repo, {
    diffFingerprint: fingerprint,
    commandIdentity: execution.identity,
    result: "pass",
  });
  return {
    schemaVersion: 1,
    command: "verify-test",
    testEntryId: entry.id,
    categories: execution.identity.categories,
    result: "pass",
    diffFingerprint: fingerprint,
    alreadyVerified: false,
  };
}

export function hasExecutionEvidenceRequirements(config) {
  return (config.highImpactMappings || []).some((mapping) => mapping.requirements.some(
    (requirement) => requirement.evidenceMode === "execution" || requirement.evidenceMode === "either",
  ));
}
