import { matchesAny } from "./glob.mjs";
import { TASK_CONTRACT_FILE, validateTaskContract } from "./task-contract.mjs";

const WEIGHTS = {
  outOfScopeFile: 5,
  subsystem: 10,
  sharedFile: 5,
  ciReleaseFile: 10,
  migrationOutsideTask: 15,
};

function compare(left, right) {
  return Buffer.from(left).compare(Buffer.from(right));
}

function severity(score) {
  if (score === 0) return "none";
  if (score < 15) return "low";
  if (score < 30) return "medium";
  return "high";
}

function neutralResult() {
  return { taskDriftScore: 0, severity: "none", reasons: [] };
}

export function evaluateTaskDrift(taskContract, changedPaths = []) {
  if (!taskContract) return neutralResult();
  const contract = validateTaskContract(taskContract);
  const paths = [...new Set(changedPaths.filter((path) => path !== TASK_CONTRACT_FILE))].sort(compare);
  const outsideAllowed = paths.filter((path) => !matchesAny(path, contract.allowedPaths));
  const outOfScopePaths = outsideAllowed.filter((path) => !matchesAny(path, contract.forbiddenPaths));
  const subsystemIds = contract.drift.subsystems
    .filter((subsystem) => outsideAllowed.some((path) => matchesAny(path, subsystem.paths)))
    .map((subsystem) => subsystem.id);
  const sharedPaths = paths.filter((path) => matchesAny(path, contract.drift.sharedPaths));
  const ciReleasePaths = paths.filter((path) => matchesAny(path, contract.drift.ciReleasePaths));
  const migrationPaths = outsideAllowed.filter((path) => matchesAny(path, contract.migrationPaths));

  const reasons = [
    ...outOfScopePaths.map((path) => `Changed out-of-scope file: ${path}.`),
    ...subsystemIds.map((id) => `Touched new subsystem: ${id}.`),
    ...sharedPaths.map((path) => `Modified shared module file: ${path}.`),
    ...ciReleasePaths.map((path) => `Modified CI/release file: ${path}.`),
    ...migrationPaths.map((path) => `Changed migration outside task scope: ${path}.`),
  ];
  const taskDriftScore = (outOfScopePaths.length * WEIGHTS.outOfScopeFile)
    + (subsystemIds.length * WEIGHTS.subsystem)
    + (sharedPaths.length * WEIGHTS.sharedFile)
    + (ciReleasePaths.length * WEIGHTS.ciReleaseFile)
    + (migrationPaths.length * WEIGHTS.migrationOutsideTask);

  return { taskDriftScore, severity: severity(taskDriftScore), reasons };
}
