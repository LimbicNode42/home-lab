#!/usr/bin/env bash
set -euo pipefail

# Publish a sanitized Graphiti/Neo4j health snapshot for the Home Dashboard.
# Run on tori (loopback-only Graphiti/Neo4j host). Output contains only coarse
# booleans/counts/timestamps: no graph facts, memory contents, credentials, raw
# local paths, or destructive endpoint references.
#
# Design: the dashboard's graphitiNeo4jHealth summarizer derives Graphiti status
# from live_state_after_checks.healthcheck + curated_ingest_and_query_smoke.{passed,
# ingest_actual.status, query_actual.status}, and Neo4j status from
# live_state_after_checks.neo4j_readiness + backup_and_restore.{passed,
# backup_size_bytes, restore_test.passed}. This publisher re-probes the two LIVE
# signals (Graphiti /healthcheck, Neo4j readiness) on every run and carries
# forward the latest VERIFIED ingest/query/backup evidence from the prior
# snapshot so a fresh run still reports a failed live signal as degraded
# rather than re-greening from stale evidence. The query half of the
# smoke is re-run live against the prior smoke group because /healthcheck
# can stay green while the real Graphiti search path is hung behind Neo4j.

GRAPHITI_API_URL=${GRAPHITI_API_URL:-http://127.0.0.1:8000}
NEO4J_HTTP_URL=${NEO4J_HTTP_URL:-http://127.0.0.1:7474}
NEO4J_DATABASE=${NEO4J_DATABASE:-neo4j}
NEO4J_CONTAINER=${NEO4J_CONTAINER:-graphiti-neo4j}
OUT=${OUT:-/mnt/pve/NAS/services/graphiti/status/latest-smoke-backup.json}
TIMEOUT_SECONDS=${TIMEOUT_SECONDS:-8}

python3 - "$GRAPHITI_API_URL" "$NEO4J_HTTP_URL" "$NEO4J_DATABASE" "$NEO4J_CONTAINER" "$OUT" "$TIMEOUT_SECONDS" <<'PY'
import datetime as dt
import json
import os
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path
from urllib import request, error

api_url, neo4j_url, neo4j_db, neo4j_container, out_path, timeout_s = sys.argv[1:7]
timeout = float(timeout_s)
now = dt.datetime.now(dt.timezone.utc).replace(microsecond=0).isoformat().replace('+00:00', 'Z')


def http_get(url):
    try:
        with request.urlopen(request.Request(url, method='GET'), timeout=timeout) as resp:
            body = resp.read(1024)
            return {'passed': 200 <= resp.status < 400, 'http_status': resp.status}
    except error.HTTPError as exc:
        return {'passed': False, 'http_status': exc.code}
    except Exception as exc:
        return {'passed': False, 'error': type(exc).__name__}


def http_json_post(url, payload):
    data = json.dumps(payload).encode('utf-8')
    req = request.Request(url, data=data, method='POST',
                          headers={'Content-Type': 'application/json',
                                   'Accept': 'application/json'})
    try:
        with request.urlopen(req, timeout=timeout) as resp:
            return {'passed': 200 <= resp.status < 400, 'http_status': resp.status,
                    'body': resp.read(8192).decode('utf-8', 'replace')[:8192]}
    except error.HTTPError as exc:
        return {'passed': False, 'http_status': exc.code}
    except Exception as exc:
        return {'passed': False, 'error': type(exc).__name__}


def docker_container_readiness(name):
    try:
        cp = subprocess.run(
            ['docker', 'inspect', '--format', '{{json .State}}', name],
            text=True,
            capture_output=True,
            timeout=5,
            check=True,
        )
        state = json.loads(cp.stdout)
    except Exception as exc:
        return {'passed': False, 'method': 'docker inspect .State', 'error': type(exc).__name__}
    health = (state.get('Health') or {}).get('Status')
    running = bool(state.get('Running'))
    return {
        'passed': running and health in (None, 'healthy'),
        'method': 'docker inspect .State health',
        'running': running,
        'health': health or 'not_configured',
    }


def neo4j_readiness():
    readiness = http_json_post(
        neo4j_url.rstrip('/') + f'/db/{neo4j_db}/tx/commit',
        {'statements': [{'statement': 'RETURN 1 AS ok'}]},
    )
    readiness['method'] = 'HTTP transactional query without credentials'
    if readiness.get('passed') is True:
        return readiness
    if readiness.get('http_status') == 401:
        # Neo4j HTTP is intentionally auth-protected. Do not read or publish
        # credentials just to make the dashboard green; use the local Docker
        # health signal as a coarse readiness check instead.
        fallback = docker_container_readiness(neo4j_container)
        fallback['http_auth_required'] = True
        fallback['http_status'] = 401
        return fallback
    return readiness


def response_count(body):
    try:
        decoded = json.loads(body or '{}')
    except json.JSONDecodeError:
        return 0
    for key in ('facts', 'results', 'edges'):
        value = decoded.get(key) if isinstance(decoded, dict) else None
        if isinstance(value, list):
            return len(value)
        if isinstance(value, dict):
            return 1
    return 0


def live_query_smoke(api_url, prior_ingest):
    if not isinstance(prior_ingest, dict) or prior_ingest.get('passed') is not True:
        return {'passed': False, 'error': 'prior_ingest_smoke_unavailable'}
    payload = {'query': 'production smoke', 'max_facts': 1}
    result = http_json_post(api_url.rstrip('/') + '/search', payload)
    count = response_count(result.get('body')) if result.get('passed') else 0
    method = 'POST /search ungrouped production smoke query, max_facts=1'
    out = {
        'status': result.get('http_status'),
        'result_count': count,
        'checked_at_utc': now,
        'passed': result.get('passed') is True and count > 0,
        'method': method,
    }
    if 'error' in result:
        out['error'] = result['error']
    return out


def read_prior(out_path):
    """Carry forward last verified ingest/query/backup evidence if present."""
    try:
        with open(out_path, 'r', encoding='utf-8') as fh:
            return json.load(fh)
    except Exception:
        return {}


prior = read_prior(out_path)
prior_ingest = prior.get('curated_ingest_and_query_smoke')
prior_backup = prior.get('backup_and_restore')

health = http_get(api_url.rstrip('/') + '/healthcheck')
readiness = neo4j_readiness()

# Only carry forward prior evidence if it was itself a verified pass, otherwise
# drop it so a subsequent failure cannot leave a dash of stale green.
ingest = None
if isinstance(prior_ingest, dict) and prior_ingest.get('passed') is True:
    live_query = live_query_smoke(api_url, prior_ingest)
    ingest = dict(prior_ingest)
    ingest['query_actual'] = live_query
    ingest['query_checked_at_utc'] = now
    ingest['passed'] = (
        ingest.get('ingest_actual', {}).get('status') == 201
        and live_query.get('passed') is True
    )
backup = prior_backup if (isinstance(prior_backup, dict) and prior_backup.get('passed') is True) else None

live_ok = health.get('passed') is True and readiness.get('passed') is True and (ingest or {}).get('passed') is True
payload = {
    'schema': 'personal-dashboard.graphiti-status.v1',
    'created_at_utc': now,
    'service': 'Graphiti/Neo4j shared operational/provenance memory',
    'status': 'ok' if live_ok else 'degraded',
    'live_state_after_checks': {
        'healthcheck': health,
        'neo4j_readiness': readiness,
    },
    'curated_ingest_and_query_smoke': ingest,
    'backup_and_restore': backup,
    'safety': {
        'mem0_provider_changed': False,
        'public_route_created': False,
        'neo4j_live_data_on_nas': False,
        'raw_destructive_endpoints_agent_facing': False,
        'secrets_included': False,
    },
}

out = Path(out_path)
out.parent.mkdir(parents=True, exist_ok=True)
fd, tmp_name = tempfile.mkstemp(prefix=out.name + '.', suffix='.tmp', dir=str(out.parent))
try:
    with os.fdopen(fd, 'w', encoding='utf-8') as fh:
        json.dump(payload, fh, indent=2, sort_keys=True)
        fh.write('\n')
    os.chmod(tmp_name, 0o644)
    os.replace(tmp_name, out)
finally:
    try:
        os.unlink(tmp_name)
    except FileNotFoundError:
        pass

print(json.dumps({
    'generated_at_utc': payload['created_at_utc'],
    'healthcheck_passed': health.get('passed'),
    'neo4j_readiness_passed': readiness.get('passed'),
    'status': payload['status'],
}, sort_keys=True))
PY