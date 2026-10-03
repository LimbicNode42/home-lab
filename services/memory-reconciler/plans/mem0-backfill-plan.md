# mem0 Curated Backfill Plan — t_3f77442c

Parent epic: `t_1b099c67` (backfill/catch up mem0 + Graphiti).
Apply card: `t_5b1f2f0d` (kobold) reads this plan and owns the writes.
This card is READ-ONLY for mem0; nothing here performs any write.

## Scope marker (for continuous-reconciler dedup)

- Audit task: `t_3f77442c`
- Parent epic: `t_1b099c67`
- Fact areas covered: identity/career, GitHub identity, Vaultwarden secrets
  convention, Proxmox cluster + qdevice risk, emperor/critical LXC layout,
  mem0↔Graphiti boundary, house-daemon roster, safety/audit-tracking posture,
  IaC/CaC preference, persona preference, accountability-partner stance,
  gateway-restart preference, Vaultwarden migration posture, media stack.
- `delete_count` is **0** and must stay 0 — hard constraint carried into the
  plan and into the apply card.

## Audit findings (context — NOT plan entries)

1. **Pollution, not absence, is the dominant live-state problem.** The live
   mem0 store (queried read-only via `mem0_search`, 12 angles) is dominated by
   task-progress / operational records of the form "User completed the kanban
   task `t_...`", "User verified … tests", "User's verification … N/N passing".
   These belong to session/provenance (Graphiti or `session_search`), not the
   mem0 durable-personal-facts boundary. They are **out of scope for this plan**
   (no deletes anywhere) — flagged here so the continuous reconciler and the
   apply card treat them via the durable-fact *gate going forward*, not via
   retrospective deletion.
2. **Durable personal facts are largely absent.** Every domain-specific query
   (Vaultwarden, Nippon/qdevice, emperor/critical, jester, LimbicNode42, mem0↔
   Graphiti boundary) returned the same generic task-progress records at low
   relevance — the durable facts themselves are not stored. These are the
   `add-missing` entries below.
3. **Admin list endpoint requires credential.** `GET /memories` (and `/health`)
   return without data (401 / 404) without the mem0 server API key. Per the
   no-secret-values rule, the key was not fetched from Vaultwarden
   (`Homelab` folder, item `mem0/server`). Enumeration was done entirely via
   `mem0_search`. If the apply card needs a full inventory, it must read that
   key — but the plan below is derived from ground-truth sources, not the store.
4. **Folder-casing drift observed (Vaultwarden, not mem0).** Older work refers
   to Vaultwarden folder `homelab` (lowercase) while the memory-reconciler
   config records the operator-observed casing as `Homelab`. This is a
   Vaultwarden naming inconsistency, not a mem0 record; recorded here so the
   fact text below names the folder correctly and consistently.

## Ground-truth sources used (priority order)

- Ben's durable preferences / environment facts / settled decisions captured in
  recent Hermes memory and recent work (authoritative).
- Recent completed kanban cards (decomposition epics + memory-reconciler
  implementation).
- Live mem0 store, read-only.

---

## Plan entries

### add-missing

**A1 — identity / career**
- Fact: "Ben is a professional Infrastructure Engineer who owns a homelab, builds hobby software projects deployed to it, and is working toward a leadership role."
- Why: foundational identity fact; every future turn about career, homelab ownership, or project work stems from it.
- Drift: none (absent).

**A2 — GitHub identity**
- Fact: "Ben's GitHub username is LimbicNode42; homelab config/code repos live under this account."
- Why: stable external identity; prevents re-asking which account to use for commits/pushes.

**A3 — Vaultwarden secrets convention**
- Fact: "Homelab secrets live in Ben's personal Vaultwarden vault under the Homelab folder, reachable locally at http://192.168.0.50:8084; Git stores only folder/item/field references, never secret values."
- Why: convention that governs every secret-touching task; reduces repeated steering.
- Drift: folder casing recorded as `Homelab` (operator-observed); corrected above from older lowercase `homelab` references.

**A4 — Proxmox cluster qdevice deadlock risk**
- Fact: "Ben's Proxmox cluster `Nippon` has a qdevice/qnetd dependency on the NAS VM at 192.168.0.250; hosting qdevice on a cluster-dependent VM means NAS VM downtime deadlocks quorum, so future remediation should move qdevice off cluster-dependent storage/VMs."
- Why: a settled remediation decision with real availability consequences; must not be re-derived or forgotten.

**A5 — emperor/critical LXC layout**
- Fact: "Ben's `emperor` Proxmox node (192.168.0.6) hosts LXC 100 `critical` at 192.168.0.50; `critical` runs Docker services (Traefik/proxy, Vaultwarden, Cloudflare Tunnel, a shared Postgres container) backed by NAS paths under /mnt/nas/services/."
- Why: core environment topology; central to homelab administration and any remediation.

**A6 — mem0 ↔ Graphiti/Neo4j boundary**
- Fact: "Durable personal facts, preferences, and decisions belong in mem0; relational operational/provenance episodes belong in the Graphiti/Neo4j advisory graph. The two stores do not overlap."
- Why: the settled boundary that prevents future double-writing; the whole memory architecture depends on it.

**A7 — house-daemon roster**
- Fact: "Ben's Hermes agent runs a multi-profile 'house daemon' roster (profiles include default, domovoi, gremlin, kobold, scribe, sentinel), coordinated through a shared Kanban board."
- Why: durable environment fact; routing/decomposition decisions depend on knowing the profile roster.

**A8 — safety / audit-tracking posture**
- Fact: "Ben requires auditable change tracking and verification against current state/source-of-truth before any homelab remediation, and destructive actions require explicit approval (motivated by an OpenClaw incident where an LXC was deleted while uninstalling a problematic Jellyfin plugin)."
- Why: a non-negotiable safety constraint; must be remembered to avoid repeating a costly mistake.

**A9 — IaC / CaC preference**
- Fact: "Ben prefers homelab changes be managed as Infrastructure-as-Code or Configuration-as-Code wherever practical, with a Git-backed source of truth that existing live setup is imported into."
- Why: governs how any homelab change is expected to be delivered and recorded.

**A10 — persona preference**
- Fact: "Ben prefers Hermes' SOUL.md persona to stay concise and tone-focused — a 'House Daemon' that stays on-task with occasional dry humor, not a detailed domain/workflow rulebook."
- Why: explicit preference about how the agent presents itself; prevents style drift.

**A11 — accountability-partner stance**
- Fact: "Ben wants Hermes to act as a candid, judgmental accountability partner for personal goals: call out missed commitments and avoidance clearly, apply useful pressure, and turn gaps into the next concrete action."
- Why: a standing instruction about the agent's role in goal work.

**A12 — gateway-restart preference**
- Fact: "Ben prefers Hermes avoid self-configuration changes that would restart the gateway or interrupt its own communication; if such a change is needed, Hermes should tell Ben and let him make the edit."
- Why: prevents self-inflicted service interruption; explicit operational boundary.

**A13 — Vaultwarden migration posture**
- Fact: "Vaultwarden homelab migration/import work must preserve existing users and master passwords by keeping the same database and data volume unless Ben explicitly approves a credential/data migration."
- Why: a settled non-destructive constraint for any future migration work.

**A14 — media stack (jester)**
- Fact: "Ben's `jester` host (192.168.0.8) runs the Docker media stack (Jellyfin, Bazarr, Sonarr on :8989, Radarr on :7878); its NAS mount is /mnt/pve/NAS, with media under /mnt/pve/NAS/media/{movies,tv}, and Bazarr runs English-only."
- Why: stable environment fact; avoids the recurring mount-path confusion (repo seeds wrongly used /mnt/nas).

### update-drift

**None.** No stored durable fact was found with a stale value that could be
corrected via update; the store's non-durable records are progress logs (out of
scope for update, and out of scope for delete). Any apparent drift is a
Vaultwarden casing matter (see finding #4), not a mem0 record.

---

## Hard-constraint conformance

- delete_count = 0 (no delete entries proposed, none needed).
- No secret values, raw transcripts, task-progress logs, or procedural chatter
  proposed as facts.
- Every entry is a declarative durable fact that reduces future steering.
- All entries are additive (`add-missing`) or corrective via note; the apply
  card performs `add` only in this pass.

## Counts

- add_count: 14
- update_count: 0
- delete_count: 0