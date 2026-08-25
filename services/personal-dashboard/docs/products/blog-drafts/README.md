# Blog / Drafts Guide

The **Blog / Drafts** tab is a private writing workspace for local posts. It supports drafting, editing, publishing, archiving, deleting, filtering by status, tagging, and previewing sanitized Markdown.

## Where to find it

Open the dashboard and select **Blog / Drafts** from the top navigation.

## What it does

Blog / Drafts stores writing posts in the dashboard writing store. Each post has a title, status, optional tags, body content, and timestamps. The preview renders a safe Markdown view so you can check structure before publishing or archiving.

## How to use it

### Create a post

1. Open **Blog / Drafts**.
2. Select **New post**.
3. Enter a title, status, optional comma-separated tags, and body text.
4. Save the post.
5. Select the post in the list to preview it.

### Edit a post

1. Select an existing post from the list.
2. Open it in the editor.
3. Update the title, status, tags, or body.
4. Save the changes.

### Filter posts

Use the **Status** filter to show all posts or only **Drafts**, **Published**, or **Archived** posts. Use **Refresh** if another browser session may have changed the store.

### Delete a post

Open the post in the editor and use the delete control. Deletion removes the post from the writing store, so use archive when you want to preserve an old piece without showing it as active.

## Markdown and preview behavior

The body is Markdown-oriented. The dashboard preview is sanitized before rendering. That means normal headings, lists, links, and code blocks are intended to work, while unsafe HTML, script-like content, and private implementation details should not be used.

The rich authoring design for future enhancements keeps Markdown as the canonical format and adds only allowlisted embed blocks. Current user guidance should be based on the live Markdown workflow, not future design notes.

## Data source and freshness

Posts come from the dashboard writing store. The list refreshes when the tab loads, when you save changes, and when you press **Refresh**. Timestamps show when a post was created or updated according to the store.

## Empty and error states

- **No posts** means no writing posts match the current status filter.
- **Writing storage unavailable** means the dashboard cannot access its writing store.
- **Validation failed** usually means a required field is missing or a field is too large.
- A failed save should leave the editor open so you can copy your text before retrying.

## Known limitations

- This is a local dashboard writing tool, not a public blog publisher by itself.
- There is no collaborative editing or revision history in the current UI.
- Attachments may be displayed when present in stored content, but general media management is not a live feature yet.
- The preview is intentionally conservative; if something unsafe does not render, that is probably the guardrail doing its boring little job.

## Troubleshooting hints

- If a new post does not appear, clear the status filter or press **Refresh**.
- If preview formatting looks wrong, check Markdown syntax first.
- If saving fails, copy the body text locally before retrying.
- If storage remains unavailable, the dashboard runtime needs operator attention before edits will persist.
