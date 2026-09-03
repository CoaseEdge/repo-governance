# Repository governance development rules

- Use Node.js 22 for development and verification.
- The Initializer may only create scaffolding. Coding work must implement one planned feature node at a time.
- `feature-list.json` is the implementation ledger. After initialization, Coding work may only change its `passes` fields.
- Never modify or enroll existing repositories while developing or testing this project. Hook and template tests must use isolated temporary homes and repositories.
- Never add secrets, telemetry, or implicit network access. Push hooks must remain fully offline.

## Proportional Engineering

Use the smallest sufficient change and the smallest sufficient proof.

Tests, documentation, CI, configuration, and security mechanisms are
not automatically part of every code change.

Add or modify them only when the changed behavior, repository contract,
or explicit task scope requires them.

During implementation, run the nearest relevant verification first.

Run broad or full-suite verification only when required by:
- the affected risk boundary,
- an existing repository gate,
- or final handoff.

Do not rerun the same successful verification against an unchanged diff
unless an existing repository contract explicitly requires it.

Discovery does not expand scope.

An adjacent issue may be reported, but must not be fixed unless it is
required for the requested task or separately authorized.

Do not introduce new abstractions, dependencies, configuration,
fallbacks, retries, integrity mechanisms, security mechanisms, or
infrastructure unless a concrete requirement justifies them.

Once the requested behavior is implemented and the required verification
passes, stop.
