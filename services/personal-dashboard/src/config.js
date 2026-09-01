import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const DEFAULT_CONFIG = {
  title: 'Home Dashboard',
  sections: [
    {
      title: 'Core services',
      links: [
        { label: 'Vaultwarden', href: 'https://vault.wheeler-network.com' },
        { label: 'Traefik', href: 'https://traefik.wheeler-network.com' },
        { label: 'Hermes Kanban', href: 'http://192.168.0.20:9119/kanban' }
      ]
    }
  ],
  statusChecks: [
    {
      id: 'hermes-kanban',
      label: 'Hermes Kanban',
      targetUrl: 'http://192.168.0.20:9119/kanban',
      displayUrl: 'http://192.168.0.20:9119/kanban'
    }
  ],
  metaMcp: {
    enabled: true,
    title: 'MetaMCP aggregator',
    version: '2.4.22',
    services: [
      { id: 'metamcp', label: 'MetaMCP app', state: 'last_known_healthy', detail: 'Loopback-only on tori; direct LAN exposure intentionally refused.' },
      { id: 'metamcp-pg', label: 'MetaMCP Postgres', state: 'last_known_healthy', detail: 'Internal database for the MetaMCP control plane.' }
    ],
    tools: {
      total: 36,
      domains: [
        { id: 'filesystem', label: 'filesystem', count: 11 },
        { id: 'git', label: 'git', count: 11 },
        { id: 'memory', label: 'memory', count: 9 },
        { id: 'fetch', label: 'fetch', count: 5 }
      ]
    },
    access: {
      mode: 'ssh_tunnel',
      localUrl: 'http://127.0.0.1:12008',
      command: 'ssh -L 12008:127.0.0.1:12008 tori',
      note: 'Aggregator UI is bound to tori loopback only. Start the tunnel, then open the local UI link; do not publish 12008 to LAN without review.'
    }
  }
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


function validateMetaMcp(metaMcp) {
  if (metaMcp === undefined || metaMcp === null) return null;
  if (typeof metaMcp !== 'object' || Array.isArray(metaMcp)) {
    throw new Error('Invalid dashboard config: metaMcp must be an object');
  }

  const enabled = metaMcp.enabled !== false;
  const title = requireText(metaMcp.title ?? 'MetaMCP aggregator', 'metaMcp.title');
  const version = requireText(metaMcp.version ?? 'unknown', 'metaMcp.version');
  const services = metaMcp.services;
  if (!Array.isArray(services)) {
    throw new Error('Invalid dashboard config: metaMcp.services must be an array');
  }
  const normalizedServices = services.map((service, index) => {
    const id = requireText(service?.id, `metaMcp.services[${index}].id`);
    if (!/^[a-z0-9][a-z0-9-]{0,62}$/i.test(id)) {
      throw new Error(`Invalid dashboard config: metaMcp.services[${index}].id must be DNS-label-like`);
    }
    return {
      id,
      label: requireText(service?.label, `metaMcp.services[${index}].label`),
      state: requireText(service?.state, `metaMcp.services[${index}].state`),
      detail: requireText(service?.detail, `metaMcp.services[${index}].detail`)
    };
  });

  const tools = metaMcp.tools ?? {};
  const total = Number(tools.total ?? 0);
  if (!Number.isInteger(total) || total < 0) {
    throw new Error('Invalid dashboard config: metaMcp.tools.total must be a non-negative integer');
  }
  if (!Array.isArray(tools.domains)) {
    throw new Error('Invalid dashboard config: metaMcp.tools.domains must be an array');
  }
  const domains = tools.domains.map((domain, index) => {
    const count = Number(domain?.count ?? 0);
    if (!Number.isInteger(count) || count < 0) {
      throw new Error(`Invalid dashboard config: metaMcp.tools.domains[${index}].count must be a non-negative integer`);
    }
    return {
      id: requireText(domain?.id, `metaMcp.tools.domains[${index}].id`),
      label: requireText(domain?.label, `metaMcp.tools.domains[${index}].label`),
      count
    };
  });

  const access = metaMcp.access ?? {};
  const mode = requireText(access.mode, 'metaMcp.access.mode');
  const localUrl = requireText(access.localUrl, 'metaMcp.access.localUrl');
  if (!isHttpUrl(localUrl)) {
    throw new Error('Invalid dashboard config: metaMcp.access.localUrl must be an http(s) URL');
  }
  const local = new URL(localUrl);
  if (mode !== 'ssh_tunnel' || !['127.0.0.1', 'localhost'].includes(local.hostname)) {
    throw new Error('Invalid MetaMCP access: direct UI links require a reviewed authenticated proxy decision');
  }
  const command = requireText(access.command, 'metaMcp.access.command');
  const note = requireText(access.note, 'metaMcp.access.note');
  const serialized = JSON.stringify({ title, version, normalizedServices, tools: { total, domains }, access: { mode, localUrl, command, note } });
  if (/bearer|token|password|api[_-]?key|\/root\/|\/mnt\/nas|stderr/i.test(serialized)) {
    throw new Error('Invalid dashboard config: metaMcp contains unsafe operator internals');
  }

  return { enabled, title, version, services: normalizedServices, tools: { total, domains }, access: { mode, localUrl, command, note } };
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
    statusChecks: validateStatusChecks(rawConfig.statusChecks ?? []),
    metaMcp: validateMetaMcp(rawConfig.metaMcp)
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
    })),
    ...(config.metaMcp ? { metaMcp: config.metaMcp } : {})
  };
}
