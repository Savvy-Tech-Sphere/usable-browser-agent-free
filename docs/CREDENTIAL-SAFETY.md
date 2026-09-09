# Credential Safety

How Usable Browser Agent lets an AI agent log you in **without ever seeing your passwords** —
and, just as important, what it does *not* protect against.

## Threat model in one line

This protects the **confidentiality of your credentials from the agent/LLM**. It does **not**
sandbox what the agent can do on a site you are already logged into. The ultimate boundary is
*you*: only log into low-risk sites you've approved for agent use.

## The guarantees

1. **Alias-only — the agent never receives the credential.** The agent calls `browser_login` /
   `browser_fill_secret` with a **secret alias** plus element refs. There is intentionally **no
   `value` argument**. The username/password is read from a local vault by the MCP server and
   injected into the page; it never enters the model's context or any tool argument the agent
   controls.

2. **Local-only path.** Plaintext only ever flows:

   ```
   local vault file  ->  MCP server (your machine)  ->  ws://127.0.0.1  ->  Firefox extension  ->  DOM field
   ```

   It never goes to a cloud service, to us, or to the LLM. **HTTP basic-auth** (`browser_http_auth`)
   uses the exact same path: the agent passes only an alias, the server resolves the secret and
   hands the username/password to the extension over loopback, scoped to the alias's `domains`, and
   the extension answers the native auth prompt via `webRequest.onAuthRequired`. The value is never
   accepted as a tool argument and never returned.

3. **Domain-locked (anti-phishing).** Each alias declares allowed `domains`. A fill is **refused**
   unless the active tab's host is an exact or subdomain match. `github.com` matches
   `gist.github.com` but **not** `evilgithub.com` or `github.com.evil.test`. On a disallowed host
   the value is never sent to Firefox.

4. **Redacted from everything the agent reads.** Password fields and broker-filled fields are
   redacted in `browser_snapshot` and `browser_get_value`. The server also **scrubs** known secret
   values out of *every* outbound tool result — including `browser_read_text` and `browser_eval` —
   replacing them with `[redacted]`.

5. **Screenshots blocked around secrets.** `browser_screenshot` is refused while a fill/login is in
   progress, while a populated password field is present, or while any secret-filled field exists.
   Once login navigation clears those fields, screenshots are allowed again.

6. **Hardened mode is the default.** Out of the box, `browser_eval` (the arbitrary-JavaScript
   escape hatch, which could otherwise read a filled secret straight off the page) is **disabled**,
   and screenshots are blocked whenever *any* password field is present, even if empty. This keeps
   the "your passwords never touch the model" guarantee intact by default. Power users who need the
   `browser_eval` escape hatch can opt out with `UBA_STRICT_SECRETS=0`.

7. **Local vault hygiene.** The vault lives at `~/.config/usable-browser-agent/secrets.json`
   (override with `UBA_SECRETS_FILE`). The server creates the directory `0700` and warns if the
   file is readable by group/other — keep it at mode `0600`.

## What this does NOT protect against

- A site you've **allow-listed and are logged into**: the agent can do anything there that you can.
- **Malware or another user on your machine** that can read the local vault file or the browser.
- **You** adding a high-value site (bank, primary email) to an alias's `domains`. Don't.
- It is **not** a sandbox on the agent's actions. Treat the active tab as live.

## Vault format

```json
[
  {
    "alias": "github",
    "domains": ["github.com"],
    "username": "octo@example.com",
    "password": "your-real-secret"
  }
]
```

`domains` are the only hosts the alias may be used on (exact + subdomain). Keep the file at `0600`.

## FAQ

**Does my password go to the AI / the cloud?** No. The agent only ever passes the *alias*. The
secret is read locally and injected into the page over a loopback (`127.0.0.1`) connection. It is
also scrubbed out of anything the agent reads back.

**What if the agent is tricked onto a phishing page?** The fill is refused unless the page host
matches the alias's `domains`, so the credential is never entered on a look-alike host.

**Can the agent screenshot my password?** No — screenshots are blocked whenever a credential is
present on the page and, in hardened mode (the default), whenever any password field exists.

**Can the agent read my clipboard?** Yes — `browser_clipboard_read` exists so the agent can use
copy/paste like a human, and clipboard text reads pass through the same output scrubbing as
everything else (known vault secrets are redacted). `browser_clipboard_read_image` returns an
image as-is and is **not** text-scrubbed, so an image on the clipboard that visually contains a
secret would be returned verbatim. If your clipboard may hold secrets the vault doesn't know about,
clear it before letting an agent run unattended.

**What about OS-level input and native dialogs?** The `browser_os_*` and `browser_native_dialog`
tools (macOS) drive the real keyboard/mouse and native dialogs. They can type and click anywhere
the focused window allows — a broader capability than in-page actions. They require a one-time
macOS Accessibility grant, so they can't be enabled silently. Treat them like any other powerful
local tool: the boundary is still *you* choosing what the agent works on.

## How this is tested

- `npm run claims` — claim-level validation (alias-only, anti-phishing refusal, host matching,
  output scrubbing).
- `npm run secrets` — the full credential-broker suite, including content-script redaction of
  snapshots / `get_value`, `credential_state` flags, and screenshot blocking.
