# Uninstall

Removing Usable Browser Agent is four quick steps: unregister the MCP server,
remove the browser extension, delete the local data directory, and delete the
program folder.

---

## 1. Unregister the MCP server from your agent

**Claude Code:**

```bash
claude mcp remove browser --scope user
```

(Confirm it is gone with `claude mcp list`.)

**Codex:** open `~/.codex/config.toml` and delete the `[mcp_servers.browser]`
block (and its `[mcp_servers.browser.env]` block, if present):

```toml
[mcp_servers.browser]
command = "node"
args = ["/.../usable-browser-agent/server/index.js"]

[mcp_servers.browser.env]
UBA_PORT = "8876"
```

## 2. Remove the browser extension

**Firefox:**

1. Open Firefox and go to **`about:addons`**.
2. Find **Usable Browser Agent**.
3. Click the **...** menu, then **Remove**.

**Chrome:**

1. Open Chrome and go to **`chrome://extensions`**.
2. Find **Usable Browser Agent** and click **Remove**.

The toolbar badge disappears with the extension.

## 3. Delete the local data directory

This holds your stored logins (the credential vault). Removing it deletes them
(if you set `UBA_SECRETS_FILE` at install time, delete that file instead, and
the agent registrations above carried its path). The installer also leaves a
`~/.codex/config.toml.bak-<timestamp>` copy whenever it appended to an existing
Codex config; remove those if you want a clean slate.

```bash
rm -rf ~/.config/usable-browser-agent
```

Optionally also remove the local workflow memory (reusable site-flow notes, no
secrets):

```bash
rm -rf ~/.local/state/usable-browser-agent
```

## 4. Delete the program folder

If you no longer want the server at all, delete the folder you installed into:

```bash
rm -rf path/to/usable-browser-agent
```

That is it: nothing runs in the background, there is no daemon or login item, and
no data is stored anywhere else on disk or in the cloud.
