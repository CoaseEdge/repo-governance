import { relative } from "node:path";
import { asFailure, GovernanceError } from "./errors.mjs";
import { repositoryRoot, resolveCanonicalBase } from "./git.mjs";
import { checkRepository } from "./check.mjs";
import { initializeRepository } from "./init.mjs";
import { connectEffectiveRepositoryHook, disconnectEffectiveRepositoryHook, doctorHooks, installFutureHooks, uninstallFutureHooks } from "./hooks.mjs";
import { createWaiver } from "./waiver.mjs";
import { controlledUpdate } from "./update.mjs";
import { readConfig } from "./config.mjs";
import { runtimeIdentity } from "./version.mjs";
import { readFileSync } from "node:fs";
import { validateRemoteWaiverApprovals } from "./github/waiver-approval.mjs";
import { githubEnforce } from "./github/enforce.mjs";
import { installReleaseBundle } from "./release-install.mjs";
import { installSkills } from "./skills-install.mjs";
import { bootstrapRepository } from "./bootstrap.mjs";
import { newRepository } from "./new.mjs";
import { cloneRepository } from "./clone.mjs";
import { preparePullRequest } from "./prepare-pr.mjs";
import { preflightRepository } from "./preflight.mjs";
import { listRepositories, registerRepository, unregisterRepository } from "./repositories.mjs";
import { listEngines, pruneEngines } from "./engines.mjs";
import { checkVersion } from "./release-catalog.mjs";
import { verifyCiExecution } from "./verify-execution.mjs";
import { readPrePushStdin, verifyPrePushExecution } from "./pre-push.mjs";
import { createArchitectureBaseline } from "./architecture/baseline.mjs";
import { reportArchitectureDrift } from "./architecture/drift.mjs";

function parse(argv) {
  const positional = [];
  const flags = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith("--")) {
      positional.push(token);
      continue;
    }
    const [key, inline] = token.slice(2).split("=", 2);
    if (inline !== undefined) flags[key] = inline;
    else if (argv[index + 1] && !argv[index + 1].startsWith("--")) flags[key] = argv[++index];
    else flags[key] = true;
  }
  return { positional, flags };
}

function emit(payload, json = false, stream = process.stdout) {
  if (json) stream.write(`${JSON.stringify(payload, null, 2)}\n`);
  else if (typeof payload === "string") stream.write(`${payload}\n`);
  else stream.write(`${payload.message || JSON.stringify(payload, null, 2)}\n`);
}

function help() {
  return `repo-governance commands:
  init [--accept] [--default-branch main] [--json]
  bootstrap --preset <preset> [--default-branch <branch>] [--json]
  new <name> --preset <preset> [--default-branch <branch>] [--json]
  clone <repo> [directory] --preset <preset> [--default-branch <branch>] [--json]
  preflight [--json]
  prepare-pr [--base <ref>] [--json]
  check [--base <ref>] [--head <ref>] [--json]
  architecture baseline [--replace] [--json]
  architecture drift [--json]
  verify-execution --profile <id> --ci --event-file <json> [--json]
  verify-execution --pre-push --remote <name> --remote-url <url> [--json]
  waiver create --name <name> --paths <a,b> --reason <text> --expires <ISO> [--base <ref>]
  hooks install --dispatcher <verified-file> [--compose]
  hooks connect
  hooks doctor
  hooks disconnect
  hooks uninstall
  github validate-waivers --event <json> --reviews <json> --report <json>
  github enforce --owner <owner> --repo <repo> --check <name> [--confirm]
  install --bundle <verified-release-directory-or-archive>
  skills install --source <skills-directory> [--replace]
  update --bundle <verified-directory>
  repositories list [--json]
  repositories register [path] [--json]
  repositories unregister <path> [--json]
  engines list [--json]
  engines prune --dry-run [--json]
  engines prune --confirm [--json]
  version [check] [--json]`;
}

export async function main(argv, context = {}) {
  const cwd = context.cwd || process.cwd();
  const env = context.env || process.env;
  const stdout = context.stdout || process.stdout;
  const stderr = context.stderr || process.stderr;
  const register = context.registerRepository || registerRepository;
  const parsed = parse(argv);
  const [command, subcommand] = parsed.positional;
  const json = Boolean(parsed.flags.json);
  const automationCommand = ["bootstrap", "new", "clone", "preflight", "prepare-pr"].includes(command);
  try {
    if (!command || command === "help" || parsed.flags.help) {
      emit(help(), false, stdout);
      return 0;
    }
    if (command === "version") {
      const identity = context.identity || runtimeIdentity();
      if (subcommand === "check") {
        if (parsed.positional.length !== 2 || Object.keys(parsed.flags).some((flag) => flag !== "json")) throw new GovernanceError("version check accepts only the optional --json flag.", { code: "RG_INVOCATION" });
        const result = await (context.checkVersion || checkVersion)(identity.version, { env });
        emit(result, json, result.ok ? stdout : stderr);
        return result.exitCode;
      }
      if (parsed.positional.length !== 1 || Object.keys(parsed.flags).some((flag) => flag !== "json")) throw new GovernanceError("version accepts only the optional check subcommand and --json flag.", { code: "RG_INVOCATION" });
      emit(json ? identity : `${identity.version} (${identity.commitSha})`, json, stdout);
      return 0;
    }
    if (command === "github" && subcommand === "enforce") {
      const result = await githubEnforce({
        owner: parsed.flags.owner,
        repo: parsed.flags.repo,
        checkName: parsed.flags.check,
        token: env.GITHUB_TOKEN,
        confirm: Boolean(parsed.flags.confirm),
      });
      emit(result, json, result.status === "blocked" ? stderr : stdout);
      return result.status === "blocked" ? 2 : 0;
    }
    if (command === "install") {
      if (!parsed.flags.bundle) throw new GovernanceError("--bundle is required.", { code: "RG_INVOCATION" });
      const result = (context.installReleaseBundle || installReleaseBundle)(parsed.flags.bundle, { env });
      emit(result, json, stdout);
      if (!json && result.actionRequired) emit(`Action required: ${result.actionRequired}`, false, stdout);
      return 0;
    }
    if (command === "skills" && subcommand === "install") {
      if (!parsed.flags.source) throw new GovernanceError("--source is required.", { code: "RG_INVOCATION" });
      emit(installSkills(parsed.flags.source, { env, replace: Boolean(parsed.flags.replace) }), json, stdout);
      return 0;
    }
    if (command === "repositories" && subcommand === "list") {
      emit(listRepositories({ env }), json, stdout);
      return 0;
    }
    if (command === "repositories" && subcommand === "register") {
      emit(registerRepository(parsed.positional[2] || cwd, { env }), json, stdout);
      return 0;
    }
    if (command === "repositories" && subcommand === "unregister") {
      emit(unregisterRepository(parsed.positional[2], { env }), json, stdout);
      return 0;
    }
    if (command === "engines" && subcommand === "list") {
      emit(listEngines({ env }), json, stdout);
      return 0;
    }
    if (command === "engines" && subcommand === "prune") {
      const dryRun = Boolean(parsed.flags["dry-run"]);
      const confirm = Boolean(parsed.flags.confirm);
      if (dryRun === confirm) throw new GovernanceError("engines prune requires exactly one of --dry-run or --confirm.", { code: "RG_INVOCATION" });
      emit(pruneEngines({ env, confirm }), json, stdout);
      return 0;
    }
    if (command === "hooks" && subcommand === "install") {
      const result = installFutureHooks({ compose: Boolean(parsed.flags.compose), env, dispatcherSource: parsed.flags.dispatcher });
      emit(result, json, stdout);
      return 0;
    }
    if (command === "hooks" && subcommand === "uninstall") {
      emit(uninstallFutureHooks({ env }), json, stdout);
      return 0;
    }
    if (command === "new") {
      const result = newRepository(subcommand, {
        cwd,
        presetName: parsed.flags.preset,
        defaultBranch: parsed.flags["default-branch"] || "main",
        env,
        identity: context.identity,
        verifyInstallation: context.verifyInstallation ?? true,
      });
      if (result.ok) result.repositoryRegistration = register(result.repoPath, { env });
      emit(result, json, result.ok ? stdout : stderr);
      return result.exitCode;
    }
    if (command === "clone") {
      const result = cloneRepository(subcommand, parsed.positional[2], {
        cwd,
        presetName: parsed.flags.preset,
        defaultBranch: parsed.flags["default-branch"],
        env,
        identity: context.identity,
        verifyInstallation: context.verifyInstallation ?? true,
      });
      if (result.ok) result.repositoryRegistration = register(result.repoPath, { env });
      emit(result, json, result.ok ? stdout : stderr);
      return result.exitCode;
    }
    if (command === "preflight") {
      const invalidArguments = parsed.positional.length !== 1 || Object.keys(parsed.flags).some((flag) => flag !== "json");
      const invocationError = invalidArguments
        ? new GovernanceError("preflight accepts only the optional --json flag.", { code: "RG_INVOCATION" })
        : null;
      const result = (context.preflightRepository || preflightRepository)(cwd, { env, identity: context.identity, invocationError, catalogPublicKey: context.catalogPublicKey });
      emit(result, json, result.ok ? stdout : stderr);
      if (!json && result.updateAdvisory.shouldWarn) {
        stdout.write(`\u001b[33mUpdate available: ${result.updateAdvisory.currentVersion} is ${result.updateAdvisory.versionsBehind} releases behind ${result.updateAdvisory.latestVersion}${result.updateAdvisory.securityFixAvailable ? " and a security fix is available" : ""}. Run repo-governance version check.\u001b[0m\n`);
      }
      return result.exitCode;
    }
    const repo = repositoryRoot(cwd);
    if (command === "prepare-pr") {
      const result = preparePullRequest(repo, { base: parsed.flags.base, env });
      emit(result, json, result.ok ? stdout : stderr);
      return result.exitCode;
    }
    if (command === "bootstrap") {
      const result = bootstrapRepository(repo, {
        presetName: parsed.flags.preset,
        defaultBranch: parsed.flags["default-branch"],
        env,
        identity: context.identity,
        verifyInstallation: context.verifyInstallation ?? true,
      });
      if (result.ok) result.repositoryRegistration = register(result.repoPath, { env });
      emit(result, json, result.ok ? stdout : stderr);
      return result.exitCode;
    }
    if (command === "github" && subcommand === "validate-waivers") {
      for (const flag of ["event", "reviews", "report"]) if (!parsed.flags[flag]) throw new GovernanceError(`--${flag} is required.`, { code: "RG_INVOCATION" });
      const result = validateRemoteWaiverApprovals({
        event: JSON.parse(readFileSync(parsed.flags.event, "utf8")),
        reviews: JSON.parse(readFileSync(parsed.flags.reviews, "utf8")),
        report: JSON.parse(readFileSync(parsed.flags.report, "utf8")),
        config: readConfig(repo),
      });
      emit(result, json, stdout);
      return 0;
    }
    if (command === "init") {
      const result = initializeRepository(repo, { accept: Boolean(parsed.flags.accept), defaultBranch: parsed.flags["default-branch"] || "main" });
      if (result.written) result.hook = connectEffectiveRepositoryHook(repo, { env });
      emit(result, json, stdout);
      return result.written || !parsed.flags.accept ? 0 : 2;
    }
    if (command === "check") {
      const result = checkRepository(repo, { base: parsed.flags.base, head: parsed.flags.head });
      emit(result, json, result.ok ? stdout : stderr);
      return result.exitCode;
    }
    if (command === "architecture" && subcommand === "baseline") {
      const invalidArguments = parsed.positional.length !== 2 || Object.keys(parsed.flags).some((flag) => !["replace", "json"].includes(flag));
      if (invalidArguments) throw new GovernanceError("architecture baseline accepts only --replace and --json.", { code: "RG_INVOCATION" });
      const result = (context.createArchitectureBaseline || createArchitectureBaseline)(repo, { replace: Boolean(parsed.flags.replace) });
      emit(result, json, stdout);
      return result.exitCode;
    }
    if (command === "architecture" && subcommand === "drift") {
      const invalidArguments = parsed.positional.length !== 2 || Object.keys(parsed.flags).some((flag) => flag !== "json");
      if (invalidArguments) throw new GovernanceError("architecture drift accepts only the optional --json flag.", { code: "RG_INVOCATION" });
      const result = (context.reportArchitectureDrift || reportArchitectureDrift)(repo);
      emit(result, json, result.ok ? stdout : stderr);
      return result.exitCode;
    }
    if (command === "verify-execution") {
      if (parsed.flags["pre-push"]) {
        if (!parsed.flags.remote || !parsed.flags["remote-url"]) {
          throw new GovernanceError("Pre-push verification requires --remote and --remote-url.", { code: "RG_INVOCATION" });
        }
        const result = (context.verifyPrePushExecution || verifyPrePushExecution)(repo, {
          remote: parsed.flags.remote,
          remoteUrl: parsed.flags["remote-url"],
          input: context.prePushInput ?? readPrePushStdin(),
          env,
        });
        emit(result, json, stdout);
        return 0;
      }
      if (!parsed.flags.profile || !parsed.flags.ci || !parsed.flags["event-file"]) {
        throw new GovernanceError("verify-execution requires --profile, --ci, and --event-file.", { code: "RG_INVOCATION" });
      }
      const result = (context.verifyCiExecution || verifyCiExecution)(repo, {
        profileId: parsed.flags.profile,
        eventFile: parsed.flags["event-file"],
        env,
      });
      emit(result, json, stdout);
      return 0;
    }
    if (command === "hooks" && subcommand === "connect") {
      emit(connectEffectiveRepositoryHook(repo, { env, requireDispatcher: true }), json, stdout);
      return 0;
    }
    if (command === "hooks" && subcommand === "disconnect") {
      emit(disconnectEffectiveRepositoryHook(repo, { env }), json, stdout);
      return 0;
    }
    if (command === "waiver" && subcommand === "create") {
      const required = ["name", "paths", "reason", "expires"];
      for (const flag of required) if (!parsed.flags[flag]) throw new GovernanceError(`--${flag} is required.`, { code: "RG_INVOCATION" });
      const config = readConfig(repo);
      const endpoints = resolveCanonicalBase(repo, parsed.flags.base || config.defaultBranch, parsed.flags.head || "HEAD");
      const path = createWaiver(repo, {
        name: parsed.flags.name,
        businessPaths: String(parsed.flags.paths).split(",").filter(Boolean),
        reason: parsed.flags.reason,
        expiresAt: parsed.flags.expires,
        canonicalBaseSha: endpoints.canonicalBaseSha,
        headSha: endpoints.headSha,
      });
      emit({ created: relative(repo, path), baseSha: endpoints.canonicalBaseSha, headShaStored: false }, json, stdout);
      return 0;
    }
    if (command === "hooks" && subcommand === "doctor") {
      const result = doctorHooks(repo, { env });
      emit(result, json, result.ok ? stdout : stderr);
      return result.ok ? 0 : 2;
    }
    if (command === "update") {
      if (!parsed.flags.bundle) throw new GovernanceError("--bundle is required; push and check never download an engine implicitly.", { code: "RG_INVOCATION" });
      const result = (context.controlledUpdate || controlledUpdate)(repo, parsed.flags.bundle, { env });
      result.repositoryRegistration = register(repo, { env });
      emit(result, json, stdout);
      return 0;
    }
    throw new GovernanceError(`Unknown command: ${parsed.positional.join(" ")}`, { code: "RG_INVOCATION" });
  } catch (error) {
    const failure = asFailure(error);
    if (automationCommand) {
      const report = {
        schemaVersion: 1,
        command,
        ok: false,
        status: "blocked",
        repoPath: failure.error.details?.repoPath || cwd,
        nextActions: failure.error.details?.nextActions || [],
        exitCode: failure.exitCode,
        error: failure.error,
        message: `${failure.error.code}: ${failure.error.message}`,
      };
      emit(report, json, stderr);
    } else emit(json ? failure : `${failure.error.code}: ${failure.error.message}`, json, stderr);
    return failure.exitCode;
  }
}
