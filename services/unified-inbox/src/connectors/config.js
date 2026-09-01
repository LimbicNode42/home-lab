// Shared connector configuration: Vaultwarden reference resolution is NOT done
// here. Connectors receive already-materialized config via `renderConfig`, which
// maps Vaultwarden item fields onto a sanitized config object. Values never live
// in the repo, logs, or tests; only field names and reference names appear.

// A connector config field descriptor. `field` is the Vaultwarden field name
// (non-secret names only in `nonSecret`; secret fields are named but never
// materialized into repo source).
const FIELD_TYPES = new Set(['secret', 'nonSecret', 'optionalNonSecret', 'allowlist']);

export function assertConfigShape(definition, config) {
  if (!definition || typeof definition !== 'object') throw new Error('Config definition required');
  if (!config || typeof config !== 'object') throw new Error('Config must be an object');
  for (const [key, meta] of Object.entries(definition)) {
    const type = meta?.type;
    if (!FIELD_TYPES.has(type)) throw new Error(`Unknown config field type ${type} for ${key}`);
    const present = config[key] !== undefined && config[key] !== null;
    if (type === 'secret' && !present) throw new Error(`Missing required secret field ${key}`);
    if (type === 'nonSecret' && !present) throw new Error(`Missing required non-secret field ${key}`);
    if (type === 'allowlist' && !Array.isArray(config[key])) throw new Error(`Config field ${key} must be an array`);
  }
  return config;
}

// Strip secret fields entirely and keep only non-secret / optional fields for
// safe health/log output. Returns a shallow copy, never the original reference.
export function sanitizeConfig(definition, config) {
  const out = {};
  for (const [key, meta] of Object.entries(definition)) {
    if (meta?.type === 'secret') continue; // never emit secret values
    if (config[key] !== undefined) out[key] = config[key];
  }
  return out;
}

// Extract the Vaultwarden reference names a connector depends on for docs/env
// maps. Used in env.map.example generation and runbook tables.
export function referenceName(connector, accountRef) {
  return `unified-inbox/${connector}/${accountRef}`;
}