#!/usr/bin/env bash
set -euo pipefail

# Publish a sanitized mem0 provider health snapshot for the Home Dashboard.
# Run on the host where mem0 is loopback-only (tori). The output contains only
# coarse booleans/counts/timestamps: no memory contents, API keys, or raw local
# paths.

MEM0_BASE_URL=${MEM0_BASE_URL:-http://127.0.0.1:8888}
OUT=${OUT:-/mnt/pve/NAS/services/personal-dashboard/mem0/status.json}
LOG_SINCE_SECONDS=${LOG_SINCE_SECONDS:-180}
MEM0_CONTAINER=${MEM0_CONTAINER:-mem0-mem0-1}
POSTGRES_CONTAINER=${POSTGRES_CONTAINER:-mem0-postgres-1}

python3 - "$MEM0_BASE_URL" "$OUT" "$LOG_SINCE_SECONDS" "$MEM0_CONTAINER" "$POSTGRES_CONTAINER" <<'PY'
import datetime as dt
import json
import os
import re
import subprocess
import sys
import tempfile
from pathlib import Path
from urllib import request, error

base_url, out_path, log_since, mem0_container, postgres_container = sys.argv[1:6]
now = dt.datetime.now(dt.timezone.utc).replace(microsecond=0).isoformat().replace('+00:00', 'Z')
error_pattern = re.compile(r'(datastore|pgvector|connection\s+(?:closed|refused)|(?:closed|refused)\s+connection|database\s+(?:unavailable|error|failed|failure)|psycopg.*(?:error|closed)|HTTP/[^\s]+"\s+5(?:02|03)\b)', re.I)
benign_pattern = re.compile(r'(Connected to PostgreSQL database|PostgreSQL startup complete|Skipping initialization|ready for start up)', re.I)


def http_probe(path):
    url = base_url.rstrip('/') + path
    try:
        with request.urlopen(request.Request(url, method='GET'), timeout=5) as resp:
            return {'passed': 200 <= resp.status < 400, 'http_status': resp.status}
    except error.HTTPError as exc:
        return {'passed': False, 'http_status': exc.code}
    except Exception as exc:
        return {'passed': False, 'error': type(exc).__name__}


def docker_state(name):
    try:
        cp = subprocess.run(
            ['docker', 'inspect', '--format', '{{json .State}}', name],
            text=True,
            capture_output=True,
            timeout=8,
            check=True,
        )
        state = json.loads(cp.stdout)
        health = (state.get('Health') or {}).get('Status')
        running = bool(state.get('Running'))
        passed = running and (health in (None, 'healthy'))
        return {'name': name, 'passed': passed, 'running': running, 'health': health or 'not_configured'}
    except Exception:
        return {'name': name, 'passed': False, 'running': False, 'health': 'unknown'}


def recent_log_errors(name):
    try:
        cp = subprocess.run(
            ['docker', 'logs', '--since', f'{int(float(log_since))}s', '--tail', '200', name],
            text=True,
            capture_output=True,
            timeout=8,
            check=False,
        )
    except Exception:
        return {'passed': False, 'checked': False, 'error_count': None, 'lookback_seconds': int(float(log_since))}
    count = 0
    for line in (cp.stdout + '\n' + cp.stderr).splitlines():
        if benign_pattern.search(line):
            continue
        if error_pattern.search(line):
            count += 1
    return {'passed': count == 0, 'checked': True, 'error_count': count, 'lookback_seconds': int(float(log_since))}


def profile_provider(profile):
    # Intentionally reports only coarse provider/configuration state, not paths or secrets.
    if profile == 'default':
        candidates = [Path('/root/.hermes/config.yaml')]
    else:
        candidates = [Path('/root/.hermes/profiles') / profile / 'config.yaml']
    text = ''
    for candidate in candidates:
        try:
            text = candidate.read_text(errors='replace')
            break
        except Exception:
            pass
    memory_block = ''
    in_memory = False
    for line in text.splitlines():
        if line.startswith('memory:'):
            in_memory = True
            memory_block += line + '\n'
            continue
        if in_memory and line and not line.startswith((' ', '\t')):
            break
        if in_memory:
            memory_block += line + '\n'
    configured = bool(re.search(r'^\s*provider:\s*mem0\s*$', memory_block, re.M))
    enabled = not bool(re.search(r'^\s*memory_enabled:\s*false\s*$', memory_block, re.M))
    return {'provider': 'mem0' if configured else 'other_or_unset', 'configured': configured, 'enabled': enabled}

containers = [docker_state(mem0_container), docker_state(postgres_container)]
container_passed = all(c['passed'] for c in containers)
ALL_PROFILES = ('default', 'domovoi', 'kobold', 'gremlin', 'sentinel', 'scribe')
profile_states = {name: profile_provider(name) for name in ALL_PROFILES}
profiles_passed = all(v['configured'] and v['enabled'] for v in profile_states.values())

payload = {
    'schema': 'personal-dashboard.mem0-status.v1',
    'generated_at_utc': now,
    'source': 'tori-local-mem0-health-publisher',
    'checks': {
        'docs': http_probe('/docs'),
        'openapi': http_probe('/openapi.json'),
        'containers': {
            'passed': container_passed,
            'total': len(containers),
            'healthy': sum(1 for c in containers if c['passed']),
            'states': [{'name': c['name'], 'running': c['running'], 'health': c['health']} for c in containers],
        },
        'logs': recent_log_errors(mem0_container),
        'hermes_profiles': {
            'passed': profiles_passed,
            'profiles': profile_states,
        },
    },
}

out = Path(out_path)
out.parent.mkdir(parents=True, exist_ok=True)
fd, tmp_name = tempfile.mkstemp(prefix=out.name + '.', suffix='.tmp', dir=str(out.parent))
try:
    with os.fdopen(fd, 'w') as fh:
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
    'generated_at_utc': payload['generated_at_utc'],
    'docs_passed': payload['checks']['docs']['passed'],
    'openapi_passed': payload['checks']['openapi']['passed'],
    'containers_passed': payload['checks']['containers']['passed'],
    'log_error_count': payload['checks']['logs']['error_count'],
    'profiles_passed': payload['checks']['hermes_profiles']['passed'],
}, sort_keys=True))
PY
