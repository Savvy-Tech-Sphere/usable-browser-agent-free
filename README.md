# Usable Browser Agent (free personal / evaluation tier)

An MCP server plus a browser extension that lets your AI agent (Claude Code, Codex, or any MCP
client) drive **your real browser**, with all your logged-in sessions, instead of a throwaway
automated browser. You log in once, by hand, and the agent operates as you.

This repository is the **free tier**: the same single-session MCP server as the commercial
build, licensed for personal, non-commercial use and for evaluating the product before buying.
The Firefox extension for it is published on Firefox Add-ons. Commercial use (in or for a
business, in paid client work, or inside a commercial product or service) needs the commercial
license, a one-time $39 purchase at <https://savvytechsphere.com/usable-browser-agent>, which
also includes the Chrome build. It comes with a 14-day, no-questions refund. There is no license
key in either tier and nothing checks for one; the tiers differ only in the license grant and
the extension identity.

> **Your passwords stay out of the agent.** When the agent logs you in, it passes only a secret
> *alias*, never the value. Credentials live in a local vault, are domain-locked (refused on the
> wrong site), and are redacted from everything the agent reads or screenshots. See
> [docs/CREDENTIAL-SAFETY.md](docs/CREDENTIAL-SAFETY.md).

## How it works

```
Claude Code / Codex / any MCP client
      |  MCP over stdio
      v
  MCP server (Node, this repo)  --hosts-->  WebSocket  ws://127.0.0.1:8876
      ^                                          ^
      | 53 browser_* tools                       | (extension connects out)
      +------------------------------------------+
                                       Firefox extension (from Firefox Add-ons)
                                       your real profile, your logins -> DOM actions on the active tab
```

The agent perceives pages through an accessibility/DOM snapshot where every interactive element
has a stable `[ref=eN]` handle, then clicks and types by ref. No coordinate guessing, no vision
model required. Everything runs on your machine: MCP over stdio, and the extension talks to the
server over a WebSocket bound to 127.0.0.1. Nothing leaves your computer.

The agent always acts on the currently active tab. Keep the tab you want it to use focused.

## Get started (about 2 minutes)

Two pieces: this **MCP server**, which your agent launches, and the **Firefox extension**, which
you install once from Firefox Add-ons.

### 1. Get the server and run the installer

Needs Node.js 18 or newer and Firefox 142 or newer (macOS first; see
[docs/INSTALL.md](docs/INSTALL.md)).

```bash
npm install -g usable-browser-agent
uba-install
```

Or from a checkout of this repository:

```bash
git clone https://github.com/Savvy-Tech-Sphere/usable-browser-agent-free.git
cd usable-browser-agent-free
node bin/uba-install.mjs        # or: npm run setup
```

(Prefer a download? Grab the zip from the
[Releases](https://github.com/Savvy-Tech-Sphere/usable-browser-agent-free/releases) page, unpack
it, and run the same command inside the folder.)

The installer checks Node and the port, installs dependencies, registers the MCP server with
**Claude Code** and/or **Codex** using this copy's absolute path, runs the smoke test, optionally
stores your first login, and prints the macOS permission steps. It is idempotent; re-running it
never clobbers an existing config. Pass `--non-interactive` to accept every default.

### 2. Install the Firefox extension (one time)

Install **Usable Browser Agent (free)** from Firefox Add-ons:
<https://addons.mozilla.org/firefox/addon/usable-browser-agent-free/>

The toolbar badge shows **off**, then **ON** once the extension connects to the MCP server your
agent launched. (The installer also prints these steps, plus the `.xpi` and Chrome steps that
apply to the commercial bundle; for the free tier the Add-ons listing is all you need.)

### 3. Log in and go

Log into the site(s) you want the agent to use, then ask your agent to run a browser task, for
example: *"On the active tab, open my notifications and list the pull requests waiting on me."*
It will snapshot the page, then act by ref.

Wiring by hand instead of the installer:

```bash
# Claude Code (user scope, works from anywhere afterward):
claude mcp add browser --scope user -e UBA_PORT=8876 -- node "$PWD/server/index.js"
```

```toml
# Codex: add to ~/.codex/config.toml (use the absolute path to your copy):
[mcp_servers.browser]
command = "node"
args = ["/ABSOLUTE/PATH/TO/usable-browser-agent-free/server/index.js"]

[mcp_servers.browser.env]
UBA_PORT = "8876"
```

Help: [docs/INSTALL.md](docs/INSTALL.md), [docs/TROUBLESHOOTING.md](docs/TROUBLESHOOTING.md),
[docs/UNINSTALL.md](docs/UNINSTALL.md).

## Hardened mode is the default

`browser_eval` (arbitrary JavaScript in the page) is off unless you opt in, and screenshots are
blocked near password fields. CAPTCHAs, anti-bot walls and two-factor prompts are deliberately not
automated: the agent asks you to step in, since it is your browser on your screen. One active tab
at a time.

## Usage

1. Open Firefox or Chrome, log into the site(s) you want the agent to use.
2. Make sure the extension badge shows **ON**.
3. Ask Claude Code / Codex to do something — e.g. *"On the active tab, search for X and add the
   first result to the cart."* It will snapshot the page, then act by ref.

## Workflow memory

Usable Browser Agent keeps a local workflow memory so agents do not rediscover the same changing
website flow every time. This is for reusable task knowledge such as "how to create a new app in
Google Play Console", including current page names, visible button labels, gotchas, and successful
step order.

Default file:

```text
~/.local/state/usable-browser-agent/workflow-memory.jsonl
```

Override with `UBA_MEMORY_FILE=/path/to/workflow-memory.jsonl`. The file is append-only JSONL,
created with mode `0600`. Normal recall ignores records that have been superseded or forgotten.
This memory is local to the machine and file path you configure; it is not synced unless you point
multiple agents at the same controlled file.

Expected agent loop:

1. Before a repeated or multi-step site task, call `browser_workflow_recall` with the task and/or
   site.
2. Use any matching memory as a starting point, then verify against the live page with
   `browser_snapshot`.
3. After a new or changed path succeeds, call `browser_workflow_remember` with the durable steps.
4. If an old memory is wrong, save a replacement with `supersedes: ["old_id"]`, or call
   `browser_workflow_forget` if it should disappear from recall.

`browser_status`, `browser_info`, `browser_navigate`, and `browser_snapshot` also return short
workflow-memory hints when the active tab's domain already has saved memories. Hints are
intentionally brief; call `browser_workflow_recall` for the full steps.

Do not save passwords, one-time codes, raw account identifiers that are not needed for the workflow,
or transient `[ref=eN]` handles. The memory store rejects saved steps containing transient refs and
sanitizes stored URLs by dropping query strings and replacing likely account/app/developer id path
segments. Save visible labels and page/section names instead, because refs are rebuilt after every
snapshot.

## Credential broker

`browser_login` and `browser_fill_secret` let an agent trigger a login without ever receiving the
credential value. The MCP client passes only a secret alias and element refs. Plaintext flows only:

```
secrets file -> MCP server -> local WebSocket -> browser extension -> DOM field
```

The default vault file is `~/.config/usable-browser-agent/secrets.json`; override it with
`UBA_SECRETS_FILE=/path/to/secrets.json`. The server creates the parent directory if needed and
warns if the secrets file is readable by group/other users; keep it at mode `0600`.

The file is a JSON array:

```json
[
  {
    "alias": "github",
    "domains": ["github.com"],
    "username": "octo@example.com",
    "password": "replace-with-real-secret"
  }
]
```

`domains` are allowed hostnames. Exact and subdomain matches are allowed, so `github.com` matches
`gist.github.com` but not `evilgithub.com`.

For logins, prefer the atomic fill-and-submit tool after taking a snapshot:

```text
browser_login({
  "secret": "github",
  "username_ref": "e12",
  "password_ref": "e13",
  "submit_ref": "e14"
})
```

`browser_login` fills the username when `username_ref` is provided and the secret has a username,
fills the password, then submits in one extension action. If `submit_ref` is omitted, it submits the
password field's enclosing form, with Enter as a fallback. The tool returns only a status string such
as `logged in via [e14]` or `submitted form`.

`browser_fill_secret` remains available for non-login flows:

```text
browser_fill_secret({ "ref": "e12", "secret": "github", "field": "username" })
browser_fill_secret({ "ref": "e13", "secret": "github", "field": "password" })
```

There is intentionally no `value` argument. If the active tab host is not allowed for the alias,
the server refuses the fill and does not send the value to the browser.

Read-back and screenshots are protected in layers:

- Password fields and fields filled by the credential broker are redacted in snapshots and
  `browser_get_value`.
- `browser_screenshot` is blocked while a broker fill/login is in progress, while a populated
  password field is present, or while any field is marked as secret-filled. After login navigation
  removes the credential fields, screenshots are allowed again.
- The server lazily loads the vault for redaction and scrubs configured secret values from every outbound tool result, including
  `browser_read_text` and `browser_eval` results.

Hardened mode is **on by default**: `browser_eval` (the arbitrary-JS escape hatch) is disabled and
screenshots are blocked whenever any password field exists, even if empty. If you need the
`browser_eval` escape hatch, opt out by setting `UBA_STRICT_SECRETS=0` in the server's environment.
For Claude Code, `browser` is already registered, and `claude mcp add` refuses an existing name, so
remove and re-add it, keeping `UBA_PORT` at the port you installed with (run from your install
folder):

```bash
claude mcp remove browser --scope user && \
claude mcp add browser --scope user -e UBA_PORT=8876 -e UBA_STRICT_SECRETS=0 -- node "$PWD/server/index.js"
```

If you installed with `UBA_SECRETS_FILE` set, add `-e UBA_SECRETS_FILE=<absolute path>` to that command as well, or the server falls back to the default vault and your stored logins stop resolving. Re-running the installer prints the exact command for your copy.

For Codex, add `UBA_STRICT_SECRETS = "0"` under `[mcp_servers.browser.env]`. Restart the agent so
the server picks it up.

Screenshot blocking is a temporal/state guard. Region-masking credential fields within an otherwise
returned image is a possible v2 and is not implemented yet.

## Tools (53)

| Tool | Purpose |
|---|---|
| `browser_workflow_recall` | Search local workflow memory before starting a repeated/changing-site task |
| `browser_workflow_remember` | Save verified reusable workflow steps, pitfalls, and durable UI cues |
| `browser_workflow_forget` | Tombstone stale, sensitive, or incorrect workflow memory |
| `browser_snapshot` | Accessibility/DOM tree with `[ref=eN]` handles — the primary perception tool |
| `browser_navigate` / `browser_back` / `browser_forward` / `browser_reload` | Navigation |
| `browser_click` | Click by ref — supports right/middle button, double-click, and ctrl/shift/alt/meta modifiers |
| `browser_drag` | Drag one element onto another (kanban, sortable lists, sliders) |
| `browser_type` | Type into a field by ref (optional `submit` = press Enter) |
| `browser_fill_form` | Fill many fields `[{ref,text}]` in one call |
| `browser_fill_secret` | Fill a username/password from a server-side secret alias |
| `browser_login` | Atomically fill username/password from a server-side secret alias and submit |
| `browser_select` | Choose a `<select>` option by label/value |
| `browser_hover` / `browser_press_key` / `browser_scroll` | Pointer & keyboard (scroll the window or a specific container; `to:'bottom'` for infinite scroll) |
| `browser_upload_file` | Attach local files to a file input or dropzone — no OS file picker involved |
| `browser_paste` | Deliver a real paste event to an element (rich editors), from text or the clipboard |
| `browser_clipboard_read` / `browser_clipboard_write` | Read/write clipboard text |
| `browser_clipboard_read_image` / `browser_clipboard_write_image` | Read/write clipboard images |
| `browser_set_dialog_policy` / `browser_dialogs` | Auto-answer `alert`/`confirm`/`prompt` (never block); see what the page asked |
| `browser_mock_geolocation` | Make `navigator.geolocation` return a fixed position (skip the permission prompt) |
| `browser_download` / `browser_downloads_list` | Download a URL to disk (no save dialog) and get its local path |
| `browser_save_pdf` | Save the current tab as a PDF to the downloads folder |
| `browser_network_log` | Inspect recent network requests (method, URL, status, errors) |
| `browser_http_auth` / `browser_clear_http_auth` | Answer native HTTP basic-auth prompts from a secret alias |
| `browser_read_text` / `browser_get_value` | Read page/element content |
| `browser_wait` / `browser_wait_for_text` | Waiting |
| `browser_list_tabs` / `browser_select_tab` / `browser_new_tab` / `browser_close_tab` | Tabs |
| `browser_status` / `browser_info` / `browser_screenshot` | Diagnostics & vision fallback |
| `browser_native_status` | Report OS-level input availability and any setup needed |
| `browser_os_type` / `browser_os_key` | Real OS-trusted keystrokes (for `isTrusted`-checking pages); macOS |
| `browser_os_click` / `browser_os_click_ref` | Real OS-trusted mouse clicks (screen coords or by element ref); macOS + cliclick |
| `browser_native_dialog` | Inspect/operate native browser dialogs (file picker, print, basic-auth, "Leave page?"); macOS |
| `browser_focus_browser` | Bring Firefox to the foreground for OS-level input; macOS |
| `browser_request_human_help` | Hand off to the human for CAPTCHAs / anti-bot walls / 2FA |
| `browser_eval` | Run JS in the page sandbox; disabled in hardened mode (the default), opt in with `UBA_STRICT_SECRETS=0` |

### Coverage tiers

The tool set is designed so an agent can complete *any* browser task a human could:

1. **In-page interactions** (clicks incl. right/double/modifier, drag-and-drop, typing, dialogs,
   container scrolling, clipboard) — handled entirely in the page.
2. **Browser-level capabilities** (downloads without the save dialog, save-as-PDF, HTTP basic-auth,
   network inspection, geolocation) — handled via WebExtension APIs.
3. **The last mile** — native chrome (file pickers, print/auth dialogs) and pages that demand
   OS-trusted input (`event.isTrusted`). The MCP server runs on your Mac, so `browser_os_*` and
   `browser_native_dialog` drive the real keyboard/mouse and native dialogs. See **OS-level input**.
4. **Human handoff** — CAPTCHAs and anti-bot walls are intentionally *not* automated;
   `browser_request_human_help` notifies you to step in, since it's your real browser on your screen.


## Notes & limits

- **Cross-origin iframes** are supported when Firefox can inject the extension content script
  into the frame; refs from child frames are prefixed internally and route back to that frame.
  Open Shadow DOM is also supported in snapshots and actions.
- **Privileged pages** (`about:`, `addons.mozilla.org`, the PDF viewer, view-source) can't be
  scripted by the extension — Firefox blocks extensions there by design. The OS-level sidecar
  (below) can still type/click in them when needed.
- **Native OS dialogs** (file picker, print, basic-auth prompts) are handled three ways: the file
  picker never needs to open (`browser_upload_file` sets the input directly, and `browser_click`
  refuses file inputs); basic-auth is answered by `browser_http_auth`; anything else can be driven
  with `browser_native_dialog` on macOS.
- **CAPTCHAs / anti-bot walls** are intentionally not automated. Use `browser_request_human_help`
  to hand off to yourself — it's your real browser on your screen.
- **Port** is `8876` (`UBA_PORT`). The published extension connects to that port, so keep the
  default in the free tier.
- Only one browser/extension connects at a time; the newest extension hello wins (handles
  reloads). Bare sockets on the port are ignored until they identify as the extension.
- **`UBA_BROWSER_APP_NAME`** (macOS, optional): overrides which application the OS-level input
  tools focus before a trusted click. Defaults to `Firefox` or `Google Chrome` based on which
  extension build is connected; set it for nonstandard installs (Chromium, Chrome for Testing).
  If an explicit override cannot be focused, OS-level clicks fail loudly instead of clicking
  whatever is frontmost.
- The MCP server never touches cookies or the network itself — it only relays structured commands
  to the extension, which acts inside your browser.

## OS-level input (macOS)

For the last mile — native browser chrome and pages that reject synthetic input by checking
`event.isTrusted` — the MCP server can drive the real keyboard and mouse, because it runs on your
Mac (not inside the extension sandbox). These tools are `browser_os_type`, `browser_os_key`,
`browser_os_click`, `browser_os_click_ref`, `browser_native_dialog`, and `browser_focus_browser`.

Prefer the in-page tools (`browser_click`, `browser_type`, …) — they're faster and more reliable.
Reach for the OS-level tools only when those genuinely don't work.

**One-time setup:**

1. **Accessibility permission** (needed for trusted keystrokes and native-dialog control):
   System Settings → Privacy & Security → Accessibility → enable the app that runs the MCP server
   (your terminal, iTerm, or IDE). Without it, `System Events` keystrokes silently do nothing.
2. **cliclick** (needed only for raw coordinate clicks — `browser_os_click*`):
   ```bash
   brew install cliclick
   ```

Run `browser_native_status` (or `npm run native`) to see what's available. Trusted keystrokes and
native-dialog control work with just the Accessibility grant; raw clicks additionally need cliclick.


## Verify it works

```bash
npm run smoke    # MCP server boots, lists tools, bridge listens (no Firefox needed)
npm test         # credential-safety claims + workflow-memory unit tests (no Firefox needed)
```

## Security

This tool lets an AI agent take real actions as you on whatever you are logged into. **Only log
into low-risk sites you have approved for this use.** Treat the active tab as live: anything the
agent can do there, it may do. Log out of (or do not open) anything sensitive while using it.

For how credentials are kept out of the agent (alias-only logins, domain-locking, redaction,
hardened mode) and what that does **not** protect against, see
[docs/CREDENTIAL-SAFETY.md](docs/CREDENTIAL-SAFETY.md).

## License and legal

Usable Browser Agent is proprietary software from **Savvy Tech Sphere, LLC**. This free tier is
governed by [LICENSE.txt](LICENSE.txt) (personal, non-commercial use and evaluation). The
commercial license is a one-time $39 purchase at <https://savvytechsphere.com/usable-browser-agent>
(seller of record: Lemon Squeezy), sold as is and self-serve, with a 14-day refund window and no
individual support. Details of what each tier includes: [docs/FREE-TIER.md](docs/FREE-TIER.md).

- [legal/ACCEPTABLE-USE.md](legal/ACCEPTABLE-USE.md): automate only your own accounts; follow each site's terms
- [legal/PRIVACY.md](legal/PRIVACY.md): the software collects nothing; it runs entirely on your machine

Questions go through the contact form at <https://savvytechsphere.com/#contact>.
