#!/usr/bin/env node
/*
 * Dumb static file server for serving a local da-live checkout to the
 * da-live-override Chrome extension. It does NOT run the app, proxy content,
 * or do anything but return the requested file (with CORS). The page itself
 * stays on da.live; this only answers the redirected code requests.
 *
 * Usage:
 *   node server.js [root] [port]
 *   node server.js /path/to/da-live 5757
 * Root:  argument > $DA_LIVE_ROOT > "root" in config.json > current directory.
 * Port:  argument > $DA_LIVE_PORT > "port" in config.json > 5757.
 *
 * config.json (next to this file, gitignored) is also written by the
 * extension popup's "da-live folder" setting through the config API below.
 */
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const CONFIG_FILE = path.join(__dirname, 'config.json');
const API_PATH = '/__da-live-override/config';

function readConfig() {
  try {
    return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
  } catch (e) {
    // eslint-disable-next-line no-console
    if (e.code !== 'ENOENT') console.warn(`Ignoring ${CONFIG_FILE}: ${e.message}`);
    return {};
  }
}

function writeConfig(patch) {
  const next = { ...readConfig(), ...patch };
  const tmp = `${CONFIG_FILE}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(next, null, 2)}\n`);
  fs.renameSync(tmp, CONFIG_FILE);
}

const expandHome = (p) => p.replace(/^~(?=$|\/)/, os.homedir());

const fileConfig = readConfig();

// An explicit argument or env var wins over config.json for this run.
let pinnedBy = null;
let rootSource = 'current directory';
let root = process.cwd();
if (process.argv[2]) {
  pinnedBy = 'argument';
  rootSource = 'argument';
  root = path.resolve(expandHome(process.argv[2]));
} else if (process.env.DA_LIVE_ROOT) {
  pinnedBy = 'DA_LIVE_ROOT';
  rootSource = 'DA_LIVE_ROOT';
  root = path.resolve(expandHome(process.env.DA_LIVE_ROOT));
} else if (typeof fileConfig.root === 'string' && fileConfig.root) {
  rootSource = 'config.json';
  root = path.resolve(__dirname, expandHome(fileConfig.root));
}
const PORT = Number(process.argv[3] || process.env.DA_LIVE_PORT || fileConfig.port || 5757);

// Chrome derives an unpacked extension's ID from its folder path, and this
// file lives in that folder. Only that extension (plus any "extensionId" in
// config.json) may use the config API.
function unpackedExtensionId(dir) {
  const hex = crypto.createHash('sha256').update(fs.realpathSync(dir)).digest('hex').slice(0, 32);
  return [...hex].map((c) => String.fromCharCode(97 + parseInt(c, 16))).join('');
}
const ALLOWED_ORIGINS = new Set(
  [unpackedExtensionId(__dirname), ...[].concat(fileConfig.extensionId || [])]
    .map((id) => `chrome-extension://${id}`),
);
const LOOPBACK_ADDR = /^(127\.|::1$|::ffff:127\.)/;
const LOCAL_HOST = /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/i;

const MIME = {
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.html': 'text/html; charset=utf-8',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.ttf': 'font/ttf',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.map': 'application/json; charset=utf-8',
};

function sendJson(res, status, body, origin) {
  const headers = { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' };
  if (origin) {
    headers['Access-Control-Allow-Origin'] = origin;
    headers.Vary = 'Origin';
  }
  res.writeHead(status, headers);
  res.end(JSON.stringify(body));
}

const rootInfo = () => ({ root, pinnedBy });

// GET returns the served folder; POST {"root": "/abs/path"} switches to it and
// saves it to config.json. It can point the server at any folder, so it is
// limited to this extension: other origins are rejected, and the Host check
// stops DNS-rebinding pages from posing as localhost.
function handleConfigApi(req, res) {
  const { origin, host } = req.headers;
  const trusted = LOCAL_HOST.test(host || '')
    && (origin ? ALLOWED_ORIGINS.has(origin) : req.method === 'GET');
  if (!trusted) {
    // eslint-disable-next-line no-console
    console.log(`403  ${req.method} ${API_PATH} from ${origin || 'no origin'}`);
    sendJson(res, 403, { error: `Origin not allowed: ${origin || '(none)'}` });
    return;
  }
  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': origin,
      'Access-Control-Allow-Methods': 'GET, POST',
      'Access-Control-Allow-Headers': 'Content-Type',
      Vary: 'Origin',
    });
    res.end();
    return;
  }
  if (req.method === 'GET') {
    sendJson(res, 200, rootInfo(), origin);
    return;
  }
  if (req.method !== 'POST') {
    sendJson(res, 405, { error: 'Method not allowed' }, origin);
    return;
  }

  let body = '';
  req.setEncoding('utf8');
  req.on('data', (chunk) => {
    body += chunk;
    if (body.length > 16384) req.destroy();
  });
  req.on('end', () => {
    let requested;
    try {
      requested = JSON.parse(body).root;
    } catch {
      sendJson(res, 400, { error: 'Expected JSON like {"root": "/path/to/da-live"}' }, origin);
      return;
    }
    const raw = typeof requested === 'string' ? expandHome(requested.trim()) : '';
    if (!raw || !path.isAbsolute(raw)) {
      sendJson(res, 400, { error: 'Enter an absolute folder path (or ~/…).' }, origin);
      return;
    }
    const next = path.resolve(raw);
    let isDir = false;
    try { isDir = fs.statSync(next).isDirectory(); } catch { /* missing */ }
    if (!isDir) {
      sendJson(res, 400, { error: `Not a folder: ${next}` }, origin);
      return;
    }
    try {
      writeConfig({ root: next });
    } catch (e) {
      sendJson(res, 500, { error: `Could not save config.json: ${e.message}` }, origin);
      return;
    }
    root = next;
    // eslint-disable-next-line no-console
    console.log(`root -> ${root} (saved to config.json)`);
    sendJson(res, 200, rootInfo(), origin);
  });
}

const server = http.createServer((req, res) => {
  // Local use only; never answer other machines on the network.
  if (!LOOPBACK_ADDR.test(req.socket.remoteAddress || '')) {
    res.writeHead(403, { 'Content-Type': 'text/plain' });
    res.end('Forbidden');
    return;
  }

  let urlPath;
  try {
    urlPath = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
  } catch {
    res.writeHead(400, { 'Content-Type': 'text/plain' });
    res.end('Bad Request');
    return;
  }

  if (urlPath === API_PATH) {
    handleConfigApi(req, res);
    return;
  }

  // CORS — the page on da.live loads these cross-origin (module scripts need it).
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, HEAD, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', '*');
  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  // Never serve dotfiles or dot-folders (.git, .env, …).
  if (urlPath.split('/').some((segment) => segment.startsWith('.'))) {
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end(`404 Not Found: ${urlPath}`);
    return;
  }

  const filePath = path.join(root, path.normalize(urlPath));

  // Never serve outside the root.
  if (filePath !== root && !filePath.startsWith(root.endsWith(path.sep) ? root : root + path.sep)) {
    res.writeHead(403, { 'Content-Type': 'text/plain' });
    res.end('Forbidden');
    return;
  }

  fs.stat(filePath, (err, stat) => {
    if (err || !stat.isFile()) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end(`404 Not Found: ${urlPath}`);
      // eslint-disable-next-line no-console
      console.log(`404  ${urlPath}`);
      return;
    }
    const type = MIME[path.extname(filePath).toLowerCase()] || 'application/octet-stream';
    // no-store so edits are always picked up on reload.
    res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'no-store' });
    if (req.method === 'HEAD') {
      res.end();
      return;
    }
    fs.createReadStream(filePath).pipe(res);
    // eslint-disable-next-line no-console
    console.log(`200  ${urlPath}`);
  });
});

server.listen(PORT, () => {
  // eslint-disable-next-line no-console
  console.log(`da-live static server\n  root: ${root} (from ${rootSource})\n  http://localhost:${PORT}/`);
  if (!fs.existsSync(root)) {
    // eslint-disable-next-line no-console
    console.warn('  warning: root folder does not exist — set it in the extension popup');
  }
});
