import { matchesAny } from "./glob.mjs";
import { TASK_CONTRACT_FILE, validateTaskContract } from "./task-contract.mjs";

function compare(left, right) {
  return Buffer.from(left).compare(Buffer.from(right));
}

function pathFinding(type, path, message) {
  return {
    rule: "RG008",
    type,
    path,
    message,
    severity: "warning",
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
      findings.push(pathFinding("FORBIDDEN_PATH", path, "File matches a forbidden task path."));
    } else if (!matchesAny(path, contract.allowedPaths)) {
      findings.push(pathFinding("OUT_OF_SCOPE_CHANGE", path, "File is outside declared task scope."));
    }
  }

  if (paths.length > contract.budget.maxFiles) {
    findings.push({
      rule: "RG008",
      type: "BUDGET_EXCEEDED",
      message: `Task changed ${paths.length} files, limit is ${contract.budget.maxFiles}.`,
      severity: "warning",
      waivable: false,
      actualFiles: paths.length,
      maxFiles: contract.budget.maxFiles,
    });
  }

  return { findings };
}
