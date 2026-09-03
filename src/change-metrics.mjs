import { posix } from "node:path";
import { matchesAny } from "./glob.mjs";
import { runGit } from "./process.mjs";
import { TASK_CONTRACT_FILE, validateTaskContract } from "./task-contract.mjs";

function compare(left, right) {
  return Buffer.from(left).compare(Buffer.from(right));
}

function diff(repo, kind, baseSha, headSha) {
  return runGit([
    "-c", "core.quotepath=false",
    "diff", kind, "-z", "--find-renames=100%", baseSha, headSha,
    "--", ".", ":(exclude).repo-governance/waivers/**",
  ], { cwd: repo, binary: true }).stdout.toString("utf8").split("\0");
}

function changedEntries(repo, baseSha, headSha) {
  const fields = diff(repo, "--name-status", baseSha, headSha);
  const entries = [];
  for (let index = 0; fields[index];) {
    const status = fields[index++];
    if (status.startsWith("R")) index += 1;
    entries.push({ status, path: fields[index++] });
  }
  return entries.filter((entry) => entry.path && entry.path !== TASK_CONTRACT_FILE);
}

function lineEntries(repo, baseSha, headSha) {
  const fields = diff(repo, "--numstat", baseSha, headSha);
  const entries = new Map();
  for (let index = 0; fields[index];) {
    const field = fields[index++];
    const [added, deleted, ...pathParts] = field.split("\t");
    const inlinePath = pathParts.join("\t");
    if (!inlinePath) index += 1;
    const path = inlinePath || fields[index++];
    entries.set(path, {
      added: added === "-" ? 0 : Number.parseInt(added, 10),
      deleted: deleted === "-" ? 0 : Number.parseInt(deleted, 10),
    });
  }
  return entries;
}

export function collectChangeMetrics(repo, config, taskContract, baseSha, headSha) {
  const contract = validateTaskContract(taskContract);
  const entries = changedEntries(repo, baseSha, headSha).sort((left, right) => compare(left.path, right.path));
  const linesByPath = lineEntries(repo, baseSha, headSha);
  const paths = entries.map((entry) => entry.path);
  const testPatterns = [
    ...Object.values(config.testCategories).flat(),
    ...(config.testSupport || []),
  ];
  const testPaths = paths.filter((path) => matchesAny(path, testPatterns));
  const addedLines = paths.reduce((total, path) => total + (linesByPath.get(path)?.added || 0), 0);
  const deletedLines = paths.reduce((total, path) => total + (linesByPath.get(path)?.deleted || 0), 0);

  return {
    changedFiles: paths.length,
    newFiles: entries.filter((entry) => entry.status === "A").length,
    directories: new Set(paths.map((path) => posix.dirname(path))).size,
    addedLines,
    deletedLines,
    testFiles: testPaths.length,
    testAddedLines: testPaths.reduce((total, path) => total + (linesByPath.get(path)?.added || 0), 0),
    migrationFiles: paths.filter((path) => matchesAny(path, contract.migrationPaths)).length,
    outOfScopeFiles: paths.filter(
      (path) => !matchesAny(path, contract.forbiddenPaths) && !matchesAny(path, contract.allowedPaths),
    ).length,
  };
}
