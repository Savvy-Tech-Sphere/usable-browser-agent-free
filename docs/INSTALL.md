# Install (Mac-first)

> **Free tier note.** You are reading the docs shared with the commercial bundle. For the free
> tier, the Firefox extension installs from Firefox Add-ons
> (<https://addons.mozilla.org/firefox/addon/usable-browser-agent-free/>), so skip any step
> about a `.xpi` file, `BUNDLE-MANIFEST.json`, or the `chrome/` folder; those ship only in the
> commercial bundle. The server steps are identical.

Usable Browser Agent has two pieces: a small **Node MCP server** (your agent
launches it) and a **browser extension** for Firefox or Chrome (you install it
once). The installer wires up the server side for you; you do the few-click
extension install yourself.

This guide is written for **macOS** (the supported, full-featured platform). The
core browser tools and the credential broker also work on Windows and Linux; only
the last-mile OS-level input tools are macOS-only.

---

## What you have

The purchased bundle unpacks to one folder, `usable-browser-agent-<version>/`:

- `server/` and `bin/uba-install.mjs`: the MCP server and this installer.
- `usable-browser-agent-<version>.xpi`: the Firefox extension carrying a
  Mozilla signature block (an unsigned build is named
  `usable-browser-agent-<version>-unsigned.zip` instead; see step 3 for what
  that changes).
- `chrome/`: the unpacked Chrome (Manifest V3) extension, and
  `uba-chrome-<version>.zip`, the same build zipped.
- `README.md`, `docs/`, `legal/`: this guide, troubleshooting, uninstall,
  credential safety, and the license terms.
- `BUNDLE-MANIFEST.json`: every file in the bundle with its SHA-256, and for
  the two extension artifacts their version and provenance. The provenance
  states only what the build verified: that the XPI's signature block digests
  cover exactly the shipped files (`payloadDigestsVerified`); the build does
  not verify the RSA signature or the certificate chain
  (`signatureBytesVerified: false`, `certificateChainVerified: false`),
  Firefox validates both when you install it. An unsigned build is described
  as such, and release Firefox will not install it permanently.
- `test/`: the two deterministic checks behind `npm test` (workflow memory and
  the credential-broker claims), no browser needed. `npm run smoke` boots the
  server and lists its tools.

A source checkout has the same server and installer and builds the extension
artifacts itself (`npm run package`). The product builds three extension
artifacts from one shared core: the commercial Firefox XPI, the Chrome zip, and
a free personal/eval Firefox zip. The free build is a source artifact and is
not part of the purchased bundle.

## 1. Install Node.js (18 or newer)

Check what you have:

```bash
node --version
```

If it prints `v18` or higher, you are set. If not, install Node from
<https://nodejs.org> (the "LTS" download) or, with Homebrew:

```bash
brew install node
```

## 2. Run the installer

From the folder you unpacked Usable Browser Agent into:

```bash
cd path/to/usable-browser-agent
node bin/uba-install.mjs        # equivalently: npm run setup
```

The installer walks through everything and is safe to re-run:

1. **Node check**: confirms Node 18 or newer.
2. **Port check**: confirms `127.0.0.1:8876` is free (where the MCP server hosts
   the WebSocket the extension dials into). A warning here is fine if it is your
   own agent's server already running.
3. **Dependencies**: runs `npm install` if needed.
4. **Claude Code**: runs `claude mcp add browser --scope user -e UBA_PORT=8876 -- node <your-copy>/server/index.js`
   (or prints the command if the `claude` CLI is not found). If a `browser` server
   is already registered, it leaves it alone.
5. **Codex**: appends a `[mcp_servers.browser]` block to `~/.codex/config.toml`,
   pointing at your copy. If one already exists, it leaves it alone.
6. **Smoke test**: boots the server, lists the tools, confirms the bridge listens
   (no browser required) and reports PASS/FAIL.
7. **Add a login (optional)**: a guided prompt that stores one site login in
   `~/.config/usable-browser-agent/secrets.json` (mode `0600`). You can skip this
   and add logins later. The password is typed hidden and the agent never sees it;
   see [CREDENTIAL-SAFETY.md](CREDENTIAL-SAFETY.md).
8. **macOS permissions**: prints the Accessibility-grant steps and offers to
   `brew install cliclick` (only needed for raw OS-level clicks).
9. **Firefox extension**: prints the exact install steps for the Firefox
   artifact found in this copy.
10. **Chrome extension**: the same for the Chrome build.

Pass `--non-interactive` (or set `UBA_NON_INTERACTIVE=1`) to accept every default
without prompting: no login is stored and no Homebrew install is attempted. That
is the mode to use from a script or a terminal without a TTY.

> The MCP server config points at the **absolute path of the copy you ran the
> installer from**. If you move the folder, re-run the installer: existing
> registrations are left in place, and it prints the exact remove-and-re-add
> command for Claude Code and the `args` line to edit for Codex.

## 3. Install the Firefox extension (Firefox 142 or newer)

Firefox only permanently installs **signed** extensions in the normal release
build, so you install the signed `.xpi`:

1. Open **Firefox** (must be **version 142 or newer**; check `about:support`).
2. Go to **`about:addons`**.
3. Click the **gear icon**, then **Install Add-on From File**.
4. Choose **`usable-browser-agent-<version>.xpi`**, then **Add**.

The toolbar badge shows **off**, then turns **ON** once your agent's MCP server is
running and the extension connects to it.

**Where do I get the `.xpi`?** The signed build ships with your purchase. If you
are building from source, produce one with your own free Mozilla AMO credentials:

```bash
WEB_EXT_API_KEY='user:12345:67' WEB_EXT_API_SECRET='<hex>' npm run package
```

That prints the path to the signed `.xpi` in `web-ext-artifacts/`. Without
credentials the same command produces an unsigned zip, which Firefox Developer
Edition, Nightly and ESR accept once `xpinstall.signatures.required` is `false`
in `about:config`. For development only, you can instead *Load Temporary Add-on*
from `about:debugging#/runtime/this-firefox`; that unloads when Firefox restarts.

## 4. Install the Chrome extension (Chrome 116 or newer)

The Chrome Web Store listing is drafted but not published yet, so Chrome uses the
unpacked build:

1. Open **Chrome** and go to **`chrome://extensions`**.
2. Turn on **Developer mode** (top right).
3. Click **Load unpacked** and select the **`chrome/`** folder from the bundle
   (from source: `npm run build:chrome`, then select `dist/chrome/`).

Chrome shows a "developer mode extensions" notice on startup for unpacked
builds; that is expected. The badge behaves exactly as on Firefox: **off**, then
**ON** once connected. Chrome-specific limits (no `browser_save_pdf`,
`browser_eval` runs in the page realm) are listed in the README.

## 5. First success

1. Make sure your agent (Claude Code or Codex) is running; it auto-launches the
   MCP server, which hosts the WebSocket on `127.0.0.1:8876`.
2. In the browser, confirm the toolbar badge shows **ON**.
3. **Log into a site** you are comfortable letting an agent act on.
4. Ask your agent something like: *"On the active tab, search for X and open the
   first result."*

If the badge stays **OFF** or anything misbehaves, see
[TROUBLESHOOTING.md](TROUBLESHOOTING.md).

## Hardened mode is the default

Out of the box `browser_eval` (the arbitrary-JavaScript escape hatch) is disabled
and screenshots are blocked whenever a password field is on the page. That keeps
the "your passwords never touch the model" guarantee intact without any
configuration. If you need `browser_eval`, opt out by setting
`UBA_STRICT_SECRETS=0` in the server's environment.

For Claude Code the installer has already registered `browser`, and `claude mcp add`
refuses an existing name, so remove it and re-add it with the extra variable. Keep
`UBA_PORT` at the port you installed with (8876 by default):

```bash
claude mcp remove browser --scope user && \
claude mcp add browser --scope user -e UBA_PORT=8876 -e UBA_STRICT_SECRETS=0 -- node <your-copy>/server/index.js
```

If you installed with `UBA_SECRETS_FILE` set, add `-e UBA_SECRETS_FILE=<absolute path>` to that command as well, or the server falls back to the default vault and your stored logins stop resolving. Re-running the installer prints the exact command for your copy.

For Codex, add `UBA_STRICT_SECRETS = "0"` under `[mcp_servers.browser.env]` in
`~/.codex/config.toml`. Restart your agent afterwards so the server picks it up.

## A note on what to log into

This tool acts as **you** on whatever you are logged into. The security boundary
is you: only log into low-risk sites you have approved for agent use. See
[CREDENTIAL-SAFETY.md](CREDENTIAL-SAFETY.md) for how your credentials are kept
out of the agent and what that does, and does not, protect.
