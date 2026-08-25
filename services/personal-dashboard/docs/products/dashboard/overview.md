# Dashboard Overview

The Home Dashboard is a private household dashboard for the Wheeler network. It collects the current user-facing tools in one place: service status, household links, documentation, completed project summaries, reports, investment screening output, writing drafts, and private Diary & Goals records.

## What it does

The dashboard provides a single authenticated place to check high-level homelab status, open curated household links, read approved documentation, review generated reports, browse screener output, manage writing drafts, and record private diary and goal information.

## Where to find it

Open the dashboard and use the top navigation tabs:

- **Overview** for homelab status cards and curated links.
- **Knowledge** for the Documentation reader and Completed Epics.
- **Blog / Drafts** for local writing posts and drafts.
- **Reports** for Finnick and Homelab Health reports.
- **Investment Screener** for the latest value-growth screener output.
- **Diary & Goals** for private goal tracking and diary entries.

The old direct links for separate Diary and Goals views redirect to the merged **Diary & Goals** tab. There is no current Work or Kanban board tab in the dashboard.

## Overview status cards

The **Homelab status** section shows configured service checks. Each card represents a service the dashboard is allowed to probe from the server side.

How to use it:

1. Open **Overview**.
2. Review each status card.
3. Use **Refresh** when you want the dashboard to re-check the configured services.
4. Use the card's **Open** link when you want to visit the public or household-safe service URL.

Status meanings:

- **OK** means the latest server-side check succeeded.
- **Degraded** or **Error** means the service did not respond as expected.
- **Unknown** means the dashboard has not received a usable result yet.

The dashboard hides internal probe targets from the browser. The visible link is the safe display URL, not necessarily the address used for the server-side check.

## Links

The **Links** section is a curated launchpad. Link groups are maintained in the dashboard's approved public configuration and are intended for household-safe destinations. If a link is missing or outdated, treat it as a curation issue rather than proof that the service itself is down.

## Data source and freshness

Status results come from the dashboard server's configured service checks. Results may be cached briefly to avoid hammering services every time a page refreshes. Use the **Refresh** button when you want a current read. Link data comes from the committed dashboard configuration served through the authenticated API.

## Empty and error states

- If status cards keep showing a loading or unavailable state, the dashboard may be unable to reach its configured status source.
- If links are missing, the public dashboard config may not include them yet.
- If the whole dashboard asks for authentication or returns an access error, sign in through the configured access layer and reload.

## Known limitations

- The dashboard is not a full monitoring system. It is a compact status and navigation surface.
- Status checks prove only that the configured probe worked recently; they do not guarantee every feature inside a service is healthy.
- Internal network addresses, private paths, and secret-bearing configuration are deliberately not shown in the browser.

## Troubleshooting hints

- Use **Refresh** first; the previous result may simply be cached or stale.
- If one service is degraded but others are fine, open that service's public URL from the card and compare the result.
- If every status card fails, suspect the dashboard's own runtime or network access before blaming each service individually. Very efficient paranoia, but still paranoia.
