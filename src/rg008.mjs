import { matchesAny } from "./glob.mjs";
import { evaluateScopeBudget } from "./scope-budget.mjs";
import { TASK_CONTRACT_FILE, validateTaskContract } from "./task-contract.mjs";

function compare(left, right) {
  return Buffer.from(left).compare(Buffer.from(right));
}

function pathFinding(type, path, message, severity) {
  return {
    rule: "RG008",
    type,
    path,
    message,
    severity,
    waivable: false,
  };
}

export function evaluateRg008(repo, taskContract, changedPaths = []) {
  if (!taskContract) return { findings: [] };
  const contract = validateTaskContract(taskContract);
  const paths = [...new Set(changedPaths.filter((path) => path !== TASK_CONTRACT_FILE))].sort(compare);
  const findings = [];

  for (const path of paths) {
    if (matchesAny(path, contract.forbiddenPaths)) {
      findings.push(pathFinding("FORBIDDEN_PATH", path, "File matches a forbidden task path.", "error"));
    } else if (!matchesAny(path, contract.allowedPaths)) {
      findings.push(pathFinding("OUT_OF_SCOPE_CHANGE", path, "File is outside declared task scope.", "warning"));
    }
  }

  findings.push(...evaluateScopeBudget(contract, paths).findings);

  return { findings };
}
