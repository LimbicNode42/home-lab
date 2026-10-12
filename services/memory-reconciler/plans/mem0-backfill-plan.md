# mem0 Curated Backfill Plan — t_3f77442c

Parent epic: `t_1b099c67` (backfill/catch up mem0 + Graphiti).
Apply card: `t_5b1f2f0d` (kobold) reads this plan and owns the writes.
This card is READ-ONLY for mem0; nothing here performs any write.

> **Sanitization note (t_2b168242 remediation).** This plan previously carried the
> 14 durable facts verbatim. That raw corpus has been replaced below with
> non-reversible SHA-256 fingerprints (first 16 hex chars) plus a category label,
> so no durable-fact text is merged to `origin/master`. The verbatim corpus still
> exists in the history of the two origin worktree branches `wt/t_1d8377d3` and
> `wt/t_5685e9a0` (ancestor commit `192bdaf`); whether those branches should be
> sanitized or deleted is Ben's call — do NOT force-push origin without approval.

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

## Plan entries (fingerprints only — verbatim fact text removed)

Each entry is identified by a non-reversible SHA-256 fingerprint (first 16 hex
chars) of the exact fact text, plus a category label. The fact text itself is
held in the private apply receipt and the live mem0 store, not in Git.

### add-missing

| ID  | Category                        | Fingerprint (sha256, first 16) |
|-----|---------------------------------|--------------------------------|
| A1  | identity/career                 | `ba27527943c6239b`             |
| A2  | github-identity                 | `dcfebcf010a598db`             |
| A3  | vaultwarden-secrets-convention  | `531625a84a9b788d`             |
| A4  | proxmox-qdevice-risk            | `8ea5081497d0cc1d`             |
| A5  | emperor-critical-lxc-layout     | `894afd499dbf1b88`             |
| A6  | mem0-graphiti-boundary          | `3ba9a54531fcfcd9`             |
| A7  | house-daemon-roster             | `b27aa0b749cbcfc7`             |
| A8  | safety-audit-tracking           | `b3cf68c325e4156e`             |
| A9  | iac-cac-preference              | `6bba3d2329eb8158`             |
| A10 | persona-preference              | `280170a816d4a7fe`             |
| A11 | accountability-partner          | `67891f2d73bdad4f`             |
| A12 | gateway-restart-preference      | `23db7a0ca603803c`             |
| A13 | vaultwarden-migration-posture   | `85f2ff72209fb65b`             |
| A14 | media-stack-jester              | `39aadec2d19379b8`             |

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
