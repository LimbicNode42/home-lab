# Delivery conventions

Status: active delivery policy for Kanban and agent-built homelab work.

This repository is Ben's non-secret source of truth. Work is not just "done" because code merged, a container started, or a one-off command returned zero. If an agent builds or deploys a user-facing or homelab-facing capability, the delivery must leave a visible operational signal where Ben will actually see it.

## Dashboard completion visibility

For implementation epics that build, deploy, or materially change a live/user-facing capability, every task decomposition must include one of these outcomes by default:

1. Add or update Home Dashboard feedback that helps Ben see completion, freshness, reachability, or next action.
2. Add or update an equivalent status/docs/report surface if the Home Dashboard is not the right place.
3. Explicitly record why no dashboard/status surface is useful for this task.

Purely internal refactors do not need dashboard UI changes by default. They still need the usual tests, review notes, and handoff. Add dashboard feedback only when the refactor creates a user-facing operational signal worth showing, such as changed job health, deploy status, data freshness, backup coverage, or a new link Ben needs to use.

## Required acceptance-criteria check

When creating Kanban implementation cards, include a "completion visibility" acceptance criterion:

```text
Completion visibility: add/update a Home Dashboard/status/docs/report surface for the delivered capability, or document why not applicable.
```

When live dashboard changes are in scope, the task graph must also include deploy and post-deploy verification work. At minimum, specify:

- where the dashboard signal will appear;
- what data source or endpoint proves the capability is current;
- what local test verifies rendering or API behavior;
- what live deploy step is required, if any;
- what post-deploy check proves Ben can see the signal from the intended route.

## Examples

| Work type | Expected completion visibility |
| --- | --- |
| MCP aggregator or gateway | Overview status card with gateway health, configured endpoint/link, and last-known server/tool count. |
| Mobile/Flutter workflow | Overview status card showing emulator/toolchain availability, last workflow check, and link to the runbook or build artifact. |
| Data pipelines | Freshness, coverage, and report widgets showing last run, data-as-of timestamp, record counts, and gaps/caveats. |
| Background jobs or scheduled reports | Last run, last status, next run if known, and delivery target such as Discord, Slack, or a committed report path. |
| Documentation-only/research handoff | Committed docs link in the Documentation or Completed Epics surface when it is useful to revisit; otherwise a handoff explaining why dashboard UI is not warranted. |
| Internal refactor with no operator signal | Explicit "not applicable" rationale in the card/handoff, plus normal tests. No dashboard busywork. The dashboard is a dashboard, not a trophy cabinet. |

## Decomposition rule

Orchestrator/planner tasks must decide this before fanning work out. Do not let separate implementation cards independently invent incompatible dashboard surfaces for the same feature. The card body should name the expected surface and the verification route, or state "completion visibility: not applicable" with a short rationale.

## Worker handoff rule

Implementation handoffs should report the completion-visibility outcome in metadata. Good shapes:

```json
{
  "completion_visibility": {
    "surface": "Home Dashboard Overview",
    "status": "added",
    "verification": ["npm test", "curl https://dashboard.example/healthz"]
  }
}
```

or:

```json
{
  "completion_visibility": {
    "status": "not_applicable",
    "rationale": "Internal test harness refactor; no changed live capability or operator-facing signal."
  }
}
```

## Safety boundary

Dashboard deploys are live homelab changes when they alter the running dashboard, reverse proxy, Cloudflare route, secrets, or scheduled jobs. Follow the normal homelab safety policy: document intended commands, avoid secrets in Git, and require explicit approval before live mutations with meaningful blast radius.
