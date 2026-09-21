import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const DEFAULT_CONFIG = {
  title: 'Home Dashboard',
  sections: [
    {
      title: 'Core services',
      links: [
        { label: 'Vaultwarden', href: 'https://vault.wheeler-network.com' },
        { label: 'Traefik', href: 'https://traefik.wheeler-network.com' }
      ]
    }
  ],
  statusChecks: []
};

function isHttpUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}

function isSafeLinkUrl(value) {
  if (typeof value !== 'string') return false;
  if (value.startsWith('/') && !value.startsWith('//') && !value.includes('\0')) return true;
  return isHttpUrl(value);
}

function requireText(value, field) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`Invalid dashboard config: ${field} is required`);
  }
  return value.trim();
}

function validateSections(sections) {
  if (!Array.isArray(sections)) {
    throw new Error('Invalid dashboard config: sections must be an array');
  }

  return sections.map((section, sectionIndex) => {
    const title = requireText(section?.title, `sections[${sectionIndex}].title`);
    if (!Array.isArray(section.links)) {
      throw new Error(`Invalid dashboard config: sections[${sectionIndex}].links must be an array`);
    }

    const links = section.links.map((link, linkIndex) => {
      const label = requireText(link?.label, `sections[${sectionIndex}].links[${linkIndex}].label`);
      const href = requireText(link?.href, `sections[${sectionIndex}].links[${linkIndex}].href`);
      if (!isSafeLinkUrl(href)) {
        throw new Error(`Invalid link href for ${label}: only http(s) or same-origin URLs are allowed`);
      }
      return { label, href };
    });

    return { title, links };
  });
}

function validateStatusChecks(statusChecks) {
  if (!Array.isArray(statusChecks)) {
    throw new Error('Invalid dashboard config: statusChecks must be an array');
  }

  return statusChecks.map((check, index) => {
    const id = requireText(check?.id, `statusChecks[${index}].id`);
    if (!/^[a-z0-9][a-z0-9-]{0,62}$/i.test(id)) {
      throw new Error(`Invalid dashboard config: statusChecks[${index}].id must be DNS-label-like`);
    }
    const label = requireText(check?.label, `statusChecks[${index}].label`);
    const type = check?.type === undefined ? 'http' : requireText(check.type, `statusChecks[${index}].type`);

    const result = { id, label };
    if (type === 'http') {
      const targetUrl = requireText(check?.targetUrl, `statusChecks[${index}].targetUrl`);
      if (!isHttpUrl(targetUrl)) {
        throw new Error(`Invalid status targetUrl for ${label}: only http(s) URLs are allowed`);
      }
      result.targetUrl = targetUrl;
    } else if (type === 'backupFreshness') {
      const backupDir = requireText(check?.backupDir, `statusChecks[${index}].backupDir`);
      if (!backupDir.startsWith('/')) {
        throw new Error(`Invalid backupDir for ${label}: absolute paths are required`);
      }
      result.type = type;
      result.backupDir = backupDir;
      if (check.manifestFile !== undefined) {
        result.manifestFile = requireText(check.manifestFile, `statusChecks[${index}].manifestFile`);
      }
      if (check.maxAgeHours !== undefined) {
        const maxAgeHours = Number(check.maxAgeHours);
        if (!Number.isFinite(maxAgeHours) || maxAgeHours <= 0 || maxAgeHours > 24 * 30) {
          throw new Error(`Invalid maxAgeHours for ${label}: expected a positive number up to 720`);
        }
        result.maxAgeHours = maxAgeHours;
      }
    } else if (type === 'mem0Health') {
      const baseUrl = requireText(check?.baseUrl, `statusChecks[${index}].baseUrl`);
      if (!isHttpUrl(baseUrl)) {
        throw new Error(`Invalid mem0 baseUrl for ${label}: only http(s) URLs are allowed`);
      }
      result.type = type;
      result.baseUrl = baseUrl;
      for (const field of ['docsPath', 'openapiPath', 'searchPath', 'apiKeyEnv', 'searchUserId', 'logErrorPattern']) {
        if (check[field] !== undefined) {
          result[field] = requireText(check[field], `statusChecks[${index}].${field}`);
        }
      }
      if (result.apiKeyEnv && !/^[A-Z_][A-Z0-9_]*$/.test(result.apiKeyEnv)) {
        throw new Error(`Invalid apiKeyEnv for ${label}: expected an environment variable name`);
      }
      for (const field of ['dockerContainers', 'logContainers']) {
        if (check[field] !== undefined) {
          if (!Array.isArray(check[field])) {
            throw new Error(`Invalid ${field} for ${label}: expected an array`);
          }
          result[field] = check[field].map((value, containerIndex) => requireText(value, `statusChecks[${index}].${field}[${containerIndex}]`));
        }
      }
      for (const field of ['logSinceSeconds', 'logTail']) {
        if (check[field] !== undefined) {
          const value = Number(check[field]);
          if (!Number.isFinite(value) || value <= 0 || value > 86_400) {
            throw new Error(`Invalid ${field} for ${label}: expected a positive number up to 86400`);
          }
          result[field] = value;
        }
      }
    } else {
      throw new Error(`Invalid dashboard config: unsupported statusChecks[${index}].type`);
    }

    if (check.displayUrl !== undefined) {
      const displayUrl = requireText(check.displayUrl, `statusChecks[${index}].displayUrl`);
      if (!isHttpUrl(displayUrl)) {
        throw new Error(`Invalid status displayUrl for ${label}: only http(s) URLs are allowed`);
      }
      result.displayUrl = displayUrl;
    }
    return result;
  });
}

export function normalizeConfig(rawConfig = DEFAULT_CONFIG) {
  const title = requireText(rawConfig.title, 'title');
  return {
    title,
    sections: validateSections(rawConfig.sections ?? []),
    statusChecks: validateStatusChecks(rawConfig.statusChecks ?? [])
  };
}

export async function loadConfig({ configPath = process.env.DASHBOARD_CONFIG_FILE } = {}) {
  if (!configPath) {
    return normalizeConfig(DEFAULT_CONFIG);
  }

  const resolved = resolve(configPath);
  let parsed;
  try {
    parsed = JSON.parse(await readFile(resolved, 'utf8'));
  } catch (error) {
    throw new Error(`Unable to load dashboard config from ${resolved}: ${error.message}`);
  }
  return normalizeConfig(parsed);
}

export function toPublicConfig(config) {
  return {
    title: config.title,
    sections: config.sections.map((section) => ({
      title: section.title,
      links: section.links.map((link) => ({ label: link.label, href: link.href }))
    })),
    statusChecks: config.statusChecks.map((check) => ({
      id: check.id,
      label: check.label,
      ...(check.displayUrl ? { displayUrl: check.displayUrl } : {})
    }))
  };
}
