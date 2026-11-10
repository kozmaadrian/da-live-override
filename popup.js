const DEFAULTS = {
  enabled: false,
  localBase: 'http://localhost:5757',
  paths: ['scripts', 'blocks', 'styles', 'deps', 'fonts', 'icons', 'img', 'tools'],
};

const enabledEl = document.querySelector('#enabled');
const localBaseEl = document.querySelector('#localBase');
const pathsEl = document.querySelector('#paths');
const serverStatusEl = document.querySelector('#serverStatus');
const serverHelpEl = document.querySelector('#serverHelp');
let serverRequest = 0;

function hideServerHelp() {
  if (serverHelpEl.contains(document.activeElement)) localBaseEl.focus();
  serverHelpEl.hidden = true;
  serverHelpEl.dataset.dismissed = 'false';
}

for (const event of ['pointerenter', 'focusin']) {
  serverHelpEl.addEventListener(event, () => {
    serverHelpEl.dataset.dismissed = 'false';
  });
}
serverHelpEl.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') serverHelpEl.dataset.dismissed = 'true';
});

async function checkServer() {
  const seq = ++serverRequest;
  hideServerHelp();
  serverStatusEl.dataset.state = 'checking';
  serverStatusEl.textContent = 'Checking...';
  serverStatusEl.title = '';
  const base = (localBaseEl.value.trim() || DEFAULTS.localBase).replace(/\/+$/, '');
  try {
    const response = await fetch(`${base}/__da-live-override/health`, {
      cache: 'no-store',
      signal: AbortSignal.timeout(3000),
    });
    const info = await response.json();
    if (!response.ok || info.service !== 'da-live-override') {
      throw new Error('The local server did not return a valid health response.');
    }
    if (seq !== serverRequest) return;
    serverStatusEl.dataset.state = 'reachable';
    serverStatusEl.textContent = 'Reachable';
    serverStatusEl.title = 'Local server is responding.';
  } catch (error) {
    if (seq !== serverRequest) return;
    serverStatusEl.dataset.state = 'unreachable';
    serverStatusEl.textContent = 'Unreachable';
    serverStatusEl.title = `Cannot reach ${base}. Start or restart node server.js. ${error.message}`;
    serverHelpEl.hidden = false;
  }
}

async function load() {
  const { config } = await chrome.storage.local.get('config');
  const c = { ...DEFAULTS, ...(config || {}) };
  enabledEl.checked = !!c.enabled;
  localBaseEl.value = c.localBase;
  pathsEl.value = c.paths.join(', ');
  checkServer();
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
  checkServer();
  await save();
});
pathsEl.addEventListener('change', save);

load();
