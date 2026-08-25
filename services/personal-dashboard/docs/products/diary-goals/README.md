# Diary & Goals Guide

The **Diary & Goals** tab is a private personal-data workspace. Goals are shown first, followed by diary entries. Diary entries can link to goals so later reviews can connect day-to-day notes with longer-running aims.

## What it does

The tab combines goal tracking and diary capture in one authenticated view. Goals describe longer-running aims; diary entries capture dated notes and can link back to relevant goals.

## Where to find it

Open the dashboard and select **Diary & Goals**. Old direct links for the separate Diary and Goals tabs route to this merged tab.

## Goals

Goals track work or personal aims through a simple lifecycle:

- **Active**: currently being worked on.
- **Paused**: intentionally not active right now.
- **Completed**: done.
- **Archived**: retained for history but not active.

### Create or update a goal

1. Open **Diary & Goals**.
2. Fill in the goal title.
3. Optionally add details.
4. Choose a status.
5. Save the goal.
6. Select a goal from the list to view it or load it back into the form for editing.

Use the status filter to narrow the goal list. The dashboard does not provide hard delete for goals in the current UI; archive old goals instead.

## Diary entries

Diary entries capture dated notes. Each entry has a date, optional title, optional mood, body text, and optional linked goals.

### Create a diary entry

1. Open **Diary & Goals**.
2. Fill in the diary date and body.
3. Add an optional title or mood.
4. Select any related goals.
5. Save the entry.
6. Select it from the list to view the detail card and linked goals.

The current UI focuses on create and read behavior for diary entries. Editing, deleting, export, and automated assessment are not live features.

## Data source and freshness

Diary and goal records are stored in the dashboard's configured personal data store. Lists refresh when the tab loads, after saves, and when you press the relevant **Refresh** buttons.

If the personal data store is not configured or unavailable, the dashboard shows a safe error instead of creating data in an unexpected fallback location.

## Empty and error states

- **No goals** means no goals match the current filter.
- **No diary entries** means no entries are available for the current list view.
- **Personal data store unavailable** means the dashboard cannot reach its private store.
- **Validation failed** means required fields are missing, values are too large, or linked goals are invalid.

## Privacy and safety

Diary and Goals are authenticated dashboard features. The browser should not expose connection strings, private storage paths, or low-level store errors. Do not paste secrets, recovery phrases, private keys, or raw credentials into diary entries. Private does not mean magic.

## Known limitations

- No hard delete for goals in the current UI.
- No diary edit/delete/export in the current UI.
- No LLM scoring or assessment is live in the MVP.
- Linked goals are for context, not automated judgement.

## Troubleshooting hints

- If the old Diary or Goals link does not show the expected screen, use **Diary & Goals** from the tab bar.
- If a linked goal cannot be saved, refresh the goal list and confirm the goal still exists.
- If storage is unavailable, do not keep retrying with sensitive text in the form; copy the entry locally and ask for operator follow-up.
