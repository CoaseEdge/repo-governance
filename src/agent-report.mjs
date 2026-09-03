const RULES = ["RG001", "RG002", "RG003", "RG004", "RG005"];

function findingsFor(checkResult, rule) {
  return (checkResult.findings || []).filter((finding) => finding.rule === rule);
}

function ruleStatus(checkResult, rule, findings) {
  if (findings.length > 0) return "fail";
  if (rule === "RG001") return (checkResult.satisfied || []).length > 0 ? "pass" : "not-applicable";
  if (rule === "RG005") return checkResult.endpoints ? "pass" : "not-applicable";
  return "pass";
}

function requiredTests(checkResult) {
  const missing = findingsFor(checkResult, "RG001").map((finding) => ({ ...finding, status: "missing", semanticCoverageVerified: false }));
  const satisfied = (checkResult.satisfied || []).filter((finding) => finding.rule === "RG001").map((finding) => ({ ...finding, status: "satisfied", semanticCoverageVerified: false }));
  return [...missing, ...satisfied];
}

function markdown(report) {
  const lines = [
    "## Repository governance",
    "",
    `- Status: ${report.summary.status}`,
    `- Changed paths: ${report.summary.changedPathCount}`,
    `- Findings: ${report.summary.findingCount}`,
    "",
    "## Rule findings",
    "",
  ];
  for (const rule of RULES) {
    lines.push(`- ${rule}: ${report.ruleFindings[rule].status}`);
    for (const finding of report.ruleFindings[rule].findings) lines.push(`  - ${finding.message}`);
  }
  lines.push("", "## Required test evidence", "");
  if (report.requiredTests.length === 0) lines.push("- No mapped RG001 test evidence was required for this diff.");
  else for (const item of report.requiredTests) lines.push(`- ${item.status}: ${(item.requiredTestCategories || []).join(" or ")} for ${(item.businessPaths || []).join(", ")}`);
  lines.push(
    "",
    "> Companion-category evidence does not prove assertion quality, semantic coverage, or business correctness.",
    "",
    "## Checklist",
    "",
    "- [ ] Review governance findings and accepted waivers.",
    "- [ ] Run the declared PR-blocking tests.",
    "- [ ] Confirm test assertions cover the changed behavior.",
  );
  return `${lines.join("\n")}\n`;
}

export function projectAgentReport(checkResult, { repoPath, baseRef } = {}) {
  const governanceDecision = checkResult.governanceDecision || (checkResult.ok ? "satisfied" : "blocked");
  const ready = governanceDecision === "satisfied";
  const ruleFindings = Object.fromEntries(RULES.map((rule) => {
    const findings = findingsFor(checkResult, rule);
    const value = { status: ruleStatus(checkResult, rule, findings), findings };
    if (rule === "RG001") value.satisfied = (checkResult.satisfied || []).filter((entry) => entry.rule === "RG001");
    if (rule === "RG005") value.endpoints = checkResult.endpoints;
    return [rule, value];
  }));
  const report = {
    schemaVersion: 1,
    command: "prepare-pr",
    ok: checkResult.ok,
    status: ready ? "succeeded" : "needs_attention",
    exitCode: checkResult.exitCode,
    repoPath,
    summary: {
      status: ready ? "ready" : governanceDecision,
      base: baseRef,
      head: checkResult.endpoints?.headSha,
      changedPathCount: (checkResult.changedPaths || []).length,
      findingCount: (checkResult.findings || []).length,
      capabilityBoundary: checkResult.capabilityBoundary,
    },
    ruleFindings,
    requiredTests: requiredTests(checkResult),
    workflowFindings: findingsFor(checkResult, "RG003"),
    commandContractFindings: findingsFor(checkResult, "RG004"),
    verificationAdvice: checkResult.verificationAdvice,
    governanceDecision,
    stopAdvice: checkResult.stopAdvice,
    sourceCheckResult: checkResult,
    nextActions: ready
      ? []
      : governanceDecision === "needs-confirmation"
        ? [{ id: "confirm-scope", severity: "warning", message: "Confirm the reported scope expansion before opening the pull request." }]
        : [{ id: "resolve-governance-findings", severity: "error", message: "Resolve the structured governance findings before opening the pull request.", command: `repo-governance check --base ${baseRef} --head HEAD --json` }],
  };
  report.suggestedPRBody = markdown(report);
  report.message = checkResult.ok ? "PR preparation completed without deterministic governance findings." : "PR preparation found governance issues.";
  return report;
}

export function projectCheckFailure(error, { repoPath, baseRef }) {
  const sourceCheckResult = {
    schemaVersion: 1,
    ok: false,
    exitCode: error.exitCode || 2,
    error: { code: error.code || "RG_INTERNAL", message: error.message, details: error.details || {} },
  };
  const ruleFindings = Object.fromEntries(RULES.map((rule) => [rule, { status: rule === "RG005" ? "error" : "not-evaluated", findings: [] }]));
  ruleFindings.RG005.error = sourceCheckResult.error;
  return {
    schemaVersion: 1,
    command: "prepare-pr",
    ok: false,
    status: "blocked",
    exitCode: sourceCheckResult.exitCode,
    repoPath,
    summary: { status: "blocked", base: baseRef, head: null, changedPathCount: 0, findingCount: 0 },
    ruleFindings,
    requiredTests: [],
    workflowFindings: [],
    commandContractFindings: [],
    verificationAdvice: null,
    governanceDecision: "blocked",
    stopAdvice: { action: "resolve-governance-findings" },
    suggestedPRBody: "",
    sourceCheckResult,
    nextActions: [{ id: "repair-git-history", severity: "error", message: "Fetch or repair the canonical target history, then rerun prepare-pr." }],
    error: sourceCheckResult.error,
    message: `${sourceCheckResult.error.code}: ${sourceCheckResult.error.message}`,
  };
}
