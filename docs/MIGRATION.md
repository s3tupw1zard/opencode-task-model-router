# Migration guide

## Migrating from `opencode-model-router`

Replace the old package in your OpenCode plugin configuration rather than loading
both packages. The fork uses the npm package `opencode-task-model-router` and the
repository `https://github.com/s3tupw1zard/opencode-task-model-router`.

On first start, valid persisted selections are copied from
`~/.config/opencode/opencode-model-router.state.json` to
`~/.config/opencode/opencode-task-model-router.state.json`. The old file is never
modified or deleted, and an existing new state file always takes precedence.

Rename environment variables explicitly:

```text
MODEL_ROUTER_ENFORCE -> TASK_MODEL_ROUTER_ENFORCE
MODEL_ROUTER_VERIFIED_DELEGATE -> TASK_MODEL_ROUTER_VERIFIED_DELEGATE
MODEL_ROUTER_TRAJECTORY_DEBUG -> TASK_MODEL_ROUTER_TRAJECTORY_DEBUG
```

The old names are not aliases and no longer affect the fork unless an old variable
name is explicitly configured as a custom `enforcement.envGate`.

## Upgrading from earlier versions

Existing users get **no behaviour change** on upgrade. With no `enforcement` key in `tiers.json` the plugin defaults to `mode: "off"`: routing is byte-identical, zero additional prompt tokens are injected, and no new latency is introduced.

## Adopting enforcement

Start with **advisory mode** — it evaluates and surfaces guidance without ever blocking:

1. Add to `tiers.json`:

   ```json
   {
     "enforcement": { "mode": "advisory" }
   }
   ```

   Or set `TASK_MODEL_ROUTER_ENFORCE=1` in your environment to try it for a session.
   Or run `/router enforce advisory` from the chat.

2. Observe the banners and acceptance reports in the UI. Advisory mode never blocks; it is a safe middle step.

3. When ready, move to full enforcement:

   ```json
   {
     "enforcement": { "mode": "enforced" }
   }
   ```

   Or run `/router enforce enforced`.

See `docs/CONFIG_REFERENCE.md` for the full `enforcement` block schema.

> **Scope note:** enforcement applies only to subagent/delegate sessions. The orchestrator session is never hard-blocked regardless of mode.
