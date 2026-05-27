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
      if (!isHttpUrl(href)) {
        throw new Error(`Invalid link href for ${label}: only http(s) URLs are allowed`);
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
    const targetUrl = requireText(check?.targetUrl, `statusChecks[${index}].targetUrl`);
    if (!isHttpUrl(targetUrl)) {
      throw new Error(`Invalid status targetUrl for ${label}: only http(s) URLs are allowed`);
    }

    const result = { id, label, targetUrl };
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
