#!/usr/bin/env bash
set -euo pipefail

# Publish a sanitized Graphiti MCP health snapshot for the Home Dashboard.
# Run where the MCP server can reach Graphiti's loopback API (normally tori).
# Output contains only tool names, coarse status, timestamps, and safety booleans.

OUT=${OUT:-/mnt/pve/NAS/services/graphiti/status/latest-mcp-status.json}
GRAPHITI_MCP_SERVER_CMD=${GRAPHITI_MCP_SERVER_CMD:-services/graphiti/scripts/graphiti-mcp-server.py}
GRAPHITI_API_URL=${GRAPHITI_API_URL:-http://127.0.0.1:8000}
TIMEOUT_SECONDS=${TIMEOUT_SECONDS:-20}

python3 - "$OUT" "$GRAPHITI_MCP_SERVER_CMD" "$GRAPHITI_API_URL" "$TIMEOUT_SECONDS" <<'PY'
import asyncio
import datetime as dt
import json
import os
import sys
import tempfile
from pathlib import Path

out_path, server_cmd, api_url, timeout_s = sys.argv[1:5]
now = dt.datetime.now(dt.timezone.utc).replace(microsecond=0).isoformat().replace('+00:00', 'Z')
SAFE_TOOLS = {
    'graphiti_status',
    'graphiti_search_facts',
    'graphiti_lookup_provenance',
    'graphiti_validate_curated_episode',
}
DESTRUCTIVE_TERMS = ('clear', 'delete', 'drop', 'remove', 'truncate', 'cypher', 'admin', 'write')


def base_payload(status, *, error=None, tools=None, calls=None):
    tools = tools or []
    destructive = [name for name in tools if any(term in name.lower() for term in DESTRUCTIVE_TERMS)]
    return {
        'schema': 'personal-dashboard.graphiti-mcp-status.v1',
        'created_at_utc': now,
        'service': 'Graphiti read-only MCP server',
        'status': status,
        'placement': 'separate stdio MCP server registered through MetaMCP/Hermes native MCP; raw Graphiti remains loopback-only',
        'tools': tools,
        'tool_count': len(tools),
        'tested_tools': calls or [],
        'safety': {
            'destructive_tools_exposed': bool(destructive),
            'unexpected_tools_exposed': bool(set(tools) - SAFE_TOOLS),
            'raw_graphiti_public_route_created': False,
            'mem0_provider_changed': False,
            'secrets_included': False,
        },
        **({'error': error} if error else {}),
    }


async def run_smoke():
    try:
        from mcp import ClientSession, StdioServerParameters
        from mcp.client.stdio import stdio_client
    except Exception as exc:
        return base_payload('not_configured', error=f'mcp_sdk_unavailable:{type(exc).__name__}')

    cmd_path = Path(server_cmd)
    command = str(cmd_path if cmd_path.is_absolute() else Path.cwd() / cmd_path)
    env = dict(os.environ)
    env['GRAPHITI_API_URL'] = api_url
    params = StdioServerParameters(command=command, args=[], env=env)
    calls = []
    try:
        async with stdio_client(params) as (read, write):
            async with ClientSession(read, write) as session:
                await asyncio.wait_for(session.initialize(), timeout=float(timeout_s))
                tools_result = await asyncio.wait_for(session.list_tools(), timeout=float(timeout_s))
                tools = sorted(tool.name for tool in tools_result.tools)
                if set(tools) != SAFE_TOOLS:
                    return base_payload('degraded', error='unexpected_tool_contract', tools=tools, calls=calls)
                status = await asyncio.wait_for(session.call_tool('graphiti_status', {}), timeout=float(timeout_s))
                calls.append({'tool': 'graphiti_status', 'ok': not (getattr(status, 'isError', False) or getattr(status, 'is_error', False))})
                search = await asyncio.wait_for(session.call_tool('graphiti_search_facts', {'query': 'Graphiti operational provenance', 'group_id': 'services.graphiti', 'limit': 1}), timeout=float(timeout_s))
                calls.append({'tool': 'graphiti_search_facts', 'ok': not (getattr(search, 'isError', False) or getattr(search, 'is_error', False))})
                ok = all(call['ok'] for call in calls)
                return base_payload('healthy' if ok else 'degraded', tools=tools, calls=calls, error=None if ok else 'tool_call_failed')
    except Exception as exc:
        return base_payload('down', error=type(exc).__name__)


payload = asyncio.run(run_smoke())
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
print(json.dumps({'generated_at_utc': now, 'status': payload['status'], 'tool_count': payload.get('tool_count'), 'error': payload.get('error')}, sort_keys=True))
PY
