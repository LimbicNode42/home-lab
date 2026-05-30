# hermes-discord — Discord Gateway Deployment

Hermes Agent running as a persistent Discord bot on the `critical` LXC
(192.168.0.50). The bot relays messages between Discord and the Hermes
gateway, and exposes native `/kanban` slash commands for managing the
homelab Kanban board from Discord.

## Status

Candidate desired-state seed — not yet applied to production.
Requires explicit approval before running `docker compose up -d`.

## Prerequisites

| Requirement | Notes |
|---|---|
| Docker Engine | Running on the critical LXC |
| `~/.hermes/` profile | kobold profile configured with LLM keys |
| Vaultwarden access | Local at http://192.168.0.50:8084 |
| Discord application | Bot token with correct scopes (see below) |
| Hermes image | Built locally or pulled — must match running digest |

## Discord Application Setup

1. Go to https://discord.com/developers/applications
2. Create a new Application, then create a Bot user.
3. Under Bot → Privileged Gateway Intents, enable:
   - Message Content Intent
   - Server Members Intent (optional — only needed for member-lookup commands)
4. Under OAuth2 → URL Generator, select scopes:
   - `bot`
   - `applications.commands`
5. Bot Permissions (minimum):
   - Send Messages
   - Read Message History
   - Embed Links
   - Use Slash Commands
6. Copy the Bot Token. Store it in Vaultwarden:
   - Folder: `homelab`
   - Item: `hermes/discord`
   - Field: `bot_token`

## Secrets Injection

All secrets come from Vaultwarden. Never commit `.env`.

```bash
# 1. Configure bw CLI
bw config server http://192.168.0.50:8084
bw login --apikey          # uses BW_CLIENTID + BW_CLIENTSECRET from env
BW_SESSION=$(bw unlock --passwordenv BW_PASSWORD --raw)
export BW_SESSION

# 2. Render .env (example — adapt field names to your Vaultwarden item)
cp env.example .env && chmod 600 .env
# Fill DISCORD_BOT_TOKEN, DISCORD_ALLOWED_USERS, DISCORD_HOME_CHANNEL, etc.
# See env.map.example for the Vaultwarden field mapping.
```

## Deployment (staging / first run)

```bash
cd /path/to/services/hermes-discord

# Verify current Hermes image digest from the running container (if any)
docker image inspect $(docker inspect hermes --format '{{.Image}}') \
  --format '{{index .RepoDigests 0}}'
# Update HERMES_IMAGE_DIGEST in .env

# Set UID/GID to the owner of the Hermes data directory
HERMES_UID=$(id -u) HERMES_GID=$(id -g) docker compose up -d

# Tail logs to verify connection
docker compose logs -f hermes-discord
```

Expected startup log lines (bot ready):
```
discord.py: Logged in as HermesBot
gateway: discord adapter started
gateway: slash commands synced (policy=safe)
```

## Health Check

The container uses a process-based health check:

```bash
docker inspect --format '{{.State.Health.Status}}' hermes-discord
# Expected: healthy
```

To manually test gateway responsiveness, send a DM or message to the bot
in an allowed channel. It should respond within a few seconds.

## Supported Discord Commands

The bot registers a `/kanban` command group with these subcommands:

| Command | Description |
|---|---|
| `/kanban list` | List Kanban tasks (filter by status/assignee) |
| `/kanban create <title>` | Create a new task |
| `/kanban show <id>` | Show task details and history |
| `/kanban assign <id> <profile>` | Assign task to a profile |
| `/kanban block <id> <reason>` | Block a task with a reason |
| `/kanban unblock <id>` | Unblock a blocked task |
| `/kanban complete <id> <summary>` | Mark a task done |
| `/kanban comment <id> <body>` | Add a comment to a task |
| `/kanban promote <id>` | Promote a todo task to ready |
| `/kanban archive <id>` | Archive a completed task |

Access is restricted to users listed in `DISCORD_ALLOWED_USERS`. Slash
commands can be hidden from non-admin guild members with
`DISCORD_HIDE_SLASH_COMMANDS=true`.

## Traefik / Homelab Networking

The Discord bot does NOT expose any inbound HTTP endpoints. It connects
outbound to Discord's WebSocket API only. No Traefik route or Cloudflare
Tunnel rule is needed.

If you later enable the Hermes API server (`API_SERVER_HOST` +
`API_SERVER_KEY`), treat it like the dashboard: bind to 127.0.0.1 and
tunnel via SSH, or add a Traefik route behind Cloudflare Access.

## Restart Policy

`restart: unless-stopped` — the container restarts automatically on crash
or host reboot, but NOT when you explicitly `docker compose stop` it.

## Updating the Bot

1. Build or pull a new Hermes image.
2. Resolve the new image digest and update `HERMES_IMAGE_DIGEST` in `.env`.
3. `docker compose pull && docker compose up -d --force-recreate`
4. Monitor logs: `docker compose logs -f hermes-discord`

## Rollback

```bash
# Stop the new container
docker compose down

# Restore the previous image digest in .env
# Then restart
docker compose up -d
```

## Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| Container exits immediately | Invalid `DISCORD_BOT_TOKEN` | Check token in Vaultwarden, re-render .env |
| `discord.errors.LoginFailure` | Wrong or revoked token | Regenerate token in Discord Developer Portal |
| Commands not appearing in Discord | Sync policy = `off` or first sync failed | Set `DISCORD_COMMAND_SYNC_POLICY=bulk`, restart once, then reset to `safe` |
| Commands appear but restricted users get errors | `DISCORD_ALLOWED_USERS` missing their ID | Add user ID(s) and restart |
| Gateway restarts every ~5 min | OOM — hitting memory limit | Increase `deploy.resources.limits.memory` |
| `/opt/data` permission errors | UID/GID mismatch | Recheck `HERMES_UID`/`HERMES_GID` match data dir owner |

## Security Notes

- `DISCORD_BOT_TOKEN` is the only inbound credential. Treat it like a password.
  Store exclusively in Vaultwarden; never commit to Git.
- Use `DISCORD_ALLOWED_USERS` in production. `DISCORD_ALLOW_ALL_USERS=true`
  allows any Discord user to invoke the bot — dev only.
- The gateway runs outbound-only to Discord. No ports are published unless
  you enable the API server.
- The dashboard binds to 127.0.0.1. Do not expose it on 0.0.0.0 — it stores
  LLM API keys.
- Review and rotate `DISCORD_BOT_TOKEN` if it is ever logged, committed, or
  shared outside Vaultwarden.

## File Manifest

```
services/hermes-discord/
├── README.md           ← this file
├── compose.yaml        ← Docker Compose service definition
├── env.example         ← env variable template (no secrets)
└── env.map.example     ← Vaultwarden field reference map
```
