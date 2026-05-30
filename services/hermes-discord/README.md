# hermes-discord — Discord Gateway and Kanban Bot

Hermes Agent runs as a persistent Discord bot on the `critical` LXC
(`192.168.0.50`). The bot connects outbound to Discord, relays messages
through the Hermes gateway, and exposes native `/kanban` slash commands for
managing the homelab Kanban board from Discord.

This service is intentionally boring: no public HTTP route, no Cloudflare
Tunnel rule, no Traefik frontend. It is a Discord WebSocket client with a
mounted Hermes profile and a Docker health check. Boring is where uptime
keeps its socks.

## Status

Candidate desired-state seed — not yet applied to production.
Requires explicit approval before running `docker compose up -d`.

## Files

```text
services/hermes-discord/
├── README.md           # this runbook
├── compose.yaml        # Docker Compose service definition
├── env.example         # environment template, no secrets
└── env.map.example     # Vaultwarden item/field reference map, no secrets
```

## Architecture

```text
Discord client
    ↓ slash commands / messages
Discord API + Gateway WebSocket
    ↓ outbound connection from critical LXC
hermes-discord container
    ↓ mounted profile at /opt/data
Hermes gateway + Kanban board SQLite
```

Key implementation points from the handoffs:

- The Discord adapter registers a native `/kanban` command group with
  structured Discord fields.
- `/kanban` commands route through the existing Hermes gateway slash-command
  path, not a separate API server.
- Board selection, user authorization, subscriptions, logging, and error
  handling stay consistent with normal Hermes `/kanban ...` commands.
- `DISCORD_BOT_TOKEN` is the only Discord credential needed by this service.
- The deployment uses `network_mode: host` so the gateway can reach LAN-only
  homelab services such as Vaultwarden, Proxmox, and the NAS.

## Prerequisites

| Requirement | Notes |
|---|---|
| Docker Engine | Running on the `critical` LXC |
| Hermes data/profile directory | Mounted into the container as `/opt/data`; defaults to `/opt/hermes-data` |
| Configured Hermes profile | LLM credentials, Kanban board, gateway config, skills, and memory live under the mounted data directory |
| Vaultwarden access | Local URL: `http://192.168.0.50:8084` |
| Discord application and bot | Created in the Discord Developer Portal |
| Hermes image | Built locally or pulled and pinned by digest |
| Operator approval | Required before first production `docker compose up -d` |

## Discord application setup

### 1. Create the application

1. Open https://discord.com/developers/applications.
2. Select **New Application**.
3. Name it something obvious, for example `Hermes Homelab`.
4. Save the **Application ID**. It is needed if you build the invite URL
   manually.

### 2. Create and configure the bot user

1. Open the application, then go to **Bot**.
2. Create the bot if Discord has not created one automatically.
3. Under **Authorization Flow**:
   - **Public Bot** may be ON if you want Discord to generate an install link.
   - **Require OAuth2 Code Grant** should be OFF.
4. Under **Privileged Gateway Intents**, enable:
   - **Message Content Intent** — required for normal message handling.
   - **Server Members Intent** — recommended; required if you authorize via
     Discord roles or need member lookup.
5. Save changes.

If the bot is online but cannot read what you type, check Message Content
Intent first. It is the usual culprit, with all the subtlety of a rake in the
grass.

### 3. Create the bot token

1. Stay on **Bot**.
2. Under **Token**, select **Reset Token**.
3. Copy the token immediately. Discord only shows it once.
4. Store it in Vaultwarden; do not paste it into Git, chat, issue trackers, or
   shell history.

Homelab convention:

```text
Vaultwarden URL: http://192.168.0.50:8084
Folder: homelab
Item: hermes/discord
Field: bot_token
```

### 4. Invite the bot to the server

Use either the Developer Portal **Installation** tab or a manual OAuth2 URL.

Required scopes:

```text
bot
applications.commands
```

Recommended bot permissions:

| Permission | Why |
|---|---|
| View Channels | See channels where it is installed |
| Send Messages | Reply to messages and command results |
| Read Message History | Preserve context and support history backfill |
| Embed Links | Format rich responses |
| Attach Files | Send generated files or media from Hermes |
| Send Messages in Threads | Reply inside Discord threads |
| Add Reactions | Processing/success/error reactions |
| Use Slash Commands | Required for native commands in Discord UI |

Manual invite URL template:

```text
https://discord.com/oauth2/authorize?client_id=YOUR_APPLICATION_ID&scope=bot+applications.commands&permissions=274878286912
```

Replace `YOUR_APPLICATION_ID` with the Application ID from the Developer
Portal.

Minimum practical permission integer:

```text
274878286912
```

This matches the broader Hermes Discord recommendation: messages, embeds,
attachments, thread replies, history, and reactions. You can tighten channel
visibility at the Discord role/channel level after the bot is installed.

## Hermes and Docker configuration

### Environment variables

Copy `env.example` to `.env`, fill it from Vaultwarden/profile data, and keep
mode `0600`.

Required:

| Variable | Source | Notes |
|---|---|---|
| `DISCORD_BOT_TOKEN` | Vaultwarden `homelab` / `hermes/discord` / `bot_token` | Secret; required |
| `HERMES_IMAGE_DIGEST` | Docker image inspection | Pin to a known Hermes image digest before production apply |
| `HERMES_DATA_DIR` | Operator choice | Host path mounted to `/opt/data` |
| `HERMES_UID` / `HERMES_GID` | Host owner of `HERMES_DATA_DIR` | Avoids profile permission errors |

Recommended:

| Variable | Source | Notes |
|---|---|---|
| `DISCORD_ALLOWED_USERS` | Discord user IDs | Comma-separated allowlist. Production should set this. |
| `DISCORD_HOME_CHANNEL` | Discord channel ID | Default delivery target for cron/Kanban notifications. |
| `DISCORD_ALLOWED_CHANNELS` | Discord channel IDs | Optional channel allowlist for messages and slash commands. |
| `DISCORD_COMMAND_SYNC_POLICY` | `safe` | `safe` diffs commands and syncs only changes; `bulk` resets; `off` disables sync. |
| `DISCORD_HIDE_SLASH_COMMANDS` | `false` by default | If `true`, hides slash commands from non-admin guild members. Server-side auth still applies. |

Optional LLM provider variables such as `OPENAI_API_KEY` or
`ANTHROPIC_API_KEY` are only needed in `.env` if the mounted Hermes profile
does not already provide them. Keep provider credentials in the Hermes profile
or Vaultwarden; do not duplicate secrets casually.

### Vaultwarden reference map

`env.map.example` documents the intended secret references without storing the
values:

```text
homelab / hermes/discord / bot_token        -> DISCORD_BOT_TOKEN
homelab / hermes/discord / allowed_users    -> DISCORD_ALLOWED_USERS
homelab / hermes/discord / home_channel_id  -> DISCORD_HOME_CHANNEL
homelab / hermes/discord / image_digest     -> HERMES_IMAGE_DIGEST
```

Example retrieval pattern, adapted per operator environment:

```bash
bw config server http://192.168.0.50:8084
bw login --apikey
BW_SESSION=$(bw unlock --passwordenv BW_PASSWORD --raw)
export BW_SESSION

cp env.example .env
chmod 600 .env
# Fill values from Vaultwarden. Do not commit .env.
```

## Startup instructions

Run on the `critical` LXC after explicit approval.

```bash
cd /path/to/services/hermes-discord

# Verify or resolve the image digest from an existing Hermes image/container.
docker image inspect "$(docker inspect hermes --format '{{.Image}}')" \
  --format '{{index .RepoDigests 0}}'

# Update HERMES_IMAGE_DIGEST in .env, then start.
HERMES_UID=$(id -u) HERMES_GID=$(id -g) docker compose up -d

# Watch startup.
docker compose logs -f hermes-discord
```

Expected signs of life:

```text
discord.py: Logged in as HermesBot
gateway: discord adapter started
gateway: slash commands synced (policy=safe)
```

Health check:

```bash
docker inspect --format '{{.State.Health.Status}}' hermes-discord
# Expected: healthy
```

Manual smoke test:

1. Send the bot a DM, or mention it in an allowed server channel.
2. Run `/kanban list` in an allowed channel.
3. Confirm a Discord response arrives and the container logs show the command.

## Updating and rollback

Update:

```bash
cd /path/to/services/hermes-discord
# Build or pull the new Hermes image first.
# Resolve the new digest and update HERMES_IMAGE_DIGEST in .env.
docker compose pull
docker compose up -d --force-recreate
docker compose logs -f hermes-discord
```

Rollback:

```bash
cd /path/to/services/hermes-discord
docker compose down
# Restore the previous HERMES_IMAGE_DIGEST in .env.
docker compose up -d
docker compose logs -f hermes-discord
```

## Supported `/kanban` commands

The bot registers a native Discord command group. Discord shows fields for the
options, but the behavior maps to the normal Hermes Kanban CLI/slash commands.

| Command | Important fields | Example | Result |
|---|---|---|---|
| `/kanban list` | `status`, `assignee`, `mine`, `archived` | `/kanban list status:blocked assignee:scribe` | Lists matching cards |
| `/kanban create` | `title`, `assignee`, `body`, `priority`, `triage` | `/kanban create title:"Patch NAS docs" assignee:scribe body:"Write rollback steps" priority:5` | Creates a Kanban card |
| `/kanban show` | `task_id` | `/kanban show task_id:t_abc123` | Shows card details, history, comments |
| `/kanban assign` | `task_id`, `profile` | `/kanban assign task_id:t_abc123 profile:gremlin` | Reassigns a card |
| `/kanban block` | `task_id`, `reason` | `/kanban block task_id:t_abc123 reason:"Need Vaultwarden item name"` | Marks a card blocked |
| `/kanban unblock` | `task_id` | `/kanban unblock task_id:t_abc123` | Returns a blocked/scheduled card to ready |
| `/kanban complete` | `task_id`, `result` | `/kanban complete task_id:t_abc123 result:"Docs updated"` | Marks a card done |
| `/kanban comment` | `task_id`, `text` | `/kanban comment task_id:t_abc123 text:"Use NAS path /mnt/nas/services"` | Adds an audit-trail comment |
| `/kanban promote` | `task_id`, `reason`, `force` | `/kanban promote task_id:t_abc123 reason:"Ready for worker"` | Promotes a card to ready; `force` bypasses incomplete-parent checks |
| `/kanban archive` | `task_id` | `/kanban archive task_id:t_abc123` | Archives a completed card |

Notes:

- `assignee` is a Hermes profile name, such as `scribe`, `gremlin`, or another
  configured worker profile.
- `complete` from Discord accepts a human-readable `result`. It does not expose
  the full structured worker handoff fields that dispatcher-spawned workers use.
- `promote force:true` should be rare. It bypasses dependency hygiene; use it
  only when you know why the parents can be ignored.
- Command text fields are shell-quoted internally before routing through the
  existing `/kanban` slash handler, so spaces in titles, bodies, and comments
  are safe.

## End-to-end Discord Kanban example

Goal: create a documentation card, add context, block it while waiting for a
human answer, then unblock and complete it.

1. Create the card:

   ```text
   /kanban create title:"Document Vaultwarden backup restore" assignee:scribe body:"Write operator steps for restoring the Vaultwarden volume from NAS backup." priority:5
   ```

   Discord returns a new task ID, for example:

   ```text
   Created task t_ab12cd34: Document Vaultwarden backup restore
   ```

2. Inspect it:

   ```text
   /kanban show task_id:t_ab12cd34
   ```

3. Add useful context:

   ```text
   /kanban comment task_id:t_ab12cd34 text:"Source volume is under /mnt/nas/services/vaultwarden; preserve existing database and users."
   ```

4. Block it because a human decision is needed:

   ```text
   /kanban block task_id:t_ab12cd34 reason:"Need operator to confirm which NAS snapshot is the restore source."
   ```

5. After the answer arrives, unblock it:

   ```text
   /kanban unblock task_id:t_ab12cd34
   ```

6. List ready work for the assignee:

   ```text
   /kanban list status:ready assignee:scribe
   ```

7. If the work is manual and finished from Discord, complete it:

   ```text
   /kanban complete task_id:t_ab12cd34 result:"Restore runbook added and checked against current NAS paths."
   ```

For code or infrastructure changes that still need review, prefer adding a
comment with the review handoff and blocking with a `review-required:` reason
instead of completing directly. The board is an audit trail, not a wish-granting
fog machine.

## Operator workflow notes

- Use Discord for quick triage and status changes.
- Use dispatcher-spawned workers for substantive implementation, research, or
  documentation work.
- Treat `/kanban complete` in Discord as an operator action, not a substitute for
  a structured worker completion.
- Keep card comments short and durable. Put decisions and source paths there;
  avoid dumping secrets or one-off scratch notes.
- If commands do not appear immediately after startup, Discord global slash
  command propagation can lag. Use `DISCORD_COMMAND_SYNC_POLICY=bulk` once to
  reset, then return to `safe`.

## Security notes

- `DISCORD_BOT_TOKEN` controls the bot account. Store it only in Vaultwarden or
  the runtime `.env`; never commit it.
- Production should use `DISCORD_ALLOWED_USERS`, `DISCORD_ALLOWED_ROLES`, or
  both. Do not use `DISCORD_ALLOW_ALL_USERS=true` outside development.
- `DISCORD_ALLOWED_CHANNELS` can limit where slash commands and messages are
  accepted, but it is not a replacement for user/role authorization.
- `DISCORD_HIDE_SLASH_COMMANDS=true` hides commands from non-admin guild members;
  it is UX hardening, not the primary security boundary.
- Keep Discord role/channel permissions narrow. If a channel can see the bot and
  an allowed user invokes it there, that channel may see the result.
- Do not put secrets in Kanban card titles, bodies, comments, or completion
  results. Board rows and Discord messages are durable.
- The container publishes no inbound service by default. If you later enable the
  Hermes API server, bind it to `127.0.0.1` and put access control in front of
  it before any remote exposure.
- The optional dashboard is bound to `127.0.0.1`; do not expose it on
  `0.0.0.0` because Hermes profile data can include API keys.
- Rotate `DISCORD_BOT_TOKEN` immediately if it appears in logs, Git, screenshots,
  or any shared transcript.

## Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| Bot is offline in Discord | Container not running or token login failed | `docker compose ps`; then `docker compose logs hermes-discord` |
| `discord.errors.LoginFailure` | Bad, revoked, or copied-wrong token | Reset token in Developer Portal, update Vaultwarden and `.env`, restart |
| Bot is online but ignores messages | Message Content Intent disabled, user not allowed, channel not allowed, or mention policy | Enable intent; check `DISCORD_ALLOWED_USERS`; check `DISCORD_ALLOWED_CHANNELS`; mention the bot in server channels |
| DMs work but server channel messages do not | Missing channel permissions or mention required | Grant View/Send/Read History; mention the bot or configure free-response channels in Hermes profile |
| `/kanban` does not appear | Slash command sync disabled/failed or Discord propagation delay | Set `DISCORD_COMMAND_SYNC_POLICY=bulk`, restart once, then set back to `safe` |
| `/kanban` appears but errors on use | User/channel authorization denies it or Kanban board unavailable | Check allowed users/channels and gateway logs; verify mounted profile includes the Kanban board |
| Commands visible to too many users | Discovery visibility not restricted | Set `DISCORD_HIDE_SLASH_COMMANDS=true` and tighten Discord channel permissions; keep server-side allowlists anyway |
| Container restarts repeatedly | OOM, bad profile config, or dependency failure | Inspect logs; increase memory limit; verify mounted `/opt/data` profile |
| `/opt/data` permission errors | `HERMES_UID`/`HERMES_GID` mismatch | Set UID/GID to the owner of `HERMES_DATA_DIR`, then recreate container |
| No proactive notifications | `DISCORD_HOME_CHANNEL` missing or wrong | Copy channel ID with Discord Developer Mode and update `.env` |
| Dashboard inaccessible remotely | It binds to localhost by design | Use SSH tunnel: `ssh -L 9119:localhost:9119 user@192.168.0.50` |

## Verification checklist

Before declaring the bot production-ready:

- [ ] Discord application created and bot invited with `bot` and
      `applications.commands` scopes.
- [ ] Message Content Intent enabled.
- [ ] Bot token stored in Vaultwarden, not Git.
- [ ] `.env` exists on the host with mode `0600`.
- [ ] `HERMES_IMAGE_DIGEST` pinned to the intended image.
- [ ] `HERMES_DATA_DIR` points at the expected Hermes data/profile directory.
- [ ] `DISCORD_ALLOWED_USERS` and/or `DISCORD_ALLOWED_ROLES` configured.
- [ ] Optional `DISCORD_ALLOWED_CHANNELS` configured if the bot should be
      limited to specific channels.
- [ ] `docker compose up -d` approved and run.
- [ ] Health check reports `healthy`.
- [ ] `/kanban list` works from an allowed Discord channel.
- [ ] End-to-end card lifecycle tested: create → show → comment/block → unblock
      → complete or hand off to a worker.
