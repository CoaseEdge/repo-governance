import { createHash } from "node:crypto";
import { chmodSync, cpSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, renameSync, rmdirSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { GovernanceError } from "./errors.mjs";
import { verifyManagedLauncher } from "./launcher-install.mjs";
import { governanceDataRoot } from "./paths.mjs";
import { runGit } from "./process.mjs";
import { PRE_PUSH_PROTOCOL_VERSION } from "./protocol.mjs";

const MANIFEST = "hooks-install-manifest.json";
const MARKER = "# repo-governance:stable-dispatcher";
const SIDECAR_SUFFIX = ".repo-governance-original";
const REPOSITORY_MANIFEST_SUFFIX = ".repo-governance-manifest.json";

function configValue(args, options = {}) {
  const result = runGit(["config", ...args], { ...options, allowFailure: true });
  if (result.status !== 0) return null;
  const lines = result.stdout.trim().split("\n");
  return lines.at(-1) || null;
}

function dispatcherPath(dataRoot, platform = process.platform) {
  if (platform !== "win32") {
    const launcher = join(dataRoot, "launcher", "repo-governance-launcher");
    if (existsSync(launcher)) return launcher;
  }
  return join(dataRoot, platform === "win32" ? "dispatcher.exe" : "dispatcher");
}

function dispatcherInvocation(dataRoot, platform = process.platform) {
  return `${MARKER}\n\"${dispatcherPath(dataRoot, platform)}\" pre-push \"$@\"`;
}

function fileDigest(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function companionPaths(hook) {
  return {
    sidecar: `${hook}${SIDECAR_SUFFIX}`,
    manifest: `${hook}${REPOSITORY_MANIFEST_SUFFIX}`,
  };
}

function wrapperContents(dataRoot, platform = process.platform) {
  const dispatcher = dispatcherPath(dataRoot, platform);
  return `#!/bin/sh
${MARKER}
umask 077
HOOK_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd) || exit 2
SIDECAR="$HOOK_DIR/${`pre-push${SIDECAR_SUFFIX}`}"
STDIN_FILE=$(mktemp "\${TMPDIR:-/tmp}/repo-governance-pre-push.XXXXXX") || exit 2
trap 'rm -f "$STDIN_FILE"' EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM
cat >"$STDIN_FILE" || exit 2
if [ -f "$SIDECAR" ]; then
  IFS= read -r SIDECAR_HEADER <"$SIDECAR" || SIDECAR_HEADER=
  if [ "$SIDECAR_HEADER" = "#!/bin/sh" ]; then
    /bin/sh "$SIDECAR" "$@" <"$STDIN_FILE" || exit $?
  else
    "$SIDECAR" "$@" <"$STDIN_FILE" || exit $?
  fi
fi
IFS= read -r DISPATCHER_HEADER <"${dispatcher}" || DISPATCHER_HEADER=
if [ "$DISPATCHER_HEADER" = "#!/bin/sh" ]; then
  /bin/sh "${dispatcher}" pre-push "$@" <"$STDIN_FILE"
else
  "${dispatcher}" pre-push "$@" <"$STDIN_FILE"
fi
`;
}

function atomicWrite(path, contents, mode) {
  const temporary = `${path}.tmp-${process.pid}`;
  writeFileSync(temporary, contents, { mode, flag: "wx" });
  renameSync(temporary, path);
}

function repositoryHookManifest(hook, dataRoot, sidecar, platform = process.platform) {
  const dispatcher = dispatcherPath(dataRoot, platform);
  return {
    schemaVersion: 1,
    prePushProtocolVersion: PRE_PUSH_PROTOCOL_VERSION,
    wrapper: {
      file: basename(hook),
      sha256: createHash("sha256").update(wrapperContents(dataRoot, platform)).digest("hex"),
      mode: lstatSync(hook).mode & 0o777,
    },
    sidecar: sidecar ? { file: basename(sidecar), sha256: fileDigest(sidecar), mode: lstatSync(sidecar).mode & 0o777 } : null,
    dispatcher: { path: dispatcher, sha256: existsSync(dispatcher) ? fileDigest(dispatcher) : null },
  };
}

function installWrapperAt(hook, dataRoot, { platform = process.platform } = {}) {
  const companions = companionPaths(hook);
  if (existsSync(companions.sidecar) || existsSync(companions.manifest)) {
    throw new GovernanceError("Pre-push companion files already exist; refusing to overwrite them.", { code: "RG_HOOKS_CONFLICT", details: companions });
  }
  let moved = false;
  let wrapperWritten = false;
  try {
    let original = existsSync(hook) ? readFileSync(hook) : null;
    if (original?.toString("utf8").includes(MARKER)) {
      const text = original.toString("utf8");
      const invocations = [
        `${dispatcherInvocation(dataRoot, platform)}\n`,
        `${MARKER}\n"${join(dataRoot, platform === "win32" ? "dispatcher.exe" : "dispatcher")}" pre-push "$@"\n`,
      ];
      const invocation = invocations.find((candidate) => text.endsWith(candidate));
      if (!invocation) throw new GovernanceError("The effective pre-push hook contains an unrecognized governance marker.", { code: "RG_HOOKS_CONFLICT", details: { path: hook } });
      const stripped = text.slice(0, -invocation.length);
      original = stripped.trim() === "#!/bin/sh" ? null : Buffer.from(stripped);
    }
    if (original) {
      if ((lstatSync(hook).mode & 0o111) === 0) {
        throw new GovernanceError("Existing pre-push hook is not executable; refusing to change its effective behavior.", { code: "RG_HOOKS_CONFLICT", details: { path: hook } });
      }
      renameSync(hook, companions.sidecar);
      moved = true;
    }
    atomicWrite(hook, wrapperContents(dataRoot, platform), 0o755);
    wrapperWritten = true;
    const manifest = repositoryHookManifest(hook, dataRoot, moved ? companions.sidecar : null, platform);
    atomicWrite(companions.manifest, `${JSON.stringify(manifest, null, 2)}\n`, 0o600);
    return { manifest, sidecar: moved ? companions.sidecar : null };
  } catch (error) {
    if (wrapperWritten) rmSync(hook, { force: true });
    rmSync(companions.manifest, { force: true });
    if (moved && existsSync(companions.sidecar)) renameSync(companions.sidecar, hook);
    throw error;
  }
}

function writeTemplateHook(template, dataRoot) {
  const hook = join(template, "hooks", "pre-push");
  mkdirSync(dirname(hook), { recursive: true });
  installWrapperAt(hook, dataRoot);
}

function copyTemplate(source, target) {
  if (!existsSync(source)) return;
  cpSync(source, target, {
    recursive: true,
    errorOnExist: true,
    force: false,
  });
}

function templateDigest(root) {
  const hash = createHash("sha256");
  function visit(directory, prefix = "") {
    for (const entry of readdirSync(directory, { withFileTypes: true }).sort((left, right) => Buffer.from(left.name).compare(Buffer.from(right.name)))) {
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
      const path = join(directory, entry.name);
      const stat = lstatSync(path);
      hash.update(relative).update("\0").update(String(stat.mode)).update("\0");
      if (entry.isDirectory()) visit(path, relative);
      else hash.update(readFileSync(path)).update("\0");
    }
  }
  visit(root);
  return hash.digest("hex");
}

export function installFutureHooks({ compose = false, env = process.env, dispatcherSource } = {}) {
  const dataRoot = governanceDataRoot(env);
  const managedTemplate = join(dataRoot, "git-template");
  const manifestPath = join(dataRoot, MANIFEST);
  if (existsSync(manifestPath)) throw new GovernanceError("Governance hooks are already installed.", { code: "RG_HOOKS" });
  const originResult = runGit(["config", "--global", "--show-origin", "--get", "init.templateDir"], { env, allowFailure: true });
  const existingLine = originResult.status === 0 ? originResult.stdout.trim() : "";
  const existingPath = existingLine ? existingLine.split(/\s+/).at(-1) : null;
  if (existingPath && !compose) {
    throw new GovernanceError("A global init.templateDir already exists. Nothing was changed; rerun with hooks install --compose after reviewing the source and path.", {
      code: "RG_HOOKS_TEMPLATE_EXISTS",
      details: { origin: existingLine, path: existingPath },
    });
  }
  if (!dispatcherSource || !existsSync(dispatcherSource)) {
    throw new GovernanceError("A verified stable dispatcher is required for hook installation.", { code: "RG_HOOKS_DISPATCHER" });
  }
  mkdirSync(dataRoot, { recursive: true });
  let dispatcherCreated = false;
  try {
    if (existingPath) copyTemplate(resolve(existingPath), managedTemplate);
    else mkdirSync(managedTemplate, { recursive: true });
    const installedDispatcher = dispatcherPath(dataRoot);
    if (existsSync(installedDispatcher)) {
      if (fileDigest(installedDispatcher) !== fileDigest(dispatcherSource)) {
        throw new GovernanceError("Installed stable dispatcher differs from the verified hook input.", { code: "RG_HOOKS_DISPATCHER", details: { installedDispatcher } });
      }
    } else {
      cpSync(dispatcherSource, installedDispatcher, { errorOnExist: true, force: false });
      chmodSync(installedDispatcher, 0o755);
      dispatcherCreated = true;
    }
    writeTemplateHook(managedTemplate, dataRoot);
    const manifest = {
      previousTemplate: existingPath,
      previousOrigin: existingLine || null,
      previousTemplateDigest: existingPath ? templateDigest(resolve(existingPath)) : null,
      managedTemplate,
      composed: Boolean(existingPath),
      dispatcherSha256: fileDigest(installedDispatcher),
    };
    writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, { flag: "wx" });
    runGit(["config", "--global", "init.templateDir", managedTemplate], { env });
    return manifest;
  } catch (error) {
    rmSync(managedTemplate, { recursive: true, force: true });
    if (dispatcherCreated) rmSync(dispatcherPath(dataRoot), { force: true });
    rmSync(manifestPath, { force: true });
    throw error;
  }
}

export function uninstallFutureHooks({ env = process.env } = {}) {
  const dataRoot = governanceDataRoot(env);
  const manifestPath = join(dataRoot, MANIFEST);
  if (!existsSync(manifestPath)) throw new GovernanceError("Governance hooks are not installed.", { code: "RG_HOOKS" });
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  const current = configValue(["--global", "--get", "init.templateDir"], { env });
  if (resolve(current || "") !== resolve(manifest.managedTemplate)) {
    throw new GovernanceError("Global init.templateDir changed after installation; refusing to overwrite the user's newer configuration.", { code: "RG_HOOKS_UNINSTALL_BLOCKED" });
  }
  if (manifest.previousTemplate) runGit(["config", "--global", "init.templateDir", manifest.previousTemplate], { env });
  else runGit(["config", "--global", "--unset", "init.templateDir"], { env, allowFailure: true });
  rmSync(manifest.managedTemplate, { recursive: true, force: true });
  rmSync(manifestPath, { force: true });
  return { restoredTemplate: manifest.previousTemplate };
}

export function effectiveRepositoryHook(repo, { env = process.env } = {}) {
  const result = runGit(["config", "--get", "core.hooksPath"], { cwd: repo, env, allowFailure: true });
  if (result.status === 0) {
    const hooksPath = result.stdout.trim();
    return {
      mode: hooksPath.includes("husky") ? "husky" : "custom-hooks-path",
      path: join(resolve(repo, hooksPath), "pre-push"),
    };
  }
  const native = runGit(["rev-parse", "--git-path", "hooks/pre-push"], { cwd: repo, env });
  const path = native.stdout.trim();
  return { mode: "native", path: resolve(repo, path) };
}

export function snapshotEffectiveRepositoryHook(repo, { env = process.env } = {}) {
  const target = effectiveRepositoryHook(repo, { env });
  const companions = companionPaths(target.path);
  const companionSnapshots = Object.fromEntries(Object.entries(companions).map(([name, path]) => {
    if (!existsSync(path)) return [name, { path, existed: false, contents: null, modeBits: null }];
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new GovernanceError("Pre-push companion is not a regular file.", { code: "RG_HOOKS_CONFLICT", details: { path } });
    return [name, { path, existed: true, contents: readFileSync(path), modeBits: stat.mode }];
  }));
  if (existsSync(target.path)) {
    const stat = lstatSync(target.path);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new GovernanceError("Effective pre-push hook is not a regular file; refusing composition.", { code: "RG_HOOKS_CONFLICT", details: { path: target.path } });
    return { ...target, existed: true, contents: readFileSync(target.path), modeBits: stat.mode, parentExisted: true, companions: companionSnapshots };
  }
  return { ...target, existed: false, contents: null, modeBits: null, parentExisted: existsSync(dirname(target.path)), companions: companionSnapshots };
}

export function restoreEffectiveRepositoryHook(snapshot) {
  if (snapshot.existed) writeFileSync(snapshot.path, snapshot.contents, { mode: snapshot.modeBits });
  else {
    rmSync(snapshot.path, { force: true });
    if (!snapshot.parentExisted && existsSync(dirname(snapshot.path)) && readdirSync(dirname(snapshot.path)).length === 0) rmdirSync(dirname(snapshot.path));
  }
  for (const companion of Object.values(snapshot.companions || {})) {
    if (companion.existed) writeFileSync(companion.path, companion.contents, { mode: companion.modeBits });
    else rmSync(companion.path, { force: true });
  }
}

export function connectEffectiveRepositoryHook(repo, { env = process.env, requireDispatcher = false } = {}) {
  const target = snapshotEffectiveRepositoryHook(repo, { env });
  const dataRoot = governanceDataRoot(env);
  const dispatcher = dispatcherPath(dataRoot);
  if (requireDispatcher && !existsSync(dispatcher)) throw new GovernanceError("Stable dispatcher is missing; install a verified repo-governance release before bootstrap.", { code: "RG_HOOKS_DISPATCHER", details: { dispatcher } });
  if (target.existed && target.contents.toString("utf8") === wrapperContents(dataRoot)) {
    const inspected = inspectEffectiveRepositoryHook(repo, { env });
    if (!inspected.connected) {
      const dispatcherDigestOnly = inspected.issues.length === 1
        && inspected.issues[0] === "Stable dispatcher digest differs from the wrapper manifest.";
      if (!dispatcherDigestOnly || !verifyManagedLauncher({ env })) {
        throw new GovernanceError("Existing governance wrapper failed manifest verification.", { code: "RG_HOOKS_CONFLICT", details: { path: target.path, issues: inspected.issues } });
      }
      const companions = companionPaths(target.path);
      const previousManifest = target.companions.manifest.contents;
      const previousMode = target.companions.manifest.modeBits;
      try {
        const manifest = repositoryHookManifest(target.path, dataRoot, inspected.sidecar);
        atomicWrite(companions.manifest, `${JSON.stringify(manifest, null, 2)}\n`, 0o600);
        const refreshed = inspectEffectiveRepositoryHook(repo, { env });
        if (!refreshed.connected) {
          throw new GovernanceError("Refreshed governance wrapper failed manifest verification.", { code: "RG_HOOKS_CONFLICT", details: { path: target.path, issues: refreshed.issues } });
        }
        return { mode: target.mode, changed: true, refreshed: true, path: target.path, sidecar: refreshed.sidecar };
      } catch (error) {
        atomicWrite(companions.manifest, previousManifest, previousMode);
        throw error;
      }
    }
    return { mode: target.mode, changed: false, path: target.path, sidecar: inspected.sidecar };
  }
  mkdirSync(dirname(target.path), { recursive: true });
  const installed = installWrapperAt(target.path, dataRoot);
  return { mode: target.mode, changed: true, path: target.path, sidecar: installed.sidecar };
}

export function inspectEffectiveRepositoryHook(repo, { env = process.env } = {}) {
  const target = effectiveRepositoryHook(repo, { env });
  const dataRoot = governanceDataRoot(env);
  const dispatcher = dispatcherPath(dataRoot);
  const companions = companionPaths(target.path);
  if (!existsSync(target.path)) return { ...target, dispatcher, connected: false, issues: ["Effective pre-push hook is missing."] };
  let stat;
  let contents;
  let manifest;
  try {
    stat = lstatSync(target.path);
    contents = readFileSync(target.path, "utf8");
    manifest = JSON.parse(readFileSync(companions.manifest, "utf8"));
  } catch (error) {
    return { ...target, dispatcher, connected: false, issues: [`Unable to read the wrapper manifest: ${error.message}`] };
  }
  const issues = [];
  if (manifest.schemaVersion !== 1) issues.push("Governance wrapper manifest schema differs.");
  if (manifest.wrapper?.file !== basename(target.path)) issues.push("Governance wrapper path differs from its manifest.");
  if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o111) === 0) issues.push("Governance wrapper is not an executable regular file.");
  if ((stat.mode & 0o777) !== manifest.wrapper?.mode) issues.push("Governance wrapper permissions differ from its manifest.");
  if (contents !== wrapperContents(dataRoot)) issues.push("Governance wrapper contents differ from the installed protocol.");
  if (manifest.prePushProtocolVersion !== PRE_PUSH_PROTOCOL_VERSION) issues.push("Governance wrapper protocol version differs.");
  if (manifest.wrapper?.sha256 !== fileDigest(target.path)) issues.push("Governance wrapper digest differs from its manifest.");
  const sidecar = manifest.sidecar ? companions.sidecar : null;
  if (sidecar) {
    if (manifest.sidecar.file !== basename(sidecar)) issues.push("Governance sidecar path differs from its manifest.");
    if (!existsSync(sidecar)) issues.push("Governance sidecar is missing.");
    else {
      const sidecarStat = lstatSync(sidecar);
      if (!sidecarStat.isFile() || sidecarStat.isSymbolicLink()) issues.push("Governance sidecar is not a regular file.");
      if ((sidecarStat.mode & 0o111) === 0) issues.push("Governance sidecar is not executable.");
      if (fileDigest(sidecar) !== manifest.sidecar.sha256) issues.push("Governance sidecar digest differs from its manifest.");
      if ((sidecarStat.mode & 0o777) !== manifest.sidecar.mode) issues.push("Governance sidecar permissions differ from its manifest.");
      if (readFileSync(sidecar, "utf8").includes(MARKER)) issues.push("Governance sidecar recursively invokes the dispatcher.");
    }
  } else if (existsSync(companions.sidecar)) issues.push("Undeclared governance sidecar exists.");
  if (manifest.dispatcher?.path !== dispatcher) issues.push("Governance dispatcher path differs from its manifest.");
  if (!existsSync(dispatcher)) issues.push("Stable dispatcher is missing.");
  else {
    const dispatcherStat = lstatSync(dispatcher);
    if (!dispatcherStat.isFile() || dispatcherStat.isSymbolicLink() || (dispatcherStat.mode & 0o111) === 0) issues.push("Stable dispatcher is not an executable regular file.");
    if (manifest.dispatcher.sha256 && fileDigest(dispatcher) !== manifest.dispatcher.sha256) issues.push("Stable dispatcher digest differs from the wrapper manifest.");
  }
  return {
    ...target,
    dispatcher,
    sidecar,
    manifest: companions.manifest,
    issues,
    connected: issues.length === 0,
  };
}

export function disconnectEffectiveRepositoryHook(repo, { env = process.env } = {}) {
  const inspected = inspectEffectiveRepositoryHook(repo, { env });
  if (!inspected.connected) throw new GovernanceError("Governance wrapper changed or is incomplete; refusing automatic disconnect.", { code: "RG_HOOKS_DISCONNECT_BLOCKED", details: { issues: inspected.issues } });
  const companions = companionPaths(inspected.path);
  if (inspected.sidecar) renameSync(companions.sidecar, inspected.path);
  else rmSync(inspected.path, { force: true });
  rmSync(companions.manifest, { force: true });
  return { restored: Boolean(inspected.sidecar), path: inspected.path };
}

export function doctorHooks(repo, { env = process.env, strict = false } = {}) {
  const dataRoot = governanceDataRoot(env);
  const issues = [];
  const dispatcher = dispatcherPath(dataRoot);
  if (!existsSync(dispatcher)) issues.push("Stable dispatcher is missing.");
  const manifestPath = join(dataRoot, MANIFEST);
  if (existsSync(manifestPath)) {
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    if (manifest.dispatcherSha256 && (!existsSync(dispatcher) || fileDigest(dispatcher) !== manifest.dispatcherSha256)) {
      issues.push("The stable dispatcher differs from the verified hook installation manifest.");
    }
    if (manifest.composed && (!existsSync(manifest.previousTemplate) || templateDigest(manifest.previousTemplate) !== manifest.previousTemplateDigest)) {
      issues.push("The original Git template changed after composition. Rerun hooks install --compose after reviewing the new template; no files were overwritten.");
    }
  }
  const current = inspectEffectiveRepositoryHook(repo, { env });
  if (!current.connected) {
    if (existsSync(current.path)) issues.push(...(current.issues || []));
    const hooksResult = runGit(["config", "--show-origin", "--get", "core.hooksPath"], { cwd: repo, env, allowFailure: true });
    if (hooksResult.status === 0) {
      issues.push(`Effective core.hooksPath (${hooksResult.stdout.trim()}) does not reach the stable dispatcher. Reconnect the reviewed pre-push hook before continuing.`);
    } else if (strict) {
      if (!existsSync(current.path)) issues.push(...(current.issues || []));
      issues.push("The current repository has no effective pre-push connection to the stable dispatcher.");
    } else {
      const globalTemplate = configValue(["--global", "--get", "init.templateDir"], { env });
      if (!globalTemplate || !existsSync(join(globalTemplate, "hooks", "pre-push"))) issues.push("No effective repository hook or governance Git template was found.");
    }
  }
  return { ok: issues.length === 0, issues, dispatcher, hookConnected: current.connected };
}
