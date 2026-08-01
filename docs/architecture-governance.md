# Architecture governance and RG007

RG007 checks repository imports against a human-authored architecture contract. The rule engine is deterministic and offline: it reads source text, builds a static dependency graph, and reports facts without calling an LLM or changing source files.

## Architecture contract

Architecture governance is opt-in. Add `.repo-governance/architecture-contract.json` to the governed repository:

```json
{
  "schemaVersion": 1,
  "architectureStyle": "clean-architecture",
  "layers": [
    {
      "id": "api",
      "paths": ["src/api/**"],
      "allowedDependencies": ["application"],
      "forbiddenDependencies": []
    },
    {
      "id": "domain",
      "paths": ["src/domain/**"],
      "allowedDependencies": [],
      "forbiddenDependencies": ["http-client", "infrastructure"]
    },
    {
      "id": "application",
      "paths": ["src/application/**"],
      "allowedDependencies": ["domain"],
      "forbiddenDependencies": ["infrastructure"]
    },
    {
      "id": "infrastructure",
      "paths": ["src/infrastructure/**"],
      "allowedDependencies": ["domain"],
      "forbiddenDependencies": []
    }
  ],
  "modules": [
    {
      "id": "http-client",
      "imports": ["axios", "requests"]
    }
  ]
}
```

`architectureStyle` is descriptive and is never interpreted as a built-in policy. Layer and module IDs are repository-defined. A module may own repository paths, external import roots, or both. Import mappings make the contract—not a package-name heuristic—the source of truth that `axios` and `requests` represent the `http-client` boundary.

IDs are unique across layers and modules. Paths use repository-relative POSIX globs. A real file may belong to at most one layer and at most one explicit module, and every module-owned file must also have a layer. Invalid JSON, unsafe paths, duplicate ownership, unknown dependency IDs, or allow/forbid conflicts stop the check with `RG_ARCHITECTURE_CONTRACT`.

Within one layer, dependencies are allowed by default. A dependency that crosses a layer or an explicit module boundary must match `allowedDependencies`. `forbiddenDependencies` takes precedence. Unmapped external packages are visible in the graph but have no inferred architecture meaning and therefore do not produce dependency findings.

## Static graph and findings

The scanner supports `.js`, `.mjs`, `.cjs`, `.jsx`, `.ts`, `.mts`, `.cts`, `.tsx`, and `.py` files. JavaScript and TypeScript facts include static imports, literal `require()` calls, and literal dynamic `import()` calls. Python facts include `import` and `from ... import` statements.

Local references resolve only when exactly one tracked or unignored repository candidate exists. JavaScript and TypeScript support relative file and index resolution. Python supports repository-root absolute modules and explicit relative modules. Package subpaths are normalized to their JavaScript package root or Python top-level module before contract mapping.

The graph uses stable file and module node IDs, import/require edges, sorted skipped facts, and deterministic strongly connected components. File cycles are always detected for layer-owned files. Module cycles are computed only from modules with explicit path boundaries; directory names are never treated as implicit modules.

`repo-governance check --json` always adds:

- `architectureFindings`: RG007 errors and warnings.
- `architectureGraph`: `status`, contract path, nodes, edges, cycles, and skipped facts.

The same RG007 entries also appear in the existing top-level `findings` array. Forbidden or non-allowed dependencies use `severity: "error"` and fail the check. File and module cycles use `severity: "warning"`; they remain visible while `ok` and `exitCode` continue to reflect blocking findings only. All RG007 findings are non-waivable.

The complete repository graph is built on every enabled check. Ordinary checks report dependency violations and cycle warnings only when the source, resolved target, or cycle evidence intersects `changedPaths`. Changing the architecture contract evaluates the complete graph. This permits incremental adoption without hiding violations introduced by the current change. Removing an active contract fails closed instead of silently disabling RG007.

When no contract exists, `architectureFindings` is empty and `architectureGraph.status` is `skipped`, preserving RG001–RG006 behavior.

## Limitations and enforcement boundary

RG007 does not evaluate runtime dependency injection, reflection, generated imports, non-literal `require()` or dynamic `import()`, JavaScript/TypeScript path aliases, Python path configuration, or re-export semantics. Ambiguous and unresolved references are recorded rather than guessed. Files in unsupported languages that match contract paths are returned as skipped facts.

Static analysis cannot prove runtime call direction or architectural quality. Circular dependencies are structural warnings in RG007. Repository-owned baselines, drift metrics, and health scoring are described in [Architecture drift](architecture-drift.md).

An LLM is not used for enforcement because identical repository bytes and contract bytes must produce identical governance results. Agent adapters may later explain the structured report, but they cannot add findings or override the rule engine. RG007 detects and reports; it never moves files, rewrites imports, or modifies repository architecture.
