#!/usr/bin/env bash
# Ben-gated mem0 namespace convergence: switch every profile's mem0 user_id to
# the canonical principal "ben". READ FIRST — this is NOT run by an agent.
#
# This script exists so Ben can apply the 6 gateway-touching mem0.json edits
# himself with one auditable, copy-pasteable command (or by reviewing the diff).
# It is intentionally idempotent and non-destructive: it preserves agent_id,
# mode, host, and any other keys; it only (re)writes the single user_id key.
#
# Gate reason: these files change the ACTIVE/default profile's live memory
# principal. Ben applies this per his standing continuity preference.
set -euo pipefail

FILES=(
  /root/.hermes/mem0.json
  /root/.hermes/profiles/domovoi/mem0.json
  /root/.hermes/profiles/kobold/mem0.json
  /root/.hermes/profiles/gremlin/mem0.json
  /root/.hermes/profiles/sentinel/mem0.json
  /root/.hermes/profiles/scribe/mem0.json
)

for f in "${FILES[@]}"; do
  if [[ ! -f "$f" ]]; then
    echo "SKIP (missing): $f" >&2
    continue
  fi
  tmp="$f.tmp.$$"
  python3 - "$f" "$tmp" <<'PY'
import json, sys
src, dst = sys.argv[1], sys.argv[2]
d = json.load(open(src))
d["user_id"] = "ben"   # only this key changes
# preserve agent_id / mode / host untouched
json.dump(d, open(dst, "w"), indent=2)
open(dst, "a").write("\n")
PY
  mv "$tmp" "$f"
  echo "updated: $f"
done

echo
echo "Done. Start a fresh session per profile so initialize() reloads mem0.json."
echo "Verify any profile with: mem0_search (query a durable fact) — it should now"
echo "surface facts from user_id='ben'."