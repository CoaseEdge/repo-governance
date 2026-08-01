import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import test from "node:test";
import { parse } from "yaml";
import { thinWorkflow } from "../src/workflow.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));

test("workflows never use pull_request_target and pin every external Action to a full SHA", () => {
  for (const name of readdirSync(join(root, ".github", "workflows"))) {
    const contents = readFileSync(join(root, ".github", "workflows", name), "utf8");
    assert.doesNotMatch(contents, /pull_request_target/);
    for (const match of contents.matchAll(/^\s*uses:\s*([^\s]+)\s*$/gm)) {
      const uses = match[1];
      if (uses.startsWith("./")) continue;
      const revision = uses.split("@").at(-1);
      assert.match(revision, /^[0-9a-f]{40}$/, `${name} contains floating Action/reusable workflow reference: ${uses}`);
    }
  }
});

test("reusable workflow fetches full history and separates comment permissions", () => {
  const contents = readFileSync(join(root, ".github", "workflows", "governance.yml"), "utf8");
  const workflow = parse(contents);
  assert.equal(workflow.jobs.governance.permissions.contents, "read");
  assert.equal(workflow.jobs.governance.permissions["pull-requests"], "read");
  assert.equal(workflow.jobs.governance.steps[0].with["fetch-depth"], 0);
  assert.match(contents, /job\.workflow_repository/);
  assert.match(contents, /job\.workflow_sha/);
  assert.doesNotMatch(contents, /github\.job_workflow_sha/);
});

test("comment reporter is a separate write-capable reusable that never checks out PR code", () => {
  const reporter = parse(readFileSync(join(root, ".github", "workflows", "reporter.yml"), "utf8"));
  assert.equal(reporter.jobs.reporter.permissions["pull-requests"], "write");
  assert.equal(reporter.jobs.reporter.steps.some((step) => String(step.uses || "").startsWith("actions/checkout@")), false);
  const caller = thinWorkflow({ engineVersion: "1.0.0", engineCommitSha: "a".repeat(40), comment: true });
  assert.match(caller, /reporter\.yml@[0-9a-f]{40}/);
  assert.match(caller, /pull-requests: write/);
});

test("central CI keeps release checks separate from the protected PR workflow", () => {
  const central = parse(readFileSync(join(root, ".github", "workflows", "ci.yml"), "utf8"));
  const governance = parse(readFileSync(join(root, ".github", "workflows", "repo-governance.yml"), "utf8"));
  assert.equal(central.jobs.governance, undefined);
  assert.ok(central.jobs.test);
  assert.ok(Object.hasOwn(governance.on, "pull_request"));
});

test("protected workflow and package release match the locked engine identity", () => {
  const config = JSON.parse(readFileSync(join(root, ".repo-governance.json"), "utf8"));
  const packageJson = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  const contents = readFileSync(join(root, ".github", "workflows", "repo-governance.yml"), "utf8");
  const workflow = parse(contents);
  const actionRef = `CoaseEdge/repo-governance/action@${config.engineCommitSha}`;
  assert.equal(config.engineVersion, packageJson.version);
  assert.equal(packageJson.scripts["ci:pr"], "npm run build:sea && npm run check");
  assert.equal(contents, thinWorkflow({ engineVersion: config.engineVersion, engineCommitSha: config.engineCommitSha }));
  assert.equal(workflow.jobs.validate.steps.at(-1).uses, actionRef);
  assert.equal(workflow.jobs.validate.steps.at(-1).with["engine-commit-sha"], config.engineCommitSha);
  assert.ok(config.workflowAllowedEntries.includes(`uses:${actionRef}`));
});

test("thin caller pins reusable workflow to the same full engine commit", () => {
  const sha = "a".repeat(40);
  const contents = thinWorkflow({ engineVersion: "1.0.0", engineCommitSha: sha });
  assert.match(contents, new RegExp(`repo-governance/action@${sha}`));
  assert.match(contents, /clean: true/);
  assert.match(contents, /github\.event\.pull_request\.head\.sha/);
  assert.match(contents, new RegExp(`engine-commit-sha: ${sha}`));
  assert.match(contents, /pull_request:/);
  assert.equal(thinWorkflow({ engineVersion: "dev", engineCommitSha: "development" }), null);
});

test("composite Action delegates the complete profile and keeps its report outside the checkout during verification", () => {
  const contents = readFileSync(join(root, "action", "action.yml"), "utf8");
  const packageJson = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  assert.match(contents, /verify-execution/);
  assert.match(contents, /--profile "\$\{\{ inputs\.profile \}\}"/);
  assert.match(contents, /--event-file "\$\{\{ inputs\.event-file \}\}"/);
  assert.equal(packageJson.dependencies.npm, packageJson.packageManager.split("@").at(-1));
  assert.match(contents, /PATH="\$GITHUB_ACTION_PATH\/\.\.\/node_modules\/\.bin:\$PATH"/);
  assert.match(contents, /mktemp "\$RUNNER_TEMP\//);
  assert.match(contents, /> "\$REPORT_TMP"/);
  assert.match(contents, /mv "\$REPORT_TMP" "\$RG_REPORT"/);
});

test("release requires both checksum metadata and GitHub artifact attestation", () => {
  const contents = readFileSync(join(root, ".github", "workflows", "release.yml"), "utf8");
  const workflow = parse(contents);
  const steps = workflow.jobs.build.steps;
  const indexWriter = readFileSync(join(root, "scripts", "write-release-index.mjs"), "utf8");
  const sourceChecker = readFileSync(join(root, "scripts", "check-sources.mjs"), "utf8");
  const seaBuilder = readFileSync(join(root, "scripts", "build-sea.mjs"), "utf8");
  const releasePackager = readFileSync(join(root, "scripts", "package-release.mjs"), "utf8");
  const catalogWriter = readFileSync(join(root, "scripts", "write-release-catalog.mjs"), "utf8");
  const catalogVerifier = readFileSync(join(root, "scripts", "verify-release-catalog.mjs"), "utf8");
  const catalogRuntime = readFileSync(join(root, "src", "release-catalog.mjs"), "utf8");
  assert.match(releasePackager, /policyAssetsSha256/);
  assert.match(releasePackager, /"policy-assets", "presets"/);
  assert.match(releasePackager, /"policy-assets", "schemas"/);
  assert.match(releasePackager, /agentAssetsSha256/);
  assert.match(releasePackager, /adaptersSource: join\(root, "adapters"\)/);
  assert.doesNotMatch(releasePackager, /\.repo-governance-agent\.json|AGENT_POLICY_FILE/);
  assert.ok(steps.some((step) => step.name === "Install" && step.run === "npm ci"));
  assert.ok(steps.some((step) => step.name === "Static checks" && step.run === "npm run check:static"));
  assert.ok(steps.some((step) => step.name === "Full tests" && step.if === "runner.os != 'Windows'" && step.run === "npm test"));
  assert.match(contents, /attest-build-provenance@[0-9a-f]{40}/);
  assert.match(contents, /package:release/);
  assert.match(contents, /id: package-version/);
  assert.match(contents, /version="\$\(node -p/);
  assert.match(contents, /echo "version=\$\{version\}" >> "\$GITHUB_OUTPUT"/);
  assert.match(contents, /release\/assets\/\$\{\{ matrix\.platform \}\}\/repo-governance-v\$\{\{ steps\.package-version\.outputs\.version \}\}-/);
  assert.match(contents, /release\/assets\/\$\{\{ matrix\.platform \}\}\/release-manifest\.json/);
  assert.match(contents, /write-release-index\.mjs/);
  assert.match(contents, /npm run catalog:write/);
  assert.match(contents, /secrets\.REPO_GOVERNANCE_CATALOG_PRIVATE_KEY/);
  assert.match(contents, /npm run catalog:verify/);
  assert.match(contents, /release\/final\/\*/);
  assert.doesNotMatch(contents, /gh release create "\$GITHUB_REF_NAME" release\/\*\*/);
  assert.match(indexWriter, /SHA256SUMS/);
  assert.match(sourceChecker, /fileURLToPath\(new URL\("\.\.\/src", import\.meta\.url\)\)/);
  assert.match(seaBuilder, /fileURLToPath\(new URL\("\.\.", import\.meta\.url\)\)/);
  assert.match(seaBuilder, /shell: process\.platform === "win32"/);
  assert.match(seaBuilder, /postjectArgs\.push\("--macho-segment-name", "NODE_SEA"\)/);
  assert.match(seaBuilder, /smokeTestExecutable\(target\.name, executable\)/);
  assert.match(seaBuilder, /\["preflight", "--json"\]/);
  assert.match(seaBuilder, /report\.repoState !== "not_git_repo"/);
  assert.match(releasePackager, /fileURLToPath\(new URL\("\.\.", import\.meta\.url\)\)/);
  assert.match(indexWriter, /fileURLToPath\(new URL\("\.\.", import\.meta\.url\)\)/);
  assert.match(catalogRuntime, /github\.com\/CoaseEdge\/repo-governance\/releases\/latest\/download\/release-catalog\.json/);
  assert.match(catalogRuntime, /CATALOG_PUBLIC_KEY_BASE64/);
  assert.match(catalogRuntime, /release-assets\.githubusercontent\.com/);
  assert.match(catalogRuntime, /1303721975/);
  assert.match(catalogWriter, /REPO_GOVERNANCE_CATALOG_PRIVATE_KEY/);
  assert.match(catalogWriter, /release-metadata\.json/);
  assert.match(catalogVerifier, /verifyReleaseCatalog/);
  for (const script of [sourceChecker, seaBuilder, releasePackager, indexWriter, catalogWriter, catalogVerifier]) {
    assert.doesNotMatch(script, /new URL\([^)]+import\.meta\.url\)\.pathname/);
  }
});

test("v1.3.0 release inputs contain the execution protocol, dynamic Action, and Agent policy assets", () => {
  const packageJson = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  const packageLock = JSON.parse(readFileSync(join(root, "package-lock.json"), "utf8"));
  const buildSea = readFileSync(join(root, "scripts", "build-sea.mjs"), "utf8");
  assert.equal(packageJson.version, "1.3.0");
  assert.equal(packageJson.packageManager, "npm@10.9.2");
  assert.equal(packageLock.version, packageJson.version);
  assert.equal(packageLock.packages[""].version, packageJson.version);
  assert.match(buildSea, /execFileSync\("xattr", \["-c", executable\]\)/);
  assert.match(buildSea, /XDG_DATA_HOME: join\(cwd, "data"\)/);
  assert.match(buildSea, /LOCALAPPDATA: join\(cwd, "data"\)/);

  for (const path of [
    "schemas/agent-policy.schema.json",
    "schemas/architecture-contract.schema.json",
    "schemas/architecture-baseline.schema.json",
    "schemas/architecture-drift-report.schema.json",
    "playbooks/repo-governance-agent-gate.md",
    "adapters/codex/skills/repo-governance-agent-gate/SKILL.md",
    "adapters/codex/hooks/hooks.example.json",
    "adapters/codex/hooks/repo-governance-agent-gate.mjs",
    "adapters/claude-code/commands/repo-governance-agent-gate.md",
    "adapters/claude-code/hooks/settings.example.json",
    "adapters/claude-code/hooks/pre-commit.example",
    "adapters/claude-code/hooks/repo-governance-agent-gate.mjs",
    "action/action.yml",
    "schemas/repo-governance.schema.json",
    "docs/execution-contracts.md",
    "docs/architecture-governance.md",
    "docs/architecture-drift.md",
  ]) assert.equal(readFileSync(join(root, path), "utf8").length > 0, true, `missing release input ${path}`);
});
