# Plans index

This directory holds design and implementation plans for the model-router plugins.

## Active plans

- [`task-model-router-role-tier-plan.md`](./task-model-router-role-tier-plan.md)
  - Role and model-tier routing for the `@s3tupw1zard/opencode-task-model-router` package,
  including layered JSONC configuration, role tool policies, MCP assignments,
  categorized budgets, controlled delegation, compatibility, tests, and docs.
- [`model-router-enforcement-and-verification-plan.md`](./model-router-enforcement-and-verification-plan.md)
  - Enforced Delegation Architecture (three-layer enforcement and verification:
  hard-block guard, independent acceptance gate, and quality escalation ladder)
  on top of the existing prompt-based router. Covers both usage modes:
  on-the-fly orchestrator delegation and `[tier:X]`-annotated plan execution.

## Related records

- Architecture decision records: [`../adr/`](../adr/)
  - `0000-spike-results.md` - Phase 0.0 enforcement-primitives capability spike.
- QA reports: `../qa/` (added during Wave 5).
