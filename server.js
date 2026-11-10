#!/usr/bin/env node
/*
 * Dumb static file server for serving a local da-live checkout to the
 * da-live-override Chrome extension. It does NOT run the app, proxy content,
 * or do anything but return the requested file (with CORS). The page itself
 * stays on da.live; this only answers the redirected code requests.
 *
 * Usage:
 *   node server.js                     asks for your da-live folder
 *   node server.js /path/to/da-live    skips the question
 *   node server.js /path/to/da-live 5757
 * Root:  argument > $DA_LIVE_ROOT > prompt (defaults to "root" in config.json).
 *        Without a terminal: "root" in config.json > current directory.
 * Port:  argument > $DA_LIVE_PORT > "port" in config.json > 5757.
 *
 * The folder you enter is saved to config.json next to this file (gitignored)
 * and offered as the default next time.
 */
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const readline = require('readline/promises');

const CONFIG_FILE = path.join(__dirname, 'config.json');

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

function isDir(p) {
  try { return fs.statSync(p).isDirectory(); } catch { return false; }
}

const fileConfig = readConfig();
const savedRoot = typeof fileConfig.root === 'string' && fileConfig.root
  ? path.resolve(__dirname, expandHome(fileConfig.root))
  : null;
const PORT = Number(process.argv[3] || process.env.DA_LIVE_PORT || fileConfig.port || 5757);
const LOOPBACK_ADDR = /^(127\.|::1$|::ffff:127\.)/;

let root;

// Tab-completes folder names in the prompt.
function completeFolder(line) {
  const typed = line.trimStart();
  if (typed === '~') return [['~/'], typed];
  const full = expandHome(typed);
  const base = full.endsWith('/') ? '' : path.basename(full);
  const dir = full.endsWith('/') ? full : path.dirname(full);
  let names = [];
  try {
    names = fs.readdirSync(path.resolve(dir), { withFileTypes: true })
      .filter((d) => d.name.startsWith(base) && (base.startsWith('.') || !d.name.startsWith('.')))
      .filter((d) => d.isDirectory() || (d.isSymbolicLink() && isDir(path.join(dir, d.name))))
      .map((d) => d.name);
  } catch { /* unreadable folder: no suggestions */ }
  const prefix = typed.slice(0, typed.length - base.length);
  return [names.map((n) => `${prefix}${n}/`), typed];
}

// Drag-and-drop from Finder pastes escaped (`my\ folder`) or quoted paths.
function cleanAnswer(answer) {
  return answer.trim().replace(/^(['"])(.*)\1$/, '$2').replace(/\\(.)/g, '$1');
}

async function askForRoot() {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    completer: completeFolder,
  });
  rl.on('SIGINT', () => {
    rl.close();
    process.stdout.write('\n');
    process.exit(130);
  });
  try {
    for (;;) {
      const hint = savedRoot ? ` [${savedRoot}]` : '';
      // eslint-disable-next-line no-await-in-loop
      const answer = cleanAnswer(await rl.question(`da-live folder${hint}: `));
      const dir = answer ? path.resolve(expandHome(answer)) : savedRoot;
      if (dir && isDir(dir)) return dir;
      if (dir) console.log(`  Not a folder: ${dir}`); // eslint-disable-line no-console
    }
  } finally {
    rl.close();
  }
}

async function chooseRoot() {
  if (process.argv[2]) return { dir: path.resolve(expandHome(process.argv[2])), source: 'argument' };
  if (process.env.DA_LIVE_ROOT) {
    return { dir: path.resolve(expandHome(process.env.DA_LIVE_ROOT)), source: 'DA_LIVE_ROOT' };
  }
  if (!process.stdin.isTTY) {
    return savedRoot
      ? { dir: savedRoot, source: 'config.json' }
      : { dir: process.cwd(), source: 'current directory' };
  }
  const dir = await askForRoot();
  if (dir !== savedRoot) {
    try {
      writeConfig({ root: dir });
    } catch (e) {
      console.warn(`  Could not save to config.json: ${e.message}`); // eslint-disable-line no-console
    }
  }
  return { dir, source: dir === savedRoot ? 'config.json' : 'saved to config.json' };
}

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

  // CORS — the page on da.live loads these cross-origin (module scripts need it).
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, HEAD, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', '*');
  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  if (urlPath === '/__da-live-override/health' && (req.method === 'GET' || req.method === 'HEAD')) {
    res.writeHead(200, {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
    });
    res.end(req.method === 'HEAD' ? undefined : JSON.stringify({ service: 'da-live-override' }));
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

chooseRoot().then(({ dir, source }) => {
  root = dir;
  server.listen(PORT, () => {
    // eslint-disable-next-line no-console
    console.log(`da-live static server\n  root: ${root} (${source})\n  http://localhost:${PORT}/`);
    if (!isDir(root)) {
      // eslint-disable-next-line no-console
      console.warn('  warning: root folder does not exist');
    } else if (!isDir(path.join(root, 'scripts'))) {
      // eslint-disable-next-line no-console
      console.warn('  warning: no scripts/ folder here — is this a da-live checkout?');
    }
  });
});
