import assert from "node:assert/strict";
import { join } from "node:path";
import test from "node:test";
import { checkRepository } from "../src/check.mjs";
import { resolveEngineeringProfile } from "../src/engineering-profile.mjs";
import { TASK_CONTRACT_FILE } from "../src/task-contract.mjs";
import { baseConfig, commitAll, initGitRepo, write, writeConfig } from "./helpers.mjs";

const riskZones = [
  { id: "auth", paths: ["src/auth/**"], minimumProfile: "high" },
  { id: "payments", paths: ["src/payments/**"], minimumProfile: "critical" },
  { id: "identity", paths: ["src/auth/**"], minimumProfile: "high" },
];

function contract(schemaVersion = 2) {
  const value = {
    schemaVersion,
    taskId: "profile-test",
    objective: "Resolve the required engineering profile",
    allowedPaths: ["src/**"],
    forbiddenPaths: [],
    allowedChangeCategories: ["source"],
    budget: { maxFiles: 4 },
  };
  if (schemaVersion === 2) value.engineeringProfile = "small";
  return value;
}

test("effective profile stays requested when no explicit risk zone matches", () => {
  assert.deepEqual(resolveEngineeringProfile(contract(), { riskZones }, ["src/login/button.mjs"]), {
    requested: "small",
    effective: "small",
    raisedBy: [],
  });
});

test("effective profile uses the highest touched risk zone with stable reasons", () => {
  assert.deepEqual(resolveEngineeringProfile(contract(), { riskZones }, ["src/auth/token.mjs"]), {
    requested: "small",
    effective: "high",
    raisedBy: ["riskZone:auth", "riskZone:identity"],
  });
  assert.deepEqual(resolveEngineeringProfile(contract(), { riskZones }, ["src/auth/token.mjs", "src/payments/charge.mjs"]), {
    requested: "small",
    effective: "critical",
    raisedBy: ["riskZone:payments"],
  });
  assert.equal(resolveEngineeringProfile(contract(1), { riskZones }, ["src/payments/charge.mjs"]), null);
});

test("repository checks expose deterministic profile elevation for version 2 only", () => {
  const repo = initGitRepo();
  writeConfig(repo, baseConfig({ riskZones }));
  write(join(repo, TASK_CONTRACT_FILE), `${JSON.stringify(contract(), null, 2)}\n`);
  write(join(repo, "src/auth/token.mjs"), "baseline\n");
  const base = commitAll(repo, "baseline");
  write(join(repo, "src/auth/token.mjs"), "changed\n");
  commitAll(repo, "auth change");

  assert.deepEqual(checkRepository(repo, { base }).engineeringProfile, {
    requested: "small",
    effective: "high",
    raisedBy: ["riskZone:auth", "riskZone:identity"],
  });

  write(join(repo, TASK_CONTRACT_FILE), `${JSON.stringify(contract(1), null, 2)}\n`);
  commitAll(repo, "use version 1 contract");
  assert.equal(Object.hasOwn(checkRepository(repo, { base }), "engineeringProfile"), false);
});
