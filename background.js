// True response substitution via the DevTools-Protocol Fetch domain: intercept
// da.live code requests and fulfill them with bytes from a local server, while
// keeping the ORIGINAL da.live URL. The page (and its module map, and IMS's
// `window.location.origin` imports) never sees localhost — so auth keeps
// working. The local server only serves files; nothing executes there.
//
// Chrome shows its "… started debugging this browser" banner in every tab while
// any debugger session is open; it can't be scoped per tab. So we only stay
// attached to the da.live tab in front (active tab of the last-focused window),
// plus background da.live tabs while they load. Chrome hides the banner ~5s
// after the last session detaches.

const DEFAULTS = {
  enabled: false,
  localBase: 'http://localhost:5757',
  paths: ['scripts', 'blocks', 'styles', 'deps', 'fonts', 'icons', 'img', 'tools'],
};

const TARGET_HOST = /^(da\.live|da\.page)$/;

// A background da.live tab stays attached while it loads and for this long
// after it completes, so its delayed imports are still served locally.
const SETTLE_GRACE_MS = 5000;
// Safety cap in case a background load never reports 'complete'.
const SETTLE_MAX_MS = 30000;

const MIME = {
  js: 'text/javascript; charset=utf-8',
  mjs: 'text/javascript; charset=utf-8',
  css: 'text/css; charset=utf-8',
  json: 'application/json; charset=utf-8',
  svg: 'image/svg+xml',
  html: 'text/html; charset=utf-8',
  woff2: 'font/woff2',
  woff: 'font/woff',
  ttf: 'font/ttf',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  ico: 'image/x-icon',
  map: 'application/json; charset=utf-8',
};

let state = { ...DEFAULTS };
const attached = new Set();
// Background da.live tabs that are (re)loading: tabId -> pending detach timer.
const settling = new Map();

async function loadState() {
  const { config } = await chrome.storage.local.get('config');
  state = { ...DEFAULTS, ...(config || {}) };
  return state;
}

const ready = loadState();

function isTargetPage(rawUrl) {
  try { return TARGET_HOST.test(new URL(rawUrl).hostname); } catch { return false; }
}

function fetchPatterns() {
  const pats = [];
  for (const host of ['da.live', 'da.page']) {
    for (const p of state.paths) {
      const clean = String(p).trim().replace(/^\/+|\/+$/g, '');
      if (clean) pats.push({ urlPattern: `*://${host}/${clean}/*`, requestStage: 'Request' });
    }
  }
  return pats;
}

function isTargetCodeUrl(rawUrl) {
  let u;
  try { u = new URL(rawUrl); } catch { return false; }
  if (!TARGET_HOST.test(u.hostname)) return false;
  const top = u.pathname.split('/').filter(Boolean)[0];
  return state.paths.some((p) => String(p).trim().replace(/^\/+|\/+$/g, '') === top);
}

function localUrlFor(rawUrl) {
  const u = new URL(rawUrl);
  return `${state.localBase.replace(/\/+$/, '')}${u.pathname}${u.search}`;
}

function mimeFor(pathname) {
  const ext = pathname.split('.').pop().toLowerCase();
  return MIME[ext] || 'application/octet-stream';
}

function toBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

function safeSend(target, command, params) {
  return chrome.debugger.sendCommand(target, command, params).catch(() => { });
}

async function onFetchPaused(source, params) {
  const { requestId, request } = params;

  if (!isTargetCodeUrl(request.url)) {
    safeSend(source, 'Fetch.continueRequest', { requestId });
    return;
  }

  try {
    const resp = await fetch(localUrlFor(request.url), { cache: 'no-store' });
    if (!resp.ok) {
      // Not present locally — let da.live serve it.
      safeSend(source, 'Fetch.continueRequest', { requestId });
      return;
    }
    const buffer = await resp.arrayBuffer();
    const contentType = resp.headers.get('content-type')
      || mimeFor(new URL(request.url).pathname);

    await chrome.debugger.sendCommand(source, 'Fetch.fulfillRequest', {
      requestId,
      responseCode: 200,
      responseHeaders: [
        { name: 'content-type', value: contentType },
        { name: 'cache-control', value: 'no-store' },
      ],
      body: toBase64(buffer),
    });
  } catch {
    safeSend(source, 'Fetch.continueRequest', { requestId });
  }
}

async function attachTab(tabId) {
  if (attached.has(tabId)) return;
  try {
    await chrome.debugger.attach({ tabId }, '1.3');
    await chrome.debugger.sendCommand({ tabId }, 'Fetch.enable', { patterns: fetchPatterns() });
    attached.add(tabId);
  } catch {
    // already attached or tab not debuggable
    return;
  }
  // Re-attaching to an already-loaded tab (e.g. switching back to it).
  const tab = await chrome.tabs.get(tabId).catch(() => null);
  if (tab?.status === 'complete') injectBadge(tabId);
}

async function detachTab(tabId) {
  if (attached.delete(tabId)) removeBadge(tabId);
  // Not gated on `attached`: a session can outlive our in-memory state (e.g.
  // across a service-worker restart). Detaching one we don't own just throws.
  try { await chrome.debugger.detach({ tabId }); } catch { }
}

// A small, non-interactive "local override" label injected into the overridden
// tab. position:fixed + pointer-events:none + max z-index => overlays on top
// without affecting layout or clicks.
function injectBadge(tabId) {
  chrome.scripting.executeScript({
    target: { tabId },
    func: () => {
      const ID = 'da-live-override-badge';
      if (document.getElementById(ID)) return;
      const el = document.createElement('div');
      el.id = ID;
      el.textContent = 'local override: enabled';
      el.style.cssText = [
        'position:fixed', 'top:8px', 'left:50%', 'transform:translateX(-50%)',
        'z-index:2147483647', 'pointer-events:none', 'background:#1473e6',
        'color:#fff', 'font:600 11px/1 system-ui,sans-serif',
        'letter-spacing:.02em', 'padding:5px 10px', 'border-radius:4px',
        'box-shadow:0 1px 4px rgb(0 0 0 / 35%)',
      ].join(';');
      (document.body || document.documentElement).appendChild(el);
    },
  }).catch(() => { });
}

function removeBadge(tabId) {
  chrome.scripting.executeScript({
    target: { tabId },
    func: () => document.getElementById('da-live-override-badge')?.remove(),
  }).catch(() => { });
}

async function targetTabs() {
  return chrome.tabs.query({ url: ['*://da.live/*', '*://da.page/*'] });
}

function settle(tabId, ms) {
  clearTimeout(settling.get(tabId));
  settling.set(tabId, setTimeout(() => {
    settling.delete(tabId);
    scheduleSync();
  }, ms));
}

function unsettle(tabId) {
  clearTimeout(settling.get(tabId));
  settling.delete(tabId);
}

async function frontTargetTabId() {
  try {
    const win = await chrome.windows.getLastFocused({ populate: true, windowTypes: ['normal'] });
    const tab = win.tabs.find((t) => t.active);
    return tab && isTargetPage(tab.url) ? tab.id : null;
  } catch {
    return null;
  }
}

// Attach exactly the tabs that should be intercepted; detach everything else.
async function sync() {
  await ready;
  const want = new Set();
  if (state.enabled) {
    const front = await frontTargetTabId();
    if (front != null) want.add(front);
    settling.forEach((_, id) => want.add(id));
  }
  const open = new Set(attached);
  const targets = await chrome.debugger.getTargets();
  targets.forEach((t) => { if (t.attached && t.tabId != null) open.add(t.tabId); });
  for (const id of open) {
    // eslint-disable-next-line no-await-in-loop
    if (!want.has(id)) await detachTab(id);
  }
  for (const id of want) {
    // eslint-disable-next-line no-await-in-loop
    await attachTab(id);
  }
}

// Serialize attach/detach work so overlapping tab/window events can't race.
let queue = Promise.resolve();
function enqueue(fn) {
  queue = queue.then(fn).catch(() => { });
  return queue;
}

function scheduleSync() {
  return enqueue(sync);
}

async function applyNow(wasEnabled) {
  await loadState();
  await chrome.action.setBadgeText({ text: state.enabled ? 'ON' : '' });
  await chrome.action.setBadgeBackgroundColor({ color: '#1473e6' });

  const tabs = await targetTabs();
  [...settling.keys()].forEach((id) => unsettle(id));
  // Drop current sessions so changed settings (e.g. paths) apply on re-attach.
  for (const id of [...attached]) {
    // eslint-disable-next-line no-await-in-loop
    await detachTab(id);
  }
  // Attach every da.live tab for its reload; background ones detach once settled.
  if (state.enabled) tabs.forEach((t) => settle(t.id, SETTLE_MAX_MS));
  await sync();
  if (state.enabled || wasEnabled) tabs.forEach((t) => chrome.tabs.reload(t.id));
}

function apply(wasEnabled = false) {
  return enqueue(() => applyNow(wasEnabled));
}

chrome.debugger.onEvent.addListener((source, method, params) => {
  if (method === 'Fetch.requestPaused') onFetchPaused(source, params);
});

chrome.debugger.onDetach.addListener((source, reason) => {
  if (source.tabId == null) return;
  attached.delete(source.tabId);
  // The banner's "Cancel" detaches every session. Treat it as switching the
  // override off; otherwise the next tab switch would just re-attach.
  if (reason === 'canceled_by_user' && state.enabled) {
    chrome.storage.local.set({ config: { ...state, enabled: false } });
  }
});

// Track da.live loads (and navigations away from da.live) so the right tabs
// stay attached, and (re)inject the label once a load completes.
chrome.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
  if (!changeInfo.status && !changeInfo.url) return;
  await ready;
  if (!isTargetPage(tab.url)) {
    unsettle(tabId);
  } else if (changeInfo.status === 'loading' && state.enabled) {
    settle(tabId, SETTLE_MAX_MS);
  } else if (changeInfo.status === 'complete') {
    if (settling.has(tabId)) settle(tabId, SETTLE_GRACE_MS);
    if (attached.has(tabId)) injectBadge(tabId);
  }
  scheduleSync();
});

// Follow whichever tab is in front.
chrome.tabs.onActivated.addListener(() => scheduleSync());
chrome.windows.onFocusChanged.addListener(() => scheduleSync());

chrome.tabs.onRemoved.addListener((tabId) => {
  attached.delete(tabId);
  unsettle(tabId);
});

// The popup switched the server's da-live folder: reload da.live tabs (only if
// the override is on) so they pick up the new files.
chrome.runtime.onMessage.addListener((msg) => {
  if (msg?.type === 'reapply') apply();
});

// The default port moved from 3000 to 5757; migrate configs that still point
// at the old default so an extension reload picks up the new server.
async function migrateLocalBase() {
  const { config } = await chrome.storage.local.get('config');
  if (config?.localBase?.replace(/\/+$/, '') === 'http://localhost:3000') {
    await chrome.storage.local.set({ config: { ...config, localBase: DEFAULTS.localBase } });
    return true;
  }
  return false;
}

chrome.runtime.onInstalled.addListener(async () => {
  // A migrated config already triggers apply() via storage.onChanged.
  if (!(await migrateLocalBase())) apply();
});
chrome.runtime.onStartup.addListener(() => apply());
chrome.storage.onChanged.addListener((changes, area) => {
  // Reload da.live tabs when turning off too, so they drop the local code.
  if (area === 'local' && changes.config) apply(!!changes.config.oldValue?.enabled);
});
