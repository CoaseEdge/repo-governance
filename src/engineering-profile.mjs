import { matchesAny } from "./glob.mjs";

export const ENGINEERING_PROFILES = ["small", "standard", "high", "critical"];
export const DEFAULT_VERIFICATION_POLICY = {
  small: "targeted",
  standard: "targeted-plus-related",
  high: "broad",
  critical: "full",
};

export function resolveEngineeringProfile(taskContract, config, changedPaths) {
  if (taskContract?.schemaVersion !== 2) return null;

  const requested = taskContract.engineeringProfile;
  const requestedIndex = ENGINEERING_PROFILES.indexOf(requested);
  const touched = (config.riskZones || []).filter((zone) => matchesAnyChangedPath(changedPaths, zone.paths));
  const highestIndex = touched.reduce(
    (highest, zone) => Math.max(highest, ENGINEERING_PROFILES.indexOf(zone.minimumProfile)),
    requestedIndex,
  );
  const effective = ENGINEERING_PROFILES[highestIndex];
  const raisedBy = highestIndex > requestedIndex
    ? touched
      .filter((zone) => ENGINEERING_PROFILES.indexOf(zone.minimumProfile) === highestIndex)
      .map((zone) => `riskZone:${zone.id}`)
      .sort((left, right) => Buffer.from(left).compare(Buffer.from(right)))
    : [];

  return { requested, effective, raisedBy };
}

function matchesAnyChangedPath(changedPaths, patterns) {
  return changedPaths.some((path) => matchesAny(path, patterns));
}

export function resolveVerificationAdvice(engineeringProfile, config) {
  if (!engineeringProfile) return null;
  const profile = engineeringProfile.effective;
  const requiredLevel = config.engineeringProfiles?.[profile]?.verification || DEFAULT_VERIFICATION_POLICY[profile];
  return {
    profile,
    requiredLevel,
    fullSuiteRequired: requiredLevel === "full",
  };
}
