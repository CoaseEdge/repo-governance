import { validateTaskContract } from "./task-contract.mjs";

const BUDGET_METRICS = [
  ["maxNewFiles", "newFiles"],
  ["maxAddedLines", "addedLines"],
  ["maxTestFiles", "testFiles"],
  ["maxTestAddedLines", "testAddedLines"],
];

export function evaluateRg009(taskContract, metrics = null) {
  if (!taskContract) return { evaluated: false, findings: [] };
  const contract = validateTaskContract(taskContract);
  if (contract.schemaVersion === 1) return { evaluated: false, findings: [] };

  const findings = [];
  for (const [budget, metric] of BUDGET_METRICS) {
    const limit = contract.budget[budget];
    if (limit !== undefined && metrics[metric] > limit) {
      findings.push({
        rule: "RG009",
        type: "COMPLEXITY_BUDGET_EXCEEDED",
        budget,
        actual: metrics[metric],
        limit,
        severity: "error",
        waivable: false,
      });
    }
  }
  const allowedCategories = new Set(contract.allowedChangeCategories);
  for (const { category, path } of metrics.changeCategories || []) {
    if (!allowedCategories.has(category)) {
      findings.push({
        rule: "RG009",
        type: "UNAUTHORIZED_CHANGE_CATEGORY",
        category,
        path,
        severity: "error",
        waivable: false,
      });
    }
  }
  return { evaluated: true, findings };
}
