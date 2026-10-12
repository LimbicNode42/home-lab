#!/usr/bin/env bash
set -euo pipefail

# Ensure the Neo4j relationship VECTOR index exists for graphiti edge
# similarity search.
#
# Why this exists: graphiti-core 0.30.2 `build_indices_and_constraints()`
# creates only RANGE + FULLTEXT indexes (graph_queries.py get_range_indices /
# get_fulltext_indices). It never creates a VECTOR index, so the
# `fact_embedding` relationship property (1536-dim) is stored but not indexed.
# That leaves `vector.similarity.cosine(e.fact_embedding, $search_vector)` in
# the search path running brute-force, and is one half of the intermittent
# /search hang observed on tori. This script applies the missing index
# idempotently as reviewed infra-as-code instead of a one-off manual Cypher.
#
# Idempotent: uses CREATE ... IF NOT EXISTS. Safe to re-run.
# Read-only source of truth: the dimension + similarity function must match the
# deployed embedding model (openai/text-embedding-3-small -> 1536, cosine).

usage() {
  cat >&2 <<'USAGE'
Usage:
  NEO4J_USER=<user> NEO4J_PASSWORD=<pw> services/graphiti/scripts/ensure-vector-index.sh \
    [--dry-run] [--dim 1536] [--similarity cosine] [--container graphiti-neo4j]

Options:
  --dry-run     Show the index that would be created; no mutation.
  --dim N       Vector dimensions (default 1536).
  --similarity  cosine|euclidean (default cosine).
  --container   Neo4j container name (default graphiti-neo4j).
USAGE
}

DRY_RUN=0
DIM="${GRAPHITI_EMBEDDING_DIM:-1536}"
SIM="${GRAPHITI_VECTOR_SIMILARITY:-cosine}"
CONTAINER="${GRAPHITI_NEO4J_CONTAINER:-graphiti-neo4j}"
INDEX_NAME="fact_embedding_vector"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --dry-run) DRY_RUN=1; shift ;;
    --dim) DIM="$2"; shift 2 ;;
    --similarity) SIM="$2"; shift 2 ;;
    --container) CONTAINER="$2"; shift 2 ;;
    -h|--help) usage; exit 0 ;;
    *) echo "unknown arg: $1" >&2; usage; exit 2 ;;
  esac
done

if ! [[ "$DIM" =~ ^[0-9]+$ ]]; then
  echo "ERROR: --dim must be a positive integer" >&2
  exit 2
fi
if [[ "$SIM" != "cosine" && "$SIM" != "euclidean" ]]; then
  echo "ERROR: --similarity must be cosine or euclidean" >&2
  exit 2
fi

if [[ -z "${NEO4J_USER:-}" || -z "${NEO4J_PASSWORD:-}" ]]; then
  echo "ERROR: NEO4J_USER and NEO4J_PASSWORD must be exported" >&2
  exit 2
fi

if ! docker inspect --format '{{.State.Running}}' "$CONTAINER" >/dev/null 2>&1; then
  echo "ERROR: container '$CONTAINER' not running" >&2
  exit 1
fi

CREATE_CYPHER="CREATE VECTOR INDEX $INDEX_NAME IF NOT EXISTS FOR ()-[e:RELATES_TO]-() ON (e.fact_embedding) OPTIONS {indexConfig:{\`vector.dimensions\`: $DIM, \`vector.similarity_function\`: '$SIM'}}"

if [[ "$DRY_RUN" == "1" ]]; then
  echo "DRY-RUN: no mutation performed."
  echo "would run: $CREATE_CYPHER"
  exit 0
fi

echo "Creating vector index '$INDEX_NAME' (dim=$DIM, similarity=$SIM) if absent..."
docker exec "$CONTAINER" \
  cypher-shell -u "$NEO4J_USER" -p "$NEO4J_PASSWORD" "$CREATE_CYPHER"

echo "Verify:"
docker exec "$CONTAINER" \
  cypher-shell -u "$NEO4J_USER" -p "$NEO4J_PASSWORD" \
  "SHOW INDEXES WHERE name='$INDEX_NAME' AND type='VECTOR'"