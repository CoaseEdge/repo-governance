import { matchesAny } from "./glob.mjs";

function evidenceForRequirement(changed, requirement, testCategories) {
  const actual = [];
  for (const category of requirement.anyOf) {
    const paths = changed.filter((path) => matchesAny(path, testCategories[category]));
    if (paths.length > 0) actual.push({ category, paths });
  }
  return actual;
}

function executionForRequirement(requirement, executionEvidence) {
  const actual = [];
  for (const category of requirement.anyOf) {
    const testEntries = [...new Set(executionEvidence
      .filter((evidence) => evidence.category === category)
      .map((evidence) => evidence.testEntryId))].sort((left, right) => Buffer.from(left).compare(Buffer.from(right)));
    if (testEntries.length > 0) actual.push({ category, testEntries });
  }
  return actual;
}

function messageFor(mode, satisfied) {
  if (mode === "change") {
    return satisfied
      ? "Required companion test category and change evidence are present; semantic coverage is not asserted."
      : "High-impact change is missing a mapped companion test category in this change.";
  }
  if (mode === "execution") {
    return satisfied
      ? "Required test execution evidence is present for the current diff; semantic coverage is not asserted."
      : "High-impact change is missing successful declared test execution evidence for the current diff.";
  }
  return satisfied
    ? "Required companion test change or execution evidence is present; semantic coverage is not asserted."
    : "High-impact change is missing mapped test change or successful declared execution evidence for the current diff.";
}

export function evaluateRg001(config, changed, executionEvidence = []) {
  const findings = [];
  const satisfied = [];
  for (const mapping of config.highImpactMappings) {
    const businessPaths = changed.filter((path) => matchesAny(path, mapping.businessPaths));
    if (businessPaths.length === 0) continue;
    for (const requirement of mapping.requirements) {
      const mode = requirement.evidenceMode || "change";
      const changeEvidence = evidenceForRequirement(changed, requirement, config.testCategories);
      const executed = executionForRequirement(requirement, executionEvidence);
      const actualEvidence = mode === "change" ? changeEvidence : mode === "execution" ? executed : [...changeEvidence, ...executed];
      const isSatisfied = mode === "change" ? changeEvidence.length > 0 : mode === "execution" ? executed.length > 0 : actualEvidence.length > 0;
      const result = {
        rule: "RG001",
        businessPaths,
        requiredTestCategories: requirement.anyOf,
        actualEvidence,
        message: messageFor(mode, isSatisfied),
        semanticCoverageVerified: false,
        waivable: true,
      };
      if (requirement.evidenceMode !== undefined) result.evidenceMode = mode;
      (isSatisfied ? satisfied : findings).push(result);
    }
  }
  return { findings, satisfied };
}
