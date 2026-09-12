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
        { label: 'Hermes Kanban', href: 'http://192.168.0.20:9119/kanban' },
        { label: 'Unified Inbox', href: 'http://192.168.0.50:8766' },
        { label: 'Jellyfin', href: 'http://192.168.0.8:8096' }
      ]
    }
  ],
  statusChecks: [
    {
      id: 'hermes-kanban',
      label: 'Hermes Kanban',
      targetUrl: 'http://192.168.0.20:9119/kanban',
      displayUrl: 'http://192.168.0.20:9119/kanban'
    },
    {
      id: 'metamcp-gateway',
      label: 'MetaMCP gateway',
      targetUrl: 'http://192.168.0.20:12008/health',
      displayUrl: 'http://metamcp.local:12008',
      acceptableStatuses: [200]
    },
    {
      id: 'unified-inbox',
      label: 'Unified Inbox',
      targetUrl: 'http://192.168.0.50:8766/healthz',
      displayUrl: 'http://192.168.0.50:8766',
      acceptableStatuses: [200],
      timeoutMs: 1000
    },
    {
      id: 'jellyfin',
      label: 'Jellyfin',
      targetUrl: 'http://192.168.0.8:8096/health',
      displayUrl: 'http://192.168.0.8:8096',
      acceptableStatuses: [200],
      timeoutMs: 1500
    }
  ],
  unifiedInbox: {
    enabled: true,
    title: 'Unified Inbox',
    publicUrl: 'http://192.168.0.50:8766',
    statusUrl: 'http://172.17.0.1:8766/api/unified-inbox/status',
    note: 'Read-only message aggregation status. Dashboard exposes health, counts, and freshness only; message bodies stay in the inbox service.',
    expectedConnectors: [
      { id: 'email-imap', label: 'Email (IMAP)', state: 'not_configured', detail: 'Phase 1 read-only IMAP connector. Awaiting Vaultwarden-rendered account credentials.' },
      { id: 'rss', label: 'RSS', state: 'not_configured', detail: 'Phase 1 bounded, rate-limited RSS/Atom polling. Awaiting a feed URL reference.' },
      { id: 'webhook', label: 'Webhook', state: 'not_configured', detail: 'Phase 1 opt-in HMAC-verified webhook ingestion. Not enabled until public-exposure review.' },
      { id: 'discord', label: 'Discord', state: 'pending_credentials', detail: 'Phase 2 connector deployed; awaiting Vaultwarden-rendered credentials.' },
      { id: 'telegram', label: 'Telegram', state: 'pending_credentials', detail: 'Phase 2 connector deployed; awaiting Vaultwarden-rendered credentials.' },
      { id: 'matrix', label: 'Matrix', state: 'pending_credentials', detail: 'Phase 2 connector deployed; awaiting Vaultwarden-rendered credentials.' },
      { id: 'slack', label: 'Slack', state: 'pending_credentials', detail: 'Phase 2 connector deployed; awaiting Vaultwarden-rendered credentials.' },
      { id: 'android-sms-mms', label: 'Android SMS/MMS', state: 'not_configured', detail: 'Read-only default-SMS-handler capture. Requires explicit device/default-role consent and a Vaultwarden credential.' }
    ]
  },
  metaMcp: {
    enabled: true,
    title: 'MetaMCP aggregator',
    version: '2.4.22',
    services: [
      { id: 'metamcp', label: 'MetaMCP app', state: 'live_probe_configured', detail: 'Live gateway health is probed server-side at /health; browser links use the metamcp.local friendly name because critical cannot resolve mDNS .local names.' },
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
      mode: 'lan_gateway',
      localUrl: 'http://metamcp.local:12008',
      note: 'LAN gateway is reachable at the URL below and still requires gateway authentication. The dashboard stores only URLs, never credentials/keys.',
      links: [
        { label: 'Open MetaMCP gateway (metamcp.local)', href: 'http://metamcp.local:12008' },
        { label: 'MCP endpoint (metamcp.local)', href: 'http://metamcp.local:12008/mcp' }
      ]
    }
  },
  mobileWorkflow: {
    enabled: true,
    title: 'Flutter mobile workflow',
    host: 'tori',
    components: [
      { id: 'flutter', label: 'Flutter SDK', state: 'last_known_present', detail: 'Flutter 3.47.2 was verified on tori.' },
      { id: 'dart', label: 'Dart SDK', state: 'last_known_present', detail: 'Dart 3.13.2 was verified with the Flutter toolchain.' },
      { id: 'android-sdk', label: 'Android SDK', state: 'last_known_present', detail: 'Android SDK command-line tools were verified for headless builds.' },
      { id: 'jdk', label: 'JDK', state: 'last_known_present', detail: 'JDK 21 was verified for Android builds.' },
      { id: 'avd-flutter-headless', label: 'AVD flutter_headless', state: 'last_known_present', detail: 'Headless Android virtual device exists; dashboard status is read-only and will not boot it.' }
    ],
    runtime: {
      state: 'not_running',
      adbDeviceId: null,
      detail: 'No adb device was attached during the last live workflow check.'
    },
    lastSuccessfulCycleAt: null,
    viewer: {
      mode: 'review_required',
      label: 'Emulator viewer requires review',
      instruction: 'Use the proven headless cycle on tori for now. A read-only adb screenshot, noVNC, or scrcpy web viewer must be placed behind authentication before the dashboard links to it.',
      href: null
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



function requireOptionalText(value, field) {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string') {
    throw new Error(`Invalid dashboard config: ${field} must be a string`);
  }
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
}

function assertNoUnsafeOperatorInternals(serialized, field) {
  if (/bearer|token|password|api[_-]?key|\/root\/|\/mnt\/nas|stderr|DATABASE_URL/i.test(serialized)) {
    throw new Error(`Invalid dashboard config: ${field} contains unsafe operator internals`);
  }
}

function validateStateValue(value, field) {
  const state = requireText(value, field);
  if (!/^[a-z][a-z0-9_-]{0,48}$/i.test(state)) {
    throw new Error(`Invalid dashboard config: ${field} must be a safe state label`);
  }
  return state;
}


function validateUnifiedInbox(unifiedInbox) {
  if (unifiedInbox === undefined || unifiedInbox === null) return null;
  if (typeof unifiedInbox !== 'object' || Array.isArray(unifiedInbox)) {
    throw new Error('Invalid dashboard config: unifiedInbox must be an object');
  }

  const enabled = unifiedInbox.enabled !== false;
  const title = requireText(unifiedInbox.title ?? 'Unified Inbox', 'unifiedInbox.title');
  const publicUrl = requireText(unifiedInbox.publicUrl, 'unifiedInbox.publicUrl');
  const statusUrl = requireText(unifiedInbox.statusUrl, 'unifiedInbox.statusUrl');
  if (!isHttpUrl(publicUrl)) {
    throw new Error('Invalid dashboard config: unifiedInbox.publicUrl must be an http(s) URL');
  }
  if (!isHttpUrl(statusUrl)) {
    throw new Error('Invalid dashboard config: unifiedInbox.statusUrl must be an http(s) URL');
  }
  if (/[?&](?:token|api[_-]?key|key|authorization)=/i.test(`${publicUrl} ${statusUrl}`)) {
    throw new Error('Invalid Unified Inbox config: URLs must not embed credentials');
  }
  const note = requireText(unifiedInbox.note ?? 'Read-only unified inbox status.', 'unifiedInbox.note');
  const expectedConnectors = unifiedInbox.expectedConnectors ?? [];
  if (!Array.isArray(expectedConnectors)) {
    throw new Error('Invalid dashboard config: unifiedInbox.expectedConnectors must be an array');
  }
  const connectors = expectedConnectors.map((connector, index) => {
    const id = requireText(connector?.id, `unifiedInbox.expectedConnectors[${index}].id`);
    if (!/^[a-z0-9][a-z0-9-]{0,62}$/i.test(id)) {
      throw new Error(`Invalid dashboard config: unifiedInbox.expectedConnectors[${index}].id must be DNS-label-like`);
    }
    return {
      id,
      label: requireText(connector?.label, `unifiedInbox.expectedConnectors[${index}].label`),
      state: validateStateValue(connector?.state ?? 'pending_credentials', `unifiedInbox.expectedConnectors[${index}].state`),
      detail: requireText(connector?.detail ?? 'Connector status has not been published yet.', `unifiedInbox.expectedConnectors[${index}].detail`)
    };
  });
  const timeoutMs = Number(unifiedInbox.timeoutMs ?? 1000);
  if (!Number.isInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 5000) {
    throw new Error('Invalid dashboard config: unifiedInbox.timeoutMs must be an integer between 100 and 5000');
  }

  const normalized = { enabled, title, publicUrl, statusUrl, note, expectedConnectors: connectors, timeoutMs };
  assertNoUnsafeOperatorInternals(JSON.stringify(normalized), 'unifiedInbox');
  return normalized;
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

  // The static tools block is optional; live registry data is supplied separately.
  const tools = metaMcp.tools ?? {};
  const hasTools = Number.isInteger(Number(tools.total)) && Array.isArray(tools.domains);
  let total = null;
  let domains = [];
  if (hasTools) {
    total = Number(tools.total ?? 0);
    if (total < 0) {
      throw new Error('Invalid dashboard config: metaMcp.tools.total must be a non-negative integer');
    }
    domains = tools.domains.map((domain, index) => {
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
  }

  const access = metaMcp.access ?? {};
  const mode = requireText(access.mode, 'metaMcp.access.mode');
  if (!['ssh_tunnel', 'lan_gateway'].includes(mode)) {
    throw new Error('Invalid dashboard config: metaMcp.access.mode must be ssh_tunnel or lan_gateway');
  }
  const localUrl = requireText(access.localUrl, 'metaMcp.access.localUrl');
  if (!isHttpUrl(localUrl)) {
    throw new Error('Invalid dashboard config: metaMcp.access.localUrl must be an http(s) URL');
  }
  const local = new URL(localUrl);
  if (mode === 'ssh_tunnel' && !['127.0.0.1', 'localhost'].includes(local.hostname)) {
    throw new Error('Invalid MetaMCP access: SSH tunnel links must stay on loopback');
  }
  if (mode === 'lan_gateway' && ['127.0.0.1', 'localhost'].includes(local.hostname)) {
    throw new Error('Invalid MetaMCP access: LAN gateway links must use the reviewed LAN endpoint');
  }
  const command = mode === 'ssh_tunnel' ? requireText(access.command, 'metaMcp.access.command') : null;
  const note = requireText(access.note, 'metaMcp.access.note');
  const rawLinks = access.links ?? [{ label: mode === 'lan_gateway' ? 'Open MetaMCP gateway' : 'Open local MetaMCP UI after tunnel is running', href: localUrl }];
  if (!Array.isArray(rawLinks) || rawLinks.length === 0) {
    throw new Error('Invalid dashboard config: metaMcp.access.links must be a non-empty array');
  }
  const links = rawLinks.map((link, index) => {
    const label = requireText(link?.label, `metaMcp.access.links[${index}].label`);
    const href = requireText(link?.href, `metaMcp.access.links[${index}].href`);
    if (!isHttpUrl(href)) {
      throw new Error(`Invalid dashboard config: metaMcp.access.links[${index}].href must be an http(s) URL`);
    }
    if (/[?&](?:token|api[_-]?key|key|authorization)=/i.test(href)) {
      throw new Error('Invalid MetaMCP access: links must not embed credentials');
    }
    return { label, href };
  });
  const normalizedAccess = { mode, localUrl, note, links, ...(command ? { command } : {}) };
  const serialized = JSON.stringify({ title, version, normalizedServices, tools: { total, domains }, access: normalizedAccess });
  assertNoUnsafeOperatorInternals(serialized, 'metaMcp');

  return { enabled, title, version, services: normalizedServices, tools: { total, domains }, access: normalizedAccess };
}

function validateMobileWorkflow(mobileWorkflow) {
  if (mobileWorkflow === undefined || mobileWorkflow === null) return null;
  if (typeof mobileWorkflow !== 'object' || Array.isArray(mobileWorkflow)) {
    throw new Error('Invalid dashboard config: mobileWorkflow must be an object');
  }

  const enabled = mobileWorkflow.enabled !== false;
  const title = requireText(mobileWorkflow.title ?? 'Flutter mobile workflow', 'mobileWorkflow.title');
  const host = requireText(mobileWorkflow.host ?? 'tori', 'mobileWorkflow.host');
  if (!/^[a-z0-9][a-z0-9.-]{0,62}$/i.test(host)) {
    throw new Error('Invalid dashboard config: mobileWorkflow.host must be a safe hostname');
  }

  const components = mobileWorkflow.components;
  if (!Array.isArray(components)) {
    throw new Error('Invalid dashboard config: mobileWorkflow.components must be an array');
  }
  const normalizedComponents = components.map((component, index) => {
    const id = requireText(component?.id, `mobileWorkflow.components[${index}].id`);
    if (!/^[a-z0-9][a-z0-9-]{0,62}$/i.test(id)) {
      throw new Error(`Invalid dashboard config: mobileWorkflow.components[${index}].id must be DNS-label-like`);
    }
    return {
      id,
      label: requireText(component?.label, `mobileWorkflow.components[${index}].label`),
      state: validateStateValue(component?.state, `mobileWorkflow.components[${index}].state`),
      detail: requireText(component?.detail, `mobileWorkflow.components[${index}].detail`)
    };
  });

  const runtime = mobileWorkflow.runtime ?? {};
  const runtimeState = validateStateValue(runtime.state ?? 'unknown', 'mobileWorkflow.runtime.state');
  if (!['not_running', 'booting', 'running', 'unknown'].includes(runtimeState)) {
    throw new Error('Invalid dashboard config: mobileWorkflow.runtime.state must be not_running, booting, running, or unknown');
  }
  const adbDeviceId = requireOptionalText(runtime.adbDeviceId, 'mobileWorkflow.runtime.adbDeviceId');
  if (adbDeviceId && !/^emulator-[0-9]{4,5}$|^[A-Za-z0-9._:-]{3,64}$/.test(adbDeviceId)) {
    throw new Error('Invalid dashboard config: mobileWorkflow.runtime.adbDeviceId must be a safe device id');
  }
  const detail = requireText(runtime.detail ?? 'No runtime detail has been published.', 'mobileWorkflow.runtime.detail');
  const lastSuccessfulCycleAt = requireOptionalText(mobileWorkflow.lastSuccessfulCycleAt, 'mobileWorkflow.lastSuccessfulCycleAt');

  const viewer = mobileWorkflow.viewer ?? {};
  const mode = requireText(viewer.mode ?? 'review_required', 'mobileWorkflow.viewer.mode');
  if (!['review_required', 'read_only_screenshot', 'ssh_tunnel', 'authenticated_novnc'].includes(mode)) {
    throw new Error('Invalid dashboard config: mobileWorkflow.viewer.mode must be review_required, read_only_screenshot, ssh_tunnel, or authenticated_novnc');
  }
  const label = requireText(viewer.label ?? 'Emulator viewer requires review', 'mobileWorkflow.viewer.label');
  const instruction = requireText(viewer.instruction ?? 'A viewer must be reviewed and authenticated before dashboard linking.', 'mobileWorkflow.viewer.instruction');
  const href = requireOptionalText(viewer.href, 'mobileWorkflow.viewer.href');
  if (href) {
    if (mode === 'authenticated_novnc') {
      if (href !== '/mobile-viewer/') {
        throw new Error('Invalid mobile workflow viewer: authenticated noVNC links must use the dashboard /mobile-viewer/ proxy');
      }
    } else {
      if (!isHttpUrl(href)) {
        throw new Error('Invalid dashboard config: mobileWorkflow.viewer.href must be an http(s) URL');
      }
      const parsed = new URL(href);
      if (mode === 'ssh_tunnel' && !['127.0.0.1', 'localhost'].includes(parsed.hostname)) {
        throw new Error('Invalid mobile workflow viewer: direct emulator links require reviewed authenticated proxy access');
      }
      if (mode === 'read_only_screenshot' && parsed.protocol !== 'https:') {
        throw new Error('Invalid mobile workflow viewer: read-only screenshot links must use https');
      }
    }
  }

  const normalized = {
    enabled,
    title,
    host,
    components: normalizedComponents,
    runtime: { state: runtimeState, adbDeviceId, detail },
    lastSuccessfulCycleAt,
    viewer: { mode, label, instruction, href }
  };
  assertNoUnsafeOperatorInternals(JSON.stringify(normalized), 'mobileWorkflow');
  return normalized;
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

    const acceptableStatuses = check.acceptableStatuses ?? [200, 204, 301, 302];
    if (!Array.isArray(acceptableStatuses) || acceptableStatuses.length === 0) {
      throw new Error(`Invalid status acceptableStatuses for ${label}: must be a non-empty array`);
    }
    const normalizedStatuses = acceptableStatuses.map((status, statusIndex) => {
      const parsed = Number(status);
      if (!Number.isInteger(parsed) || parsed < 100 || parsed > 599) {
        throw new Error(`Invalid status acceptableStatuses[${statusIndex}] for ${label}: must be an HTTP status code`);
      }
      return parsed;
    });

    const result = { id, label, targetUrl, acceptableStatuses: normalizedStatuses };
    if (check.timeoutMs !== undefined) {
      const timeoutMs = Number(check.timeoutMs);
      if (!Number.isInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 10_000) {
        throw new Error(`Invalid status timeoutMs for ${label}: must be an integer between 100 and 10000`);
      }
      result.timeoutMs = timeoutMs;
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
    statusChecks: validateStatusChecks(rawConfig.statusChecks ?? []),
    unifiedInbox: validateUnifiedInbox(rawConfig.unifiedInbox),
    metaMcp: validateMetaMcp(rawConfig.metaMcp),
    mobileWorkflow: validateMobileWorkflow(rawConfig.mobileWorkflow)
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
    ...(config.unifiedInbox ? { unifiedInbox: {
      enabled: config.unifiedInbox.enabled,
      title: config.unifiedInbox.title,
      publicUrl: config.unifiedInbox.publicUrl,
      note: config.unifiedInbox.note,
      expectedConnectors: config.unifiedInbox.expectedConnectors
    } } : {}),
    ...(config.metaMcp ? { metaMcp: config.metaMcp } : {}),
    ...(config.mobileWorkflow ? { mobileWorkflow: config.mobileWorkflow } : {})
  };
}
