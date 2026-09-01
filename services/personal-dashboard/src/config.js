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
  assertNoUnsafeOperatorInternals(serialized, 'metaMcp');

  return { enabled, title, version, services: normalizedServices, tools: { total, domains }, access: { mode, localUrl, command, note } };
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
  if (!['review_required', 'read_only_screenshot', 'ssh_tunnel'].includes(mode)) {
    throw new Error('Invalid dashboard config: mobileWorkflow.viewer.mode must be review_required, read_only_screenshot, or ssh_tunnel');
  }
  const label = requireText(viewer.label ?? 'Emulator viewer requires review', 'mobileWorkflow.viewer.label');
  const instruction = requireText(viewer.instruction ?? 'A viewer must be reviewed and authenticated before dashboard linking.', 'mobileWorkflow.viewer.instruction');
  const href = requireOptionalText(viewer.href, 'mobileWorkflow.viewer.href');
  if (href) {
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
    ...(config.metaMcp ? { metaMcp: config.metaMcp } : {}),
    ...(config.mobileWorkflow ? { mobileWorkflow: config.mobileWorkflow } : {})
  };
}
