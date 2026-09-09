# Troubleshooting

> **Free tier note.** You are reading the docs shared with the commercial bundle. For the free
> tier, the Firefox extension installs from Firefox Add-ons
> (<https://addons.mozilla.org/firefox/addon/usable-browser-agent-free/>), so skip any step
> about a `.xpi` file, `BUNDLE-MANIFEST.json`, or the `chrome/` folder; those ship only in the
> commercial bundle. The server steps are identical.

Self-service fixes for the things that actually go wrong. Most issues are one of:
the server is not running, the port is taken, the extension is not the build you
think it is, or a macOS permission is not granted.

---

## The toolbar badge stays OFF

The badge is **ON** only when the extension is connected to the MCP server's
WebSocket. **OFF means the server is not running** (or is not reachable).

1. **Start your agent.** The MCP server is launched *by your agent* (Claude Code
   or Codex); it is not a separate daemon you start by hand. Open or relaunch your
   agent so it spins up the `browser` MCP server. The server hosts the WebSocket on
   `127.0.0.1:8876`; the extension dials out to it.
2. **Confirm the agent has the server registered.** For Claude Code:
   `claude mcp list` should show `browser`. For Codex, check that
   `~/.codex/config.toml` has a `[mcp_servers.browser]` block. Re-run
   `node bin/uba-install.mjs` to (re)register it.
3. **Reload the extension** after starting the server. Firefox: `about:addons`,
   toggle the add-on off and on. Chrome: `chrome://extensions`, click the reload
   arrow on the card. The extension also reconnects on its own; the newest
   connection wins.
4. **One browser at a time.** Only one extension connection is held at once. If
   Firefox and Chrome are both connected, the newest wins and the other goes OFF.

## Port 8876 is already in use

The MCP server hosts its WebSocket on `127.0.0.1:8876`. If something else holds
that port, the server cannot start (and the installer warns about it).

- If it is **your own agent's server already running**, that is expected; nothing
  to do.
- To see what is on it (macOS/Linux):
  ```bash
  lsof -nP -iTCP:8876 -sTCP:LISTEN
  ```
- To use a **different port**: set `UBA_PORT` for the server (in your agent's MCP
  env) **and** update `PORT` in the extension's `background.js` to match, then
  reload the extension. The two must agree.

## Firefox rejects the add-on

Release Firefox only permanently installs **signed** extensions, and this add-on
requires a recent Firefox.

- **Use the signed `.xpi`.** Install via `about:addons`, gear icon,
  *Install Add-on From File*, and pick `usable-browser-agent-<version>.xpi`. The
  signed build ships with your purchase; from source you generate one with
  `npm run package` using your own free Mozilla AMO credentials (see
  [INSTALL.md](INSTALL.md)).
- **Update Firefox to 142 or newer.** Check `about:support`. The add-on declares a
  `strict_min_version` of `142.0` and will not install on older Firefox.
- *Load Temporary Add-on* (from `about:debugging`) works for development but unloads
  on restart; it is not the permanent install.

## Chrome: "Load unpacked" problems

- Chrome 116 or newer is required (`chrome://version`).
- Select the **folder** that contains `manifest.json` (`chrome/` in the bundle,
  `dist/chrome/` from source), not the zip file.
- The "Disable developer mode extensions" notice at startup is expected for an
  unpacked extension until the Chrome Web Store listing is published.
- After updating the files, click the reload arrow on the extension's card in
  `chrome://extensions`.

## "browser_eval is disabled"

That is hardened mode, which is **on by default**: the arbitrary-JavaScript escape
hatch is off and screenshots are blocked whenever a password field is on the
page. If you need `browser_eval`, set `UBA_STRICT_SECRETS=0` in the server's
environment, then restart your agent so the server picks it up.

For Claude Code, `browser` is already registered (the installer did that) and
`claude mcp add` refuses an existing name, so remove and re-add it, keeping
`UBA_PORT` at the port you installed with (8876 by default):

```bash
claude mcp remove browser --scope user && \
claude mcp add browser --scope user -e UBA_PORT=8876 -e UBA_STRICT_SECRETS=0 -- node <your-copy>/server/index.js
```

If you installed with `UBA_SECRETS_FILE` set, add `-e UBA_SECRETS_FILE=<absolute path>` to that command as well, or the server falls back to the default vault and your stored logins stop resolving. Re-running the installer prints the exact command for your copy.

For Codex: add `UBA_STRICT_SECRETS = "0"` under `[mcp_servers.browser.env]` in
`~/.codex/config.toml`.

## OS-level input tool fails (`browser_os_*`, native dialogs)

The OS-level tools that drive the real keyboard/mouse and native dialogs are
**macOS-only**, and they need permissions:

- **macOS only.** On Windows/Linux these tools are unavailable by design. The core
  in-page tools and the credential broker still work fully.
- **Accessibility permission** (for trusted keystrokes and native-dialog control):
  System Settings, Privacy & Security, **Accessibility**, enable the app that
  runs the MCP server (your terminal, iTerm or IDE). Without it, OS keystrokes
  silently do nothing.
- **cliclick** (only for raw coordinate clicks, `browser_os_click*`):
  ```bash
  brew install cliclick
  ```
- Run `npm run native` (or the `browser_native_status` tool) to see exactly what is
  available and what is missing. Prefer the in-page tools (`browser_click`,
  `browser_type`, ...); reach for OS-level tools only when those genuinely fail.
- The OS-level tools focus Firefox or Chrome based on which extension is
  connected; set `UBA_BROWSER_APP_NAME` for a nonstandard install.

## "Secret refused on this site"

If a login fails with something like *"secret 'X' is not allowed on host Y"*, that
is the credential broker working **as designed**. Each stored login is
**domain-locked**: it will only ever be filled on the hostnames listed in its
`domains`. This is the anti-phishing guarantee: the agent cannot trick the broker
into typing your password on a lookalike or wrong site.

- Make sure the active tab is on the right domain.
- If the login legitimately spans more hosts (an SSO or auth subdomain, say), add
  those hostnames to that entry's `domains` array in
  `~/.config/usable-browser-agent/secrets.json`. Exact and subdomain matches are
  allowed (`github.com` matches `gist.github.com` but not `evilgithub.com`).

## Privileged pages do not respond

Firefox blocks **all** extensions on `about:` pages, addons.mozilla.org, the PDF
viewer and view-source; Chrome does the same on `chrome://` pages and the Chrome
Web Store. In-page tools cannot script them by design. On macOS, the OS-level
sidecar can still type and click there when needed.

## The smoke test fails

```bash
npm run smoke
```

It boots the server, lists tools, and confirms the bridge listens; no browser
needed. If it fails:

- Re-run `npm install` (a missing or old dependency is the usual cause).
- Make sure port 8876 (or your `UBA_PORT`) is free.
- Confirm Node is 18 or newer (`node --version`).

## Still stuck?

Re-running `node bin/uba-install.mjs` is safe and re-checks each step. See also
[INSTALL.md](INSTALL.md), [UNINSTALL.md](UNINSTALL.md), and, for anything about
how credentials are handled, [CREDENTIAL-SAFETY.md](CREDENTIAL-SAFETY.md).
