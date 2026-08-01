import { posix } from "node:path";
import { matchesAny } from "./glob.mjs";
import { TASK_CONTRACT_FILE, validateTaskContract } from "./task-contract.mjs";

function compare(left, right) {
  return Buffer.from(left).compare(Buffer.from(right));
}

function budgetFinding(budget, message, details) {
  return {
    rule: "RG008",
    type: "BUDGET_EXCEEDED",
    budget,
    message,
    severity: "error",
    waivable: false,
    ...details,
  };
}

export function evaluateScopeBudget(taskContract, changedPaths = []) {
  const contract = validateTaskContract(taskContract);
  const paths = [...new Set(changedPaths.filter((path) => path !== TASK_CONTRACT_FILE))].sort(compare);
  const forbiddenPaths = paths.filter((path) => matchesAny(path, contract.forbiddenPaths));
  const outOfScopePaths = paths.filter((path) => !matchesAny(path, contract.forbiddenPaths) && !matchesAny(path, contract.allowedPaths));
  const migrationPaths = paths.filter((path) => matchesAny(path, contract.migrationPaths));
  const directories = [...new Set(paths.map((path) => posix.dirname(path)))].sort(compare);
  const metrics = {
    files: paths.length,
    directories: directories.length,
    migrations: migrationPaths.length,
    outOfScopeFiles: outOfScopePaths.length,
    forbiddenFiles: forbiddenPaths.length,
  };
  const findings = [];

  if (metrics.files > contract.budget.maxFiles) {
    findings.push(budgetFinding(
      "maxFiles",
      `Task changed ${metrics.files} files, limit is ${contract.budget.maxFiles}.`,
      { actualFiles: metrics.files, maxFiles: contract.budget.maxFiles },
    ));
  }
  if (contract.budget.maxDirectories !== undefined && metrics.directories > contract.budget.maxDirectories) {
    findings.push(budgetFinding(
      "maxDirectories",
      `Task touched ${metrics.directories} directories, limit is ${contract.budget.maxDirectories}.`,
      { actualDirectories: metrics.directories, maxDirectories: contract.budget.maxDirectories },
    ));
  }
  if (contract.budget.maxMigrations !== undefined && metrics.migrations > contract.budget.maxMigrations) {
    findings.push(budgetFinding(
      "maxMigrations",
      `Task changed ${metrics.migrations} migration files, limit is ${contract.budget.maxMigrations}.`,
      { actualMigrations: metrics.migrations, maxMigrations: contract.budget.maxMigrations },
    ));
  }
  if (contract.budget.maxOutOfScopeFiles !== undefined && metrics.outOfScopeFiles > contract.budget.maxOutOfScopeFiles) {
    findings.push(budgetFinding(
      "maxOutOfScopeFiles",
      `Task changed ${metrics.outOfScopeFiles} out-of-scope files, limit is ${contract.budget.maxOutOfScopeFiles}.`,
      { actualOutOfScopeFiles: metrics.outOfScopeFiles, maxOutOfScopeFiles: contract.budget.maxOutOfScopeFiles },
    ));
  }

  return { metrics, findings };
}
