# Graphiti curated ingest, redaction, grouping, and cost-control policy

Status: production ingest policy for the Graphiti/Neo4j shared operational/provenance graph layer.

This policy gates broad ingest automation. It is not a live-deploy approval and does not change Hermes' active memory provider. mem0 remains the active personal/preference memory provider; Graphiti is an optional shared operational/provenance graph used only through curated ingest and read-only/provenance-safe query paths.

Related evidence:

- Final recommendation artifact: `/root/.hermes/kanban/attachments/t_0a509175/GRAPHITI_NEO4J_FINAL_RECOMMENDATION.md`
- Spike report: `/root/.hermes/kanban/attachments/t_6296cbe7/SPIKE_REPORT.md`
- Production architecture spec: `services/graphiti/runbooks/production-architecture-rollout.md`
- Read-only wrapper contract: `services/graphiti/runbooks/read-only-agent-wrapper.md`

## 1. Production ingest stance

Graphiti ingest is allowlist-first. If a source type is not listed as allowed here, it is excluded until a later reviewed policy update adds it.

Default behavior:

1. Extract only curated operational episodes.
2. Redact before sending content to Graphiti/OpenRouter.
3. Store source/provenance and caveats with every episode.
4. Group episodes by domain and operational boundary.
5. Treat `invalid_at` and derived temporal relationships as advisory until reviewed.
6. Keep cost controls conservative until real deployment metrics exist.
7. Never expose raw write/delete/clear Graphiti endpoints to agents.

Graphiti is allowed to be useful. It is not allowed to become a hungry transcript swamp with a Bolt port.

## 2. Allowed first-episode sources

The first production seed set may include only the following source classes after review/redaction:

| Source class | Allowed content | Required provenance |
|---|---|---|
| Kanban completion summaries | Final `summary`, selected non-secret `metadata`, decisions, changed-file lists, test/validation summaries | task id, title, assignee/profile, completed timestamp, parent/child relationship if relevant |
| Deployment summaries | What changed, where, verification receipts, rollback note, operator-visible status | repo path/commit or runbook path, service name, environment, timestamp |
| Incident summaries | Symptoms, affected services, evidence, remediation, rollback, residual risk, follow-up | incident note path or task id, start/end or observed timestamps, affected systems |
| Service inventory snapshots | Host/service names, non-secret ports, ownership, dependency relationships, backup status | snapshot path, capture timestamp, source command/tool name if safe |
| Dependency and ownership notes | Service dependencies, owners, runbook locations, backup/restore ownership | source doc path or task id, timestamp or document revision |
| Explicit decisions and supersessions | Architecture choices, approvals, deferrals, superseded prior choices, rejection rationale | decision source, date, supersedes/superseded_by links where known |

Allowed source classes still require the redaction checklist in section 4. An allowed source containing prohibited data is not allowed until sanitized. This sentence exists because computers are very literal and apparently need parenting.

## 3. Prohibited and default-excluded data

Never ingest these by default:

- raw secrets or secret-like values
- API keys, OAuth tokens, Bitwarden/Vaultwarden sessions, cookies, private keys, passphrases, passwords, recovery codes, connection strings containing credentials
- rendered `.env` files, token-bearing config, dashboard internals, log dumps, or backup manifests containing secret material
- raw private memories from mem0 or any future personal/preference memory provider
- raw transcripts, chat exports, browser histories, or unreviewed bulk session-search output
- unreviewed bulk logs, especially auth logs, proxy logs, debug traces, request/response captures, or stack traces with headers/env
- database dumps, Neo4j exports, Vaultwarden exports, password-manager exports, browser profile data, NAS share raw trees
- raw PII beyond stable operational identifiers required for service ownership; prefer role/service names over human personal details
- credentials embedded in URLs, shell history, command transcripts, or screenshots
- dashboard JSON or UI payloads that include internal route/token details not intended for graph users
- destructive-operation receipts that include one-time tokens or privileged commands with secrets

Bulk ingest is excluded until a separate review proves that the extractor, redactor, grouping rules, spend controls, and provenance wrapper all work on representative data. "Representative" does not mean "all of `/var/log` because it was sitting there looking ingestible."

## 4. Redaction and sanitization policy

### 4.1 Required redaction transforms

Before ingest, normalize or remove:

| Data shape | Required transform |
|---|---|
| API keys/tokens/session ids/cookies | replace with `[REDACTED_SECRET]`; preserve only secret manager reference if needed |
| Passwords/passphrases/recovery codes | replace with `[REDACTED_SECRET]`; do not preserve length/prefix/suffix |
| Private keys/cert key material | replace with `[REDACTED_PRIVATE_KEY]` |
| Credentialed URLs | replace userinfo with `[REDACTED_CREDENTIAL]` or remove URL entirely |
| Vaultwarden/Bitwarden values | replace with folder/item/field reference only |
| Email addresses/phone numbers not operationally required | replace with role or `[REDACTED_CONTACT]` |
| Personal/private memory text | exclude, not redact-in-place, unless Ben explicitly promotes a non-private operational fact |
| Raw stack traces/log excerpts | summarize the error and evidence; keep file/function names only when useful and non-sensitive |
| Dashboard/internal payloads | summarize status fields; exclude tokens, internal auth headers, raw payloads, and private routes |
| IP addresses/hostnames | keep homelab operational IPs/hostnames only when needed for topology; exclude third-party/client IPs by default |

### 4.2 Pre-ingest checklist

Every curated episode must pass this checklist:

- [ ] Source class is allowed by section 2.
- [ ] Source is reduced to an episode summary, not copied wholesale.
- [ ] No raw secret values, tokens, keys, cookies, passwords, recovery codes, or credentialed URLs remain.
- [ ] No raw private memories or raw transcripts remain.
- [ ] Vaultwarden references use folder/item/field names only.
- [ ] Operational IPs/hostnames are necessary for topology or incident context.
- [ ] Episode has source id/path, source timestamp, ingest timestamp, curation author/profile, and domain/group.
- [ ] Episode states whether facts are current, historical, superseded, or uncertain.
- [ ] Episode includes caveats for inferred, stale, or externally-unverified claims.
- [ ] Episode is small enough to review manually before ingest.

### 4.3 Redaction test checklist

Before automation expands beyond manual seed ingest, the ingest wrapper must include tests or fixtures covering:

- [ ] OpenRouter/Neo4j/Vaultwarden credential-shaped strings are blocked or redacted.
- [ ] `OPENROUTER_API_KEY`, `NEO4J_PASSWORD`, `BW_SESSION`, `BW_CLIENTSECRET`, and similar env names cannot pass with values.
- [ ] Private-key blocks are blocked.
- [ ] Credentialed URLs are blocked or normalized.
- [ ] Raw `.env` content is rejected.
- [ ] Raw transcript/session exports are rejected unless explicitly marked as curated excerpts.
- [ ] Kanban summaries with safe metadata pass.
- [ ] Vaultwarden folder/item/field references pass without values.
- [ ] Redaction logs record counts/categories, not secret values.

## 5. Episode format contract

Each curated episode should be represented as a small structured object before being sent to Graphiti. Suggested non-secret shape:

```json
{
  "episode_id": "kanban:t_12345678:completion",
  "title": "Deploy read-only Graphiti wrapper",
  "domain": "services",
  "group_id": "services.graphiti",
  "source_type": "kanban_completion_summary",
  "source_ref": "t_12345678",
  "source_path": null,
  "source_timestamp": "2026-09-30T00:00:00Z",
  "curated_by": "scribe",
  "curated_at": "2026-09-30T00:05:00Z",
  "status": "current|historical|superseded|uncertain",
  "summary": "Non-secret operational summary.",
  "facts": [
    {
      "text": "Graphiti is advisory and does not replace mem0.",
      "confidence": "high",
      "caveat": "Policy fact; not a live service health claim.",
      "valid_at": "2026-09-30T00:00:00Z",
      "invalid_at": null,
      "supersedes": []
    }
  ],
  "tags": ["graphiti", "policy"],
  "redaction": {
    "reviewed": true,
    "secret_values_removed": true,
    "private_memory_excluded": true
  }
}
```

Do not include raw source bodies in the episode object. Store source references; keep originals in their existing systems.

## 6. Grouping and domain strategy

Use stable group ids so the read-only wrapper can query by operational boundary without dumping unrelated graph context into an agent prompt.

### 6.1 Primary domains

| Domain | Group id pattern | Use for |
|---|---|---|
| `homelab` | `homelab.<area>` | cluster topology, host facts, storage, network, backup coverage |
| `agents` | `agents.<profile-or-system>` | profile roles, orchestration decisions, agent-facing tool boundaries |
| `services` | `services.<service-name>` | service lifecycle, dependencies, runbooks, deployment and restore evidence |
| `incidents` | `incidents.<service-or-system>.<yyyy-mm>` | symptoms, evidence, remediation, rollback, residual risk |
| `decisions` | `decisions.<area>` | architecture choices, supersessions, explicit approvals/deferrals |

Initial recommended groups:

- `services.graphiti`
- `decisions.graphiti-memory-boundary`
- `homelab.nippon-quorum`
- `homelab.emperor-critical`
- `services.vaultwarden`
- `services.jellyfin`
- `agents.mobile-review-surface`
- `incidents.media-stack`

### 6.2 Cross-domain linking

Prefer source-backed links rather than duplicate facts:

- service fact links to `services.<service>`
- incident fact links to both `incidents.<system>.<yyyy-mm>` and affected `services.<service>` where Graphiti supports grouping/tags
- decision fact links to `decisions.<area>` and the service/agent group it governs
- supersession fact names the prior decision/source explicitly

If Graphiti's grouping model cannot attach multiple groups to one episode, use one primary group and tags for secondary domains. Do not create duplicate near-identical episodes just to satisfy taxonomy neatness. Taxonomy neatness is how wikis become haunted.

## 7. Temporal invalidation policy

Graphiti's `invalid_at` is advisory until a human-reviewed or policy-reviewed supersession confirms it.

Rules:

1. A derived `invalid_at` must not be treated as operational truth by itself.
2. Agent answers using Graphiti must cite source episode, source timestamp, validity fields, and caveat.
3. Current live state beats graph facts for remediation.
4. Explicit decisions supersede inferred temporal relationships.
5. If Graphiti marks an active fact invalid without an explicit supersession, wrapper output must downgrade confidence and state `temporal_invalidation_unreviewed`.
6. If a source contains a direct supersession statement, ingest it as an explicit supersession fact with source reference.
7. For incident response, agents must inspect current service/system state before taking action even if Graphiti returns a high-confidence historical fact.

Review queue triggers:

- active provider/service/location facts receive `invalid_at`
- facts touching quorum, NAS, backups, Vaultwarden, reverse proxy, public exposure, or identity/auth are superseded
- query results disagree with repository desired-state docs or live inspection
- qdevice/quorum recommendations or other safety-critical recommendations do not appear in top results even when source contains them

## 8. OpenRouter spend controls

### 8.1 Model allowlist

Only the verified OpenRouter shape is allowed for production ingest until a reviewed change updates this policy:

- base URL: `https://openrouter.ai/api/v1`
- completion model: `openai/gpt-4o-mini`
- small model/reranker model: `openai/gpt-4o-mini`
- embedding model: `openai/text-embedding-3-small`
- embedding dimension: `1536`

The ingest wrapper must fail closed if configured model names, base URL, or embedding dimension differ from the allowlist. It may emit a non-secret error naming the mismatch. It must not log API keys or response headers containing credentials.

### 8.2 Credential and key handling

Preferred deployment credential model:

- use a dedicated OpenRouter key for Graphiti if available
- store key material only in Vaultwarden/runtime secret paths
- keep Git to Vaultwarden folder/item/field references
- never store keys in Kanban comments, committed docs, dashboard JSON, backup manifests, traces, or ingest logs

### 8.3 Frequency and batch limits

Initial production limits before real cost data exists:

- manual curated seed ingest only until infra, wrapper, backup/restore, and dashboard acceptance gates pass
- maximum one reviewed seed batch per day during burn-in
- maximum 25 curated episodes per seed batch
- maximum 1,500 words per episode summary/facts object before redaction
- no automated transcript/log sweeping
- no retry storm: at most two extraction attempts per episode; failed episodes go to review, not endless model chewing

Automation expansion requires a policy update with observed cost, latency, failure rate, redaction pass rate, and rollback/disable switch evidence.

### 8.4 Cost logging without secrets

Log only:

- run id
- timestamp
- model names
- episode count
- redaction category counts
- token counts/cost if available from provider response
- success/failure counts
- failure category
- output graph counts

Never log:

- API keys/tokens
- prompt bodies containing raw source excerpts
- response bodies before redaction review
- request/response headers
- credential-bearing env/config

## 9. Initial curated seed set

The first seed set should be small and biased toward high-value provenance already reviewed in prior tasks:

| Seed | Primary group | Source/evidence |
|---|---|---|
| Graphiti policy boundary: mem0 remains active provider; Graphiti is advisory | `decisions.graphiti-memory-boundary` | this policy and production architecture spec |
| Graphiti deployment posture: tori-local, no public route, local Neo4j data, NAS dumps only | `services.graphiti` | production architecture spec |
| OpenRouter verified config shape | `services.graphiti` | final recommendation and spike report |
| Nippon qdevice/qnetd dependency risk | `homelab.nippon-quorum` | prior curated memory/session evidence and incident/runbook summaries |
| Emperor critical LXC service dependencies | `homelab.emperor-critical` | service inventory summaries |
| Vaultwarden homelab secrets convention | `services.vaultwarden` | sanitized Vaultwarden runbook/docs |
| Jellyfin/media stack stale-NFS incident summary | `incidents.media-stack` | sanitized incident summary/runbook |
| Mobile review surface decision: AVD/noVNC primary, Redroid experimental | `agents.mobile-review-surface` | prior mobile workflow handoff |

Seed criteria:

- source already exists as sanitized artifact, runbook, or Kanban completion summary
- no raw private memory/transcript/log source is needed
- fact has operational value across future agents
- provenance can be cited compactly
- confidence/caveat can be stated plainly

## 10. Expansion criteria

Broaden ingest automation only after all of the following are true:

- [ ] read-only wrapper exists and blocks destructive Graphiti operations from agents
- [ ] backup and isolated restore test are verified and visible to operators
- [ ] Home Dashboard or equivalent operator status shows real freshness/health/backup/restore state
- [ ] redaction tests cover secret, transcript, `.env`, private memory, and log-excerpt cases
- [ ] spend logs show actual costs for at least two seed batches
- [ ] Graphiti query output includes provenance/caveats through the agent-facing path
- [ ] temporal invalidation review workflow exists for safety-critical facts
- [ ] rollback/disable switch for ingest jobs exists and is documented

Potential next source classes, still requiring review before enabling:

- sanitized release notes generated by deployment tasks
- curated Home Dashboard status snapshots with secrets stripped
- reviewed backup/restore manifests with only non-secret metadata
- reviewed incident reports generated from existing runbooks
- explicit architecture decision records in Git

## 11. Wrapper and agent response requirements

Agent-facing Graphiti responses must include at least:

- fact
- source episode/title
- source reference/path/task id
- source timestamp
- valid_at and invalid_at when present
- group/domain
- confidence
- caveat
- staleness/freshness status

Agent-facing Graphiti responses must not include:

- raw source bodies
- raw graph dumps
- arbitrary Cypher results
- secrets/tokens/credential-bearing config
- destructive operation handles

For homelab remediation, wrapper consumers must treat Graphiti as advisory context only and inspect current live state or source-of-truth docs before changing anything.

## 12. Operational checklist for an ingest run

Before run:

- [ ] Confirm source list is allowlisted.
- [ ] Confirm OpenRouter model/base/dimension preflight passed for the deployment credential path.
- [ ] Confirm graph service, backup, and restore-test status are acceptable for ingest.
- [ ] Confirm no live public exposure or raw destructive agent access exists.
- [ ] Prepare curated episode objects and run redaction tests.

During run:

- [ ] Record run id, model names, source ids, group ids, and redaction category counts.
- [ ] Limit batch to approved size.
- [ ] Stop on secret-detection failure.
- [ ] Stop on repeated provider/model/rate-limit failures rather than retrying indefinitely.

After run:

- [ ] Query each group for expected facts and provenance.
- [ ] Verify wrapper output contains caveats/validity fields.
- [ ] Spot-check temporal invalidation for active facts.
- [ ] Run or schedule backup according to deployment policy.
- [ ] Update dashboard/operator status with freshness and last-ingest result when live dashboard integration exists.
- [ ] Commit only non-secret policy, manifests, or summarized evidence.

## 13. Blockers

Block for human decision rather than proceeding if:

- required OpenRouter model/key access is missing or model names differ from the allowlist
- source content contains secrets that cannot be safely summarized
- source requires ingesting raw private memories, transcripts, or bulk logs
- proposed automation would exceed the frequency/batch limits above
- Neo4j/Graphiti backup or restore-test status is unknown before broad ingest
- implementing ingest requires exposing raw Graphiti, Neo4j, or destructive endpoints to agents
- a requested source class is not allowlisted here

## 14. Definition of done for this policy

This policy is implementable when an ingest wrapper can enforce:

- allowlisted source classes
- prohibited/default-excluded data classes
- required redaction checklist and tests
- domain/group strategy
- advisory temporal invalidation handling
- OpenRouter model/spend guardrails
- initial seed set and expansion gates

The policy does not certify a live service. It defines what the live service is allowed to remember without turning into a very expensive rumor mill.
