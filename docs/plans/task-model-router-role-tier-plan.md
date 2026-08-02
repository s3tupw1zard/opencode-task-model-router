# Implementation Plan - Role and Tier Routing for `@s3tupw1zard/opencode-task-model-router`

> **Status:** Draft, ready for phased implementation
> **Repository:** `https://github.com/s3tupw1zard/opencode-task-model-router`
> **Package target:** `@s3tupw1zard/opencode-task-model-router`
> **Scope:** Extend the existing three-tier OpenCode plugin so that it routes independently by task role and model tier, enforces role-based tool policies, counts configurable local and MCP tool classes, and preserves legacy configurations.
> **Planning date:** 2026-08-01, Europe/Berlin

## 1. Objectives

The fork must make two independent routing decisions:

1. Select a task role.
2. Select a model capability tier.

The supported default roles are:

- `explore`: inspect the local codebase without modifying it.
- `research`: search web sources, documentation, and external repositories.
- `implementation`: modify code and run implementation verification.
- `architecture`: perform planning, system design, and difficult technical analysis.
- `review`: independently inspect changes, run verification, and report risks.

The supported default model tiers remain:

- `fast`
- `medium`
- `heavy`

The plugin generates only configured role-tier combinations, for example:

```text
explore-fast
explore-medium
research-fast
research-medium
implementation-fast
implementation-medium
implementation-heavy
architecture-medium
architecture-heavy
review-medium
review-heavy
```

Escalation changes the tier while preserving the role. A failed `implementation-medium` attempt may escalate to `implementation-heavy`; it must not silently become an architecture agent.

## 2. Repository Baseline

### 2.1 Current tier model

`tiers.json` currently uses `fast`, `medium`, and `heavy` as all of the following:

- model capability and cost tier;
- semantic task role;
- generated OpenCode agent name;
- prompt key;
- task-pattern key;
- read-cap key;
- enforcement key;
- verification rank;
- escalation-ladder entry.

Current semantic assignments are:

| Tier | Current role | Default cap | Default relative cost |
|------|--------------|-------------|-----------------------|
| `fast` | Read-only exploration | 8 local reads | 1x |
| `medium` | Implementation | 5 preliminary reads | 5x |
| `heavy` | Architecture, debugging, security | 3 reads | 20x |

This identity conflation is the primary constraint to remove.

### 2.2 Configuration

`src/router/config.ts` currently:

- loads only the bundled `tiers.json`;
- validates it with handwritten checks;
- caches the parsed object;
- persists active preset, mode, and enforcement state in the user config directory;
- does not support JSONC, project overrides, recursive merging, or source-aware diagnostics.

The validation is permissive in several nested blocks and does not validate all cross-references. Unknown tier names can reach escalation or delegation logic.

### 2.3 Agent generation

`src/index.ts` currently captures the active preset when the plugin factory starts and generates one subagent per tier from the selected preset.

Generated definitions include:

- model and variant;
- description;
- provider-specific reasoning options;
- a tier prompt;
- color;
- deprecated `maxSteps` rather than current `steps`.

The generated agents do not currently receive explicit role-based permissions. Statements such as "fast is read-only" are prompt contracts, not enforced capability boundaries.

### 2.4 Classification and delegation

`src/router/protocol.ts` injects a prompt that hardcodes:

- local read-only work to `fast`;
- implementation to `medium`;
- architecture and difficult debugging to `heavy`.

Ordinary native Task delegation is selected by the orchestrator model. The only runtime classifier, `classifyTrivial` in `src/router/sessions.ts`, recognizes only literal `fast` dispatches.

The optional verified `delegate` tool accepts `task`, `tier`, and `acceptance`. It can retry and escalate, but it has no role parameter. Native Task verification can append a failure note after a task returns, but cannot replay that completed Task call.

### 2.5 Tool handling

The advisory read-cap list is hardcoded to:

```text
grep
read
glob
ls
```

The hard guard separately tracks total tool calls, reads, mutations, and consecutive non-producing actions. Several tool sets are duplicated across modules and omit current names such as `apply_patch`.

Current limitations include:

- MCP research calls do not consume a research budget.
- LSP and Git inspection do not consume a local-read budget.
- GitHub reads and writes are not separated.
- Memory reads and writes are not separated.
- Unknown tools are classified as generic `other` rather than denied.
- Model strength can indirectly change behavior because role and tier are the same value.

### 2.6 Reusable behavior

The following existing systems should be retained:

- provider and model presets;
- `costRatio` values;
- variants, thinking, and reasoning options;
- budget modes;
- tier escalation ladder;
- independent acceptance gate;
- deterministic verification;
- grader-session isolation;
- changed-file attribution;
- cap banners and redundancy fingerprints;
- persisted command state;
- existing command infrastructure.

Provider fallback is currently prompt guidance, not runtime provider failover. Documentation must describe that honestly unless runtime failover is implemented as a separate feature.

## 3. External OpenCode Contracts

The implementation must follow the current OpenCode contracts verified from the official documentation and source:

- Agent definitions support per-agent `permission` rules.
- Permission keys support wildcard matching against MCP tool names.
- The last matching OpenCode permission rule wins.
- `permission.task` controls which subagents an agent can invoke.
- MCP tools are prefixed with the configured server name.
- `steps` is the current agent iteration field; `maxSteps` is deprecated.
- `edit` gates `edit`, `write`, and `apply_patch`.
- Explicit OpenCode denies remain denied in auto-approval mode.
- MCP server processes, URLs, tokens, and authentication remain OpenCode configuration responsibilities.

Authoritative sources:

- `https://opencode.ai/docs/plugins/`
- `https://opencode.ai/docs/agents/`
- `https://opencode.ai/docs/permissions/`
- `https://opencode.ai/docs/tools/`
- `https://opencode.ai/docs/mcp-servers/`
- `https://github.com/anomalyco/opencode/tree/dev/packages/plugin`
- `https://github.com/anomalyco/opencode/tree/dev/packages/opencode/src/plugin`
- `https://github.com/anomalyco/opencode/tree/dev/packages/web/src/content/docs`

### 3.1 Context documentation package

The Context registry does not currently provide `@opencode-ai/plugin` or an OpenCode documentation package. Before implementation begins, build a local Context package from the upstream repository:

```bash
context add https://github.com/anomalyco/opencode.git \
  --tag dev \
  --name opencode \
  --pkg-version dev \
  --lang en
```

If indexing the full monorepo is too broad, create separate packages with `--path` for:

```text
packages/plugin
packages/web/src/content/docs
packages/opencode/src/plugin
```

After indexing, verify that Context can retrieve documentation for agent permissions, Task permissions, plugin hooks, MCP tool prefixes, and the current `Plugin` type. The package is installed locally as `opencode@dev`; arbitrary source imports use the Context CLI because the connected Context MCP exposes only registry lookup and download operations.

## 4. Target Runtime Model

### 4.1 Canonical identity

```ts
interface AgentIdentity {
  role: string;
  tier: string;
  agentName: string;
}
```

Runtime consumers must receive an `AgentIdentity` instead of deriving role or tier from a single string.

### 4.2 Routing stages

Routing follows these stages:

1. Resolve an explicit role directive when present.
2. Otherwise classify the role using configurable role patterns.
3. Resolve an explicit tier directive when present.
4. Otherwise classify complexity using configurable tier patterns and the active budget mode.
5. Fall back to the role's `defaultTier`.
6. Validate the tier against the role's `allowedTiers`.
7. Resolve model settings and produce the combined agent name.

Role classification must not imply a fixed tier. Tier selection must not grant additional tool permissions.

Explicit unsupported combinations fail with a clear routing error. Automatic selection may choose the nearest allowed tier according to the configured ladder.

### 4.3 Agent prompt composition

Generated prompts are composed in this order:

1. shared subagent contract;
2. role contract;
3. tier cost and execution constraints;
4. configured return protocol;
5. provider-specific model prefix when required.

Implementation agents include the required structured research request:

```text
NEEDS_RESEARCH:
- Question:
- Required source:
- Reason:
- Affected implementation decision:
```

Review agents return findings and normally send requested fixes back to implementation instead of editing code directly.

## 5. Configuration Design

### 5.1 Layered discovery

Configuration is loaded in this order:

```text
bundled defaults
  -> ~/.config/opencode/task-model-router.jsonc
  -> <project>/.opencode/task-model-router.jsonc
```

Merge behavior:

- merge objects recursively;
- replace arrays as complete values;
- let project values override global values;
- retain field-level source provenance;
- validate the final merged configuration;
- report the source file and exact field path for every error.

Persisted runtime command state remains separate from structural configuration. It may select an active preset, mode, or enforcement state after configuration validation, but it cannot introduce models, roles, tools, or delegation edges that were not validated.

### 5.2 Canonical configuration example

```jsonc
{
  "schemaVersion": 2,
  "activePreset": "opencode-go",

  "models": {
    "fast": {
      "model": "opencode-go/deepseek-v4-flash",
      "costRatio": 1
    },
    "medium": {
      "model": "opencode-go/qwen3.7-plus",
      "costRatio": 5
    },
    "heavy": {
      "model": "opencode-go/glm-5.2",
      "costRatio": 20
    }
  },

  "roles": {
    "explore": {
      "defaultTier": "fast",
      "allowedTiers": ["fast", "medium"],
      "taskPatterns": ["find", "locate", "inspect", "trace"],
      "tools": {
        "allowCategories": ["localRead", "memoryRead"],
        "allowMcp": [],
        "denyCategories": ["codeMutation", "externalWrite", "memoryWrite"]
      }
    },
    "research": {
      "defaultTier": "fast",
      "allowedTiers": ["fast", "medium"],
      "tools": {
        "allowCategories": ["externalResearch", "memoryRead"],
        "allowMcp": ["searxng", "context", "github", "time", "memory"],
        "denyCategories": ["codeMutation", "externalWrite", "memoryWrite"]
      }
    },
    "implementation": {
      "defaultTier": "medium",
      "allowedTiers": ["fast", "medium", "heavy"],
      "tools": {
        "allowCategories": ["localRead", "codeMutation", "commandExecution"],
        "allowMcp": [],
        "denyCategories": ["externalWrite", "memoryWrite"]
      }
    },
    "architecture": {
      "defaultTier": "medium",
      "allowedTiers": ["medium", "heavy"],
      "tools": {
        "allowCategories": ["localRead", "externalResearch", "memoryRead"],
        "allowMcp": ["context", "github", "memory", "searxng"],
        "denyCategories": ["codeMutation", "externalWrite", "memoryWrite"]
      }
    },
    "review": {
      "defaultTier": "medium",
      "allowedTiers": ["medium", "heavy"],
      "tools": {
        "allowCategories": ["localRead", "commandExecution", "externalResearch"],
        "allowMcp": ["github"],
        "denyCategories": ["codeMutation", "externalWrite", "memoryWrite"]
      }
    }
  },

  "tools": {
    "categories": {
      "localRead": ["read", "grep", "glob", "list", "ls", "lsp"],
      "codeMutation": ["edit", "write", "apply_patch", "patch", "multiedit"],
      "commandExecution": ["bash", "shell"],
      "externalResearch": ["webfetch", "websearch"]
    },
    "mcp": {
      "searxng": {
        "readPatterns": ["searxng_*"]
      },
      "context": {
        "readPatterns": ["context_*"]
      },
      "memory": {
        "readPatterns": ["memory_read_*", "memory_search_*", "memory_open_*"],
        "writePatterns": ["memory_create_*", "memory_add_*", "memory_delete_*"]
      },
      "github": {
        "readPatterns": [
          "github_get_*",
          "github_list_*",
          "github_search_*",
          "github_issue_read",
          "github_pull_request_read"
        ],
        "writePatterns": [
          "github_create_*",
          "github_update_*",
          "github_delete_*",
          "github_add_*",
          "github_push_*",
          "github_merge_*",
          "github_issue_write",
          "github_sub_issue_write",
          "github_pull_request_review_write"
        ]
      },
      "time": {
        "readPatterns": ["time_*"]
      }
    }
  },

  "budgets": {
    "roles": {
      "explore": { "localRead": 8 },
      "research": { "externalResearch": 8 },
      "implementation": { "localRead": 5, "commandExecution": 10 },
      "architecture": { "localRead": 5, "externalResearch": 5 },
      "review": { "localRead": 8, "commandExecution": 8 }
    }
  },

  "delegation": {
    "maxDepth": 1,
    "allowedChildren": {
      "explore": [],
      "research": [],
      "implementation": [],
      "architecture": [],
      "review": []
    }
  }
}
```

Role-specific model overrides are supported for cases where the same tier needs a different model for one role. Resolution order is:

```text
role tier override
  -> active preset tier model
  -> top-level tier model
```

### 5.3 Legacy normalization

Configurations without `schemaVersion` or `roles` are normalized into the canonical runtime model.

Compatibility behavior:

- existing preset entries become model-tier definitions;
- existing variants, reasoning, thinking, costs, descriptions, and steps remain available;
- built-in defaults supply the five roles;
- existing `taskPatterns` become legacy tier-complexity hints;
- existing `tierCaps` become compatibility budget overrides;
- existing modes, fallback instructions, and enforcement settings remain available;
- hidden `fast`, `medium`, and `heavy` aliases preserve old Task calls and annotated plans;
- all new routing uses role-tier identities.

The normalization boundary is the only module that understands both legacy and canonical shapes. Runtime modules consume only normalized configuration.

### 5.4 Diagnostic command

Add `/router diagnose` with secret-free output containing:

- loaded configuration files in precedence order;
- missing optional files;
- effective active preset and mode;
- effective tier models and cost ratios;
- generated role-tier agent matrix;
- effective role prompts and model overrides;
- tool categories and patterns;
- MCP read/write assignments;
- role allow and deny policies;
- effective budgets;
- delegation depth and allowed role edges;
- legacy compatibility warnings;
- configuration provenance for overridden values.

## 6. Tool Policy Design

### 6.1 Classification categories

Every tool call resolves to exactly one category using ordered, configurable matching:

1. `memoryWrite`
2. `externalWrite`
3. `codeMutation`
4. `commandExecution`
5. `externalResearch`
6. `memoryRead`
7. `localRead`
8. `unknown`

More dangerous and more specific classes are evaluated first. This prevents a broad pattern such as `github_*` from classifying a GitHub write tool as read-only research.

### 6.2 Decision order

Tool authorization follows this order:

1. Match explicit deny patterns.
2. Match denied categories or MCP assignments.
3. Reject unknown tools.
4. Require an allowed pattern, category, or MCP assignment.
5. Pass the call to OpenCode's normal permission system.

A router allow means only that the role policy permits the operation. It must not turn an OpenCode `ask` or `deny` into `allow`.

### 6.3 Default role policies

| Role | Allowed by default | Denied by default |
|------|--------------------|-------------------|
| `explore` | Local reads, LSP, Git status/diff/log, Memory reads | Edits, broad web research, external writes, Memory writes |
| `research` | SearXNG, Context, GitHub read-only, Time, Memory reads | Local edits, GitHub writes, Memory writes |
| `implementation` | Local reads, edits, patching, Bash, LSP, tests, lint, build, formatter, Git diff | Broad web research, GitHub MCP, Memory writes |
| `architecture` | Local reads, LSP, Context, GitHub read-only, Memory reads, optional SearXNG | Code edits, GitHub writes, Memory writes |
| `review` | Code and diff reads, LSP, tests, lint, build, GitHub PR reads | Code edits, GitHub writes, Memory writes |

GitHub and Memory writes require explicit role configuration. A heavy model never receives them automatically.

### 6.4 Bash command policy

Tool-name classification alone cannot distinguish read-only Git commands from arbitrary shell execution. Role policy therefore supports command patterns.

Default explore commands include only:

```text
git status*
git diff*
git log*
git show*
```

Implementation and review may run configured test, lint, build, and formatter commands. Existing OpenCode confirmations and command-specific denies remain authoritative.

## 7. Delegation Control

### 7.1 Default topology

```text
orchestrator
  -> explore
  -> research
  -> architecture
  -> implementation
  -> review
```

Generated subagents receive `permission.task: deny` by default.

### 7.2 Optional nesting

If nested delegation is enabled:

- `maxDepth` is enforced in the Task before-hook;
- self-delegation is invalid configuration;
- implementation may target only `explore` or `research`;
- allowed role edges are checked independently of tier;
- tier escalation does not increase delegation depth;
- direct user invocation does not bypass role tool restrictions.

The default remains `maxDepth: 1`, meaning orchestrator-to-subagent only.

## 8. Tool Budgets and Enforcement

Replace the single hardcoded read counter with category counters while retaining the existing total guard budget.

Minimum counters:

- local reads;
- external research;
- code mutations;
- command executions;
- external writes;
- Memory writes;
- total calls.

MCP searches and reads consume external-research budgets. GitHub and Memory writes consume their restrictive write categories. Failed executed calls still consume a budget unit; blocked calls are recorded separately.

Cap banners remain available, but describe the relevant category rather than always saying "read-only call".

Fingerprinting must include meaningful MCP search arguments while excluding secrets. It must distinguish different read offsets and relevant filters so legitimate pagination is not treated as an exact duplicate.

## 9. Verification and Escalation

The existing acceptance gate remains the verification core.

Required changes:

- pass `AgentIdentity` through delegation artefacts and session state;
- rank producer and grader by tier only;
- preserve role when escalating;
- filter the escalation ladder through the role's allowed tiers;
- use the configured ladder everywhere instead of hardcoded arrays;
- preserve producer/grader session independence;
- keep deterministic checks serialized per workspace;
- direct review findings back to implementation rather than allowing review edits by default.

Cost accounting continues to use tier `costRatio`. Grader and orchestrator cost accounting should be documented separately from producer-attempt ceilings rather than silently mixed into existing semantics.

## 10. Phased Implementation

Each phase is small, independently testable, and must leave the repository green before the next phase starts.

### Phase 1 - Characterization

Tasks:

- Add direct tests for the current `config` hook.
- Capture generated legacy agents, prompts, variants, options, and steps.
- Capture current command and preset behavior.
- Add package-content assertions for future configuration documentation.

Acceptance criteria:

- Existing behavior is represented by tests before production refactoring.
- No runtime behavior changes.

### Phase 2 - Fork identity

Tasks:

- Rename package metadata to `@s3tupw1zard/opencode-task-model-router`.
- Update description, repository, homepage, bugs, and keywords.
- Rename the state-file namespace.
- Update user-facing command titles and documentation references.

Acceptance criteria:

- Package metadata points only to the renamed fork.
- The unchanged local directory name has no runtime significance.

### Phase 3 - Layered JSONC configuration

Tasks:

- Add `jsonc-parser` as a runtime dependency.
- Implement bundled, global, and project source discovery.
- Implement recursive object merge and array replacement.
- Track source provenance per field.
- Return source-aware parse and validation errors.
- Preserve cache invalidation and runtime state behavior.

Tests:

- missing optional files;
- comments and trailing commas;
- global override;
- project override;
- recursive object merge;
- array replacement;
- syntax error location;
- final validation error source and field path.

### Phase 4 - Canonical normalization

Tasks:

- Add raw v1, raw v2, and normalized types.
- Normalize model tiers, roles, modes, tools, budgets, and delegation.
- Add cross-reference validation.
- Add legacy aliases and compatibility warnings.

Tests:

- old presets;
- partial project overrides;
- missing tier references;
- unsupported default tiers;
- invalid delegation edges;
- invalid pattern and budget definitions.

### Phase 5 - Independent routing

Tasks:

- Implement `classifyTaskRole`.
- Implement `selectModelTier`.
- Implement `resolveAgentIdentity`.
- Support explicit role and tier directives.
- Apply mode strategy without changing role.

Tests:

- all five role classifications;
- fast, medium, and heavy selection;
- explicit directives;
- role-default fallback;
- mode effects;
- unsupported combinations;
- deterministic conflict resolution.

### Phase 6 - Combined agent generation

Tasks:

- Extract a pure `buildAgentSpecs` function.
- Generate only role `allowedTiers` combinations.
- Compose role and tier prompts.
- use `steps` instead of `maxSteps`;
- resolve role model overrides;
- add restrictive Task permissions;
- retain hidden legacy aliases in compatibility mode.

Tests:

- exact generated matrix;
- partial matrices;
- model and variant resolution;
- prompt composition;
- permission definitions;
- legacy aliases;
- preset switching and restart messaging.

### Phase 7 - Tool pattern engine and policies

Tasks:

- Implement OpenCode-compatible `*` and `?` matching.
- Add built-in and MCP pattern classification.
- Add deny-first role policy evaluation.
- Add command-pattern checks.
- Reject unknown tools.
- Integrate policy checks into `tool.execute.before`.

Tests:

- allowed patterns;
- denied patterns;
- overlapping allow and deny;
- unknown tools;
- GitHub read versus write;
- Memory read versus write;
- configurable MCP names;
- OpenCode permission non-bypass.

### Phase 8 - Categorized budgets

Tasks:

- Replace `READ_ONLY_TOOLS` consumers with the classifier.
- Store counters by category and identity.
- Count MCP research tools.
- update cap banners, guard scorecards, and telemetry;
- improve configurable fingerprints.

Tests:

- local-read counting;
- external-research counting;
- MCP search counting;
- command counting;
- mutation counting;
- external-write counting;
- Memory-write counting;
- pagination and read-offset fingerprints.

### Phase 9 - Delegation controls

Tasks:

- Track role, tier, agent name, parent, and depth per session.
- Enforce maximum depth and allowed child relationships.
- Parse and validate `NEEDS_RESEARCH` responses.
- Extend the verified delegate tool with separate role and tier arguments.
- Keep raw recursive delegation disabled by default.

Tests:

- structured research response;
- malformed research response;
- maximum depth;
- self-delegation;
- denied role relationship;
- allowed implementation-to-research request;
- tier escalation without depth increase.

### Phase 10 - Verification and escalation integration

Tasks:

- propagate `AgentIdentity` through artefacts;
- preserve role through retries and escalation;
- rank graders by tier;
- use one configured ladder across delegate, native Task, and checker paths;
- filter unavailable tiers by role.

Tests:

- same-role escalation;
- producer/grader independence;
- composite agent ranking;
- missing higher tier;
- forcing-note agent name;
- cost and attempt termination.

### Phase 11 - Diagnostics and commands

Tasks:

- Add `/router diagnose`.
- Update `/tiers`, `/preset`, `/budget`, and plan annotation for role-tier identities.
- Ensure diagnostic output is deterministic and secret-free.

Tests:

- loaded source list;
- effective model and agent matrix;
- tool and MCP assignments;
- permissions and budgets;
- provenance display;
- legacy warning display.

### Phase 12 - Documentation

Tasks:

- Rewrite the README architecture overview.
- Add an OpenCode-Go configuration example.
- Document roles and tool policies.
- Document MCP setup without embedding server tokens, URLs, or processes in plugin code.
- Recommend GitHub read-only credentials and permissions.
- Document Memory read/write separation.
- Add a research-to-implementation-to-review workflow.
- Add `docs/CONFIGURATION.md` as the step-by-step configuration guide.
- Link `docs/CONFIGURATION.md` from the README.
- Update migration and stale enforcement documentation.

Acceptance criteria:

- Public documentation matches runtime behavior and shipped defaults.
- The configuration guide is included in the npm package.

### Phase 13 - Final validation

Run:

```bash
npm run typecheck
npm test
npm run test:coverage
npm run smoke
npm pack --dry-run
```

Smoke tests remain opt-in when they require a working OpenCode installation or provider. Any skipped smoke must be reported explicitly.

## 11. Planned File Changes

| File | Responsibility |
|------|----------------|
| `package.json` | Fork metadata, JSONC dependency, package contents |
| `tiers.json` | Bundled v2 defaults and OpenCode-Go preset |
| `src/router/config.ts` | Layered loading, provenance, validation |
| `src/router/normalize.ts` | Legacy and v2 normalization |
| `src/router/routing.ts` | Role and tier classification |
| `src/router/agents.ts` | Combined agent specification generation |
| `src/router/tool-policy.ts` | Pattern matching, MCP classification, role policy |
| `src/router/delegation.ts` | Depth, relationships, research requests |
| `src/router/sessions.ts` | Identity, depth, category counters |
| `src/router/protocol.ts` | Dynamic orchestration protocol |
| `src/guard/guards.ts` | Category-aware guard behavior |
| `src/guard/enforce.ts` | Role-policy enforcement wiring |
| `src/guard/fingerprint.ts` | Local and MCP fingerprints |
| `src/escalate/ladder.ts` | Tier-only ladder behavior |
| `src/verify/checker.ts` | Tier-based grader selection |
| `src/verify/dispatch.ts` | Identity propagation and mutation tracking |
| `src/index.ts` | Thin hook wiring and commands |
| `README.md` | Public architecture and setup |
| `docs/CONFIGURATION.md` | Step-by-step configuration guide |
| `docs/MIGRATION.md` | Legacy configuration migration |
| `test/unit/*` | Pure routing, config, policy, and budget tests |
| `test/integration/*` | Hook, permission, delegation, and diagnostics tests |

## 12. Global Safety Invariants

- Stronger models do not receive stronger permissions automatically.
- GitHub write tools are denied by default.
- Memory write tools are denied by default.
- External writes require explicit configuration.
- Deny rules win over allow rules inside router policy.
- Unknown tools are denied by default.
- Router allows never bypass OpenCode asks or denies.
- MCP servers remain configured and started by OpenCode.
- The plugin stores no MCP tokens, URLs, or process definitions.
- Roles do not self-delegate.
- The default delegation depth is one.
- Escalation preserves role.
- Runtime modules consume only normalized configuration.
- Diagnostics and telemetry never expose secrets.

## 13. Known Risks

| Risk | Mitigation |
|------|------------|
| OpenCode API changes across the broad peer range | Context-index current upstream source and retain real-OpenCode smoke tests |
| Agent permissions accidentally relax global policy | Generate restrictions only and enforce role policy before normal OpenCode permission resolution |
| Broad MCP read patterns include write tools | Evaluate explicit and configured write patterns before read patterns |
| Layered config errors point to the wrong file | Track field provenance during merge and include it in validation errors |
| Composite agent names break grader ranking | Pass role and tier separately; never rank the agent-name string |
| Recursive Task calls escape central orchestration | Default `permission.task` deny plus runtime depth and edge validation |
| Legacy prompt semantics conflict with new roles | Isolate legacy handling in normalization and hidden aliases |
| Documentation is omitted from npm | Update `package.json` files and packaging tests |
| Preset changes leave registered models stale | Preserve explicit restart diagnostics until dynamic re-registration is proven safe |

## 14. Completion Criteria

The fork is complete when:

- role and tier are independently selected;
- configured role-tier agents are generated correctly;
- all role tool policies are enforced independently of tier;
- default MCP assignments are present and overridable;
- GitHub and Memory reads and writes are separated;
- unknown tools fail closed;
- MCP calls consume configured budgets;
- escalation preserves role;
- delegation depth and relationships are enforced;
- old presets normalize successfully;
- `/router diagnose` explains the effective configuration;
- README links to `docs/CONFIGURATION.md`;
- typecheck, tests, coverage, packaging, and applicable smoke tests pass.

## 15. Implementation Model

Recommended implementation model: `openai/gpt-5.6-sol`, variant `medium`.

Reason: the work crosses configuration normalization, security-sensitive permissions, runtime session identity, verification, and backward compatibility, but can be delivered safely in small tested phases.
