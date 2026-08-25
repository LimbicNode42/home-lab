# Homelab Health Report Guide

The **Homelab Health** report is a compact operational health summary for the Wheeler network. It is meant to help spot obvious issues quickly: stale data, degraded services, backup gaps, failed units, high disk usage, and other action-oriented warnings.

## Where to find it

Open **Reports**, then look for the **Homelab Health** panel.

## What it does

The panel shows the latest generated homelab health report and a status badge. The badge summarizes the report state, while the body gives the current findings in plain text.

Common badge meanings:

- **OK** means the latest report did not surface known urgent issues.
- **Degraded** means the report found warnings or failures that should be reviewed.
- **Stale** means the dashboard has an old report and should not be treated as current.
- **Unavailable** means no usable report is available to display.

## How to use it

1. Open **Reports**.
2. Review the badge first.
3. Read the report body for specific findings.
4. Use **Refresh** to re-read the latest report artifact.
5. Treat degraded or stale results as prompts for operator follow-up, not as automatic remediation approval.

## Data source and freshness

The report is generated outside the dashboard by the homelab health reporting workflow. The dashboard reads the latest sanitized report from its runtime cache. Freshness text indicates when the dashboard believes the report was generated or updated.

If the report is stale, the dashboard may still be working correctly; the upstream reporting job or snapshot sync may be delayed.

## Empty and error states

- **No report yet**: the upstream report has not produced a usable artifact.
- **Stale report**: the report exists but is older than expected.
- **Unavailable**: the dashboard cannot read the report artifact.
- **Degraded**: the report loaded successfully and found issues.

## Known limitations

- The report is a summary, not a full observability stack.
- It depends on the coverage of the upstream probes. Unknown hosts or services may not appear.
- The dashboard does not fix issues from this panel. Destructive or high-blast-radius homelab changes still require explicit approval.

## Troubleshooting hints

- Press **Refresh** once before acting on a stale-looking panel.
- If the panel is unavailable but other dashboard features work, check the report-generation workflow and runtime snapshot sync.
- If the report is degraded, follow the linked runbook or task trail for the specific service rather than applying broad fixes blindly. Mystery state is not a maintenance strategy.
