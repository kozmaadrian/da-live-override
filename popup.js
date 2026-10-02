const DEFAULTS = {
  enabled: false,
  localBase: 'http://localhost:5757',
  paths: ['scripts', 'blocks', 'styles', 'deps', 'fonts', 'icons', 'img', 'tools'],
};

// The da-live folder lives in the server's config.json, not in Chrome storage:
// the server is what reads the files.
const API_PATH = '/__da-live-override/config';

const enabledEl = document.querySelector('#enabled');
const localBaseEl = document.querySelector('#localBase');
const rootEl = document.querySelector('#root');
const rootStatusEl = document.querySelector('#rootStatus');
const pathsEl = document.querySelector('#paths');

function serverBase() {
  return (localBaseEl.value.trim() || DEFAULTS.localBase).replace(/\/+$/, '');
}

function setStatus(text, isError = false) {
  rootStatusEl.textContent = text;
  rootStatusEl.classList.toggle('error', isError);
}

function describe(info) {
  if (!info.pinnedBy) return 'Saved in config.json next to server.js.';
  const by = info.pinnedBy === 'argument' ? 'a folder argument' : 'DA_LIVE_ROOT';
  return `The server was started with ${by}, which wins again on restart.`;
}

async function callApi(init) {
  let resp;
  try {
    resp = await fetch(`${serverBase()}${API_PATH}`, { cache: 'no-store', ...init });
  } catch {
    throw new Error(`Server not running at ${serverBase()}. Start it with: node server.js`);
  }
  const data = await resp.json().catch(() => ({}));
  if (resp.status === 403) {
    throw new Error(`The server rejected this extension. Add "extensionId": "${chrome.runtime.id}" to config.json and restart it.`);
  }
  if (resp.status === 404) throw new Error('This server is outdated. Restart server.js.');
  if (!resp.ok) throw new Error(data.error || `Server error ${resp.status}`);
  return data;
}

let rootRequest = 0;
async function loadRoot() {
  const seq = ++rootRequest;
  rootEl.disabled = true;
  setStatus('Checking server…');
  try {
    const info = await callApi();
    if (seq !== rootRequest) return;
    rootEl.value = info.root;
    rootEl.disabled = false;
    setStatus(describe(info));
  } catch (e) {
    if (seq === rootRequest) setStatus(e.message, true);
  }
}

async function saveRoot() {
  const value = rootEl.value.trim();
  if (!value) {
    loadRoot();
    return;
  }
  const seq = ++rootRequest;
  rootEl.disabled = true;
  setStatus('Saving…');
  try {
    const info = await callApi({
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ root: value }),
    });
    if (seq !== rootRequest) return;
    rootEl.value = info.root;
    setStatus(describe(info));
    // Reload da.live tabs (if the override is on) so they use the new folder.
    chrome.runtime.sendMessage({ type: 'reapply' }).catch(() => { });
  } catch (e) {
    if (seq === rootRequest) setStatus(e.message, true);
  } finally {
    if (seq === rootRequest) rootEl.disabled = false;
  }
}

async function load() {
  const { config } = await chrome.storage.local.get('config');
  const c = { ...DEFAULTS, ...(config || {}) };
  enabledEl.checked = !!c.enabled;
  localBaseEl.value = c.localBase;
  pathsEl.value = c.paths.join(', ');
  loadRoot();
}

async function save() {
  const paths = pathsEl.value
    .split(',')
    .map((p) => p.trim())
    .filter(Boolean);
  const config = {
    enabled: enabledEl.checked,
    localBase: localBaseEl.value.trim() || DEFAULTS.localBase,
    paths: paths.length ? paths : DEFAULTS.paths,
  };
  await chrome.storage.local.set({ config });
}

enabledEl.addEventListener('change', save);
localBaseEl.addEventListener('change', async () => {
  await save();
  loadRoot();
});
rootEl.addEventListener('change', saveRoot);
pathsEl.addEventListener('change', save);

load();
