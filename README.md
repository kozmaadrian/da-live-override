# da-live local override

A Chrome extension that lets you run **da.live with your own local code** —
without breaking login.

You point it at a local checkout of [da-live](https://github.com/adobe/da-live),
flip a switch, and the extension swaps da.live's scripts, blocks, styles, and
other code for the files on your machine. The page stays on `https://da.live`
the whole time, so authentication (IMS) keeps working exactly as before.

## Why not just run da-live locally?

da-live's login bootstrap imports from `window.location.origin`. If you open the
app on `localhost`, those imports resolve to localhost and **auth breaks**.

This extension sidesteps that: it keeps the real `https://da.live` URL and
origin, and only replaces the *bytes* of the code responses with your local
files. As far as the page is concerned, it's still loading
`https://da.live/scripts/…` — the content just happens to be yours.

## How it works

The extension uses Chrome's debugger API to attach the DevTools
[Fetch domain](https://chromedevtools.github.io/devtools-protocol/tot/Fetch/)
to da.live tabs. For each matching code request it:

1. Fetches the same path from your local file server (`localhost:5757`).
2. Fulfills the original request in place with those bytes
   (`Fetch.fulfillRequest`) — **without changing the URL**.

If the file doesn't exist locally, the request falls through to da.live
unchanged. This is the same mechanism as DevTools "Local Overrides." The local
server is purely a file source — nothing runs on it; your code executes inside
da.live's own origin.

> **Note:** `nx`/`nx2` is unaffected — it's still loaded via
> `?nx=local&nxver=2` from `localhost:6456`. This extension only swaps
> da-live's own code.

## Setup

### 1. Start the local file server

The bundled `server.js` is a dumb static file server — it only returns files, no
app, no proxy, no auth. Start it from this folder:

```bash
node server.js
```

Then pick your da-live checkout in the extension popup's **da-live folder**
field (step 3). The server saves it to `config.json` next to `server.js` and
remembers it across restarts. `config.json` is gitignored, so your local path
never ends up in the repo.

Instead of using the popup, you can also:

- copy `config.example.json` to `config.json` and edit `root` (and `port`), or
- pass the folder (and port) for a single run, which takes priority over
  `config.json`:

  ```bash
  node server.js /path/to/da-live 5757
  ```

The `DA_LIVE_ROOT` and `DA_LIVE_PORT` environment variables work the same way as
the arguments. If you change the port, update **Local server** in the popup to
match.

### 2. Load the extension

1. Open `chrome://extensions`
2. Enable **Developer mode**
3. Click **Load unpacked** and select this folder

### 3. Turn it on

1. Click the extension icon, check that **da-live folder** shows your checkout
   (type a different absolute path and press Enter/Tab to switch), and flip
   **Override enabled** on (the badge shows `ON`).
2. Open a da.live page, e.g.
   `https://da.live/form?nx=local&nxver=2#/org/site/path/to/form`,
   and **reload once** so interception starts from the very first request.
3. A `local override: enabled` label appears at the top of the page while it's
   active. Chrome also shows its own *"… started debugging this browser"* banner —
   that's the Fetch interception. Toggle the extension off (or click **Cancel**
   on the banner) to stop.

### About the "debugging" banner

Chrome shows that banner in **every** tab while any debugger session is open —
an extension can't limit it to certain tabs. To keep it off unrelated tabs, the
extension only stays attached to the da.live tab you're looking at (the active
tab of the focused window). Switch to another tab and it detaches; Chrome clears
the banner about 5 seconds later. Switching back re-attaches. Switching to
another app (e.g. your editor) keeps it attached.

Background da.live tabs (e.g. opened with ⌘-click) are attached while they load,
plus a few seconds, so they still get your local code. The trade-off: code a
background da.live tab loads lazily *after* that, while you're on another tab,
comes from da.live. Reload the tab if something looks off.

## Configuration

Open the popup to adjust:

| Setting | Description | Default |
| --- | --- | --- |
| **Local server** | Base URL of your file server. | `http://localhost:5757` |
| **da-live folder** | Your local da-live checkout. Stored by the server in `config.json` (not in Chrome), so it's only editable while the server runs. Changing it reloads da.live tabs when the override is on. | the folder `server.js` was started from |
| **Paths to override** | Comma-separated top-level da.live paths to serve locally. | `scripts, blocks, styles, deps, fonts, icons, img, tools` |

Trim the path list if a folder only exists on the CDN — otherwise that file 404s
locally and the extension falls back to da.live for it anyway, but you save a
round trip by not listing it.

## Good to know

- **Auth always works**, even with `scripts` overridden — that's the whole point
  of fulfilling requests in place instead of redirecting to localhost.
- **Missing files fall back gracefully** — if a path is in your list but the file
  isn't on the local server, da.live serves it.
- **Always reload after toggling.** Interception must start before the page
  requests its code.
- **Only `da.live` and `da.page` tabs are touched,** and only while in front or
  loading. Navigating away from those hosts detaches the debugger.

## Server security

The **da-live folder** setting lets the server serve any folder, so the server
locks it down:

- It answers only connections from your own machine (loopback), never the
  network.
- Only this extension can read or change the folder. The server works out the
  extension's ID from its own location (Chrome derives an unpacked extension's ID
  from its folder path). If you load the extension from a different folder than
  the one `server.js` runs from, the popup shows an error. Fix it by adding
  `"extensionId": "<id from chrome://extensions>"` to `config.json` and
  restarting the server.
- Dotfiles and dot-folders (`.git`, `.env`, …) are never served.

## Files

| File | Purpose |
| --- | --- |
| `manifest.json` | Extension manifest (Manifest V3). |
| `background.js` | Service worker — attaches the debugger and fulfills requests. |
| `popup.html` / `popup.js` | The toggle and settings UI. |
| `server.js` | Static file server for your local da-live checkout. |
| `config.example.json` | Template for `config.json` (your local, gitignored server settings). |
