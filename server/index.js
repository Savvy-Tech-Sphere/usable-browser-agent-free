#!/usr/bin/env node
// Usable Browser Agent — MCP server + WebSocket bridge.
//
// Architecture:
//   Claude Code / Codex  <--MCP/stdio-->  THIS PROCESS  <--WebSocket-->  Firefox extension
//
// The extension runs inside your real Firefox, so every action uses your
// actual logged-in sessions. This process never touches cookies or the
// network directly; it only relays structured commands.

import { readFile } from "node:fs/promises";
import { basename, extname } from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { WebSocketServer } from "ws";
import { z } from "zod";
import { captureScreenshot } from "./screenshot.js";
import { JsonSecretsVault, fillSecret, loginSecret, setHttpAuthSecret } from "./secrets.js";
import { nativeInput } from "./native.js";
import { WorkflowMemoryStore, formatWorkflowMemories, hostnameFromUrl, memoryFileFromEnv } from "./memory.js";

const PORT = Number(process.env.UBA_PORT || 8876);
const CALL_TIMEOUT = Number(process.env.UBA_TIMEOUT_MS || 45000);
// Hardened by default: disables browser_eval and blocks screenshots while a
// password field is present, so the "your passwords never touch the model"
// guarantee holds out of the box. Power users can re-enable the browser_eval
// escape hatch with UBA_STRICT_SECRETS=0.
const STRICT_SECRETS = process.env.UBA_STRICT_SECRETS !== "0";
const secretsVault = new JsonSecretsVault();
const workflowMemory = new WorkflowMemoryStore();

// ---------------------------------------------------------------------------
// WebSocket bridge to the extension
// ---------------------------------------------------------------------------
let extensionSocket = null;
let extensionInfo = null; // { browser: "firefox"|"chrome", version } from the hello message
let nextId = 1;
const pending = new Map(); // id -> {resolve, reject, timer}
let brokerActionsInProgress = 0;

const wss = new WebSocketServer({ port: PORT, host: "127.0.0.1" });

wss.on("connection", (socket) => {
  socket.on("message", (data) => {
    let msg;
    try {
      msg = JSON.parse(data.toString());
    } catch (e) {
      return;
    }
    // Adoption is gated on the extension's hello: a bare socket on this port
    // (port probes, stray clients) must never displace the real extension.
    // Newest hello wins (handles extension reloads); the previous socket is
    // repointed, not closed, so two live browsers do not fight over the slot.
    if (msg.type === "hello" && msg.role === "extension") {
      extensionSocket = socket;
      extensionInfo = {
        browser: msg.browser === "chrome" ? "chrome" : "firefox",
        version: typeof msg.version === "string" ? msg.version : null,
      };
      return;
    }
    if (socket !== extensionSocket) return; // ignore non-adopted sockets
    if (msg.type === "response" && pending.has(msg.id)) {
      const p = pending.get(msg.id);
      pending.delete(msg.id);
      clearTimeout(p.timer);
      if (msg.ok) p.resolve(msg.result);
      else p.reject(new Error(msg.error || "Extension reported an error."));
    }
    // Other adopted-socket message types (e.g. keepalive pings) are ignored.
  });
  socket.on("close", () => {
    if (extensionSocket === socket) {
      extensionSocket = null;
      extensionInfo = null;
    }
  });
  socket.on("error", () => {});
});

wss.on("error", (err) => {
  process.stderr.write(`[uba] WebSocket server error: ${err.message}\n`);
  if (err.code === "EADDRINUSE") {
    process.stderr.write(`[uba] Port ${PORT} is in use. Another instance may be running.\n`);
    process.exit(1);
  }
});

function waitForExtension(timeoutMs = 8000) {
  if (extensionSocket && extensionSocket.readyState === 1) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const iv = setInterval(() => {
      if (extensionSocket && extensionSocket.readyState === 1) {
        clearInterval(iv);
        resolve();
      } else if (Date.now() - start > timeoutMs) {
        clearInterval(iv);
        reject(
          new Error(
            "Browser extension is not connected. Make sure your browser is open and the 'Usable Browser Agent' extension shows ON. Firefox: load it via about:debugging if needed. Chrome: load the unpacked dist/chrome build via chrome://extensions with Developer mode on."
          )
        );
      }
    }, 150);
  });
}

async function call(method, params = {}, { waitTimeoutMs = 8000 } = {}) {
  await waitForExtension(waitTimeoutMs);
  const id = nextId++;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`Command "${method}" timed out after ${CALL_TIMEOUT}ms.`));
    }, CALL_TIMEOUT);
    pending.set(id, { resolve, reject, timer });
    try {
      extensionSocket.send(JSON.stringify({ type: "command", id, method, params }));
    } catch (e) {
      clearTimeout(timer);
      pending.delete(id);
      reject(e);
    }
  });
}

async function withBrokerAction(fn) {
  brokerActionsInProgress++;
  try {
    return await fn();
  } finally {
    brokerActionsInProgress--;
  }
}

// ---------------------------------------------------------------------------
// MCP server + tools
// ---------------------------------------------------------------------------
// Self-report the real package version (a hardcoded string here drifted once).
const pkg = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
const server = new McpServer({ name: "usable-browser-agent", version: pkg.version });

const text = (s) => ({
  content: [{ type: "text", text: secretsVault.scrubText(typeof s === "string" ? s : JSON.stringify(s, null, 2)) }],
});
const err = (e) => ({ content: [{ type: "text", text: secretsVault.scrubText(`ERROR: ${e.message || e}`) }], isError: true });

function tool(name, description, shape, handler) {
  server.tool(name, description, shape, async (args) => {
    try {
      return secretsVault.scrub(await handler(args || {}));
    } catch (e) {
      return err(e);
    }
  });
}

async function activeTabIfAvailable() {
  try {
    const status = await call("status", {}, { waitTimeoutMs: 250 });
    return status?.activeTab || null;
  } catch {
    return null;
  }
}

function withWorkflowMemoryHints(result, tabLike, { compact = false } = {}) {
  const tab =
    tabLike ||
    (result !== null && typeof result === "object"
      ? result.activeTab || result.tab || result
      : null);
  const hints = tab ? workflowMemory.hintsForTab(tab) : [];
  if (!hints.length) return result;
  const instruction =
    "If a hint matches the current task, call browser_workflow_recall with that task or id before continuing.";
  if (typeof result !== "object" || result === null) {
    const hintLines = hints
      .map(
        (h) =>
          `[workflow-memory id=${h.id}] "${h.task}" (${h.lastVerified || "unknown"}, ${h.confidence} confidence)` +
          (compact || !h.firstSteps.length ? "" : `\n  Steps: ${h.firstSteps.join(" -> ")}`)
      )
      .join("\n");
    return `${result ?? ""}\n\n${hintLines}\n${instruction}`;
  }
  return {
    ...result,
    workflowMemoryHints: hints,
    workflowMemoryInstruction: instruction,
  };
}

function tabFromSnapshot(snapshot) {
  const text = String(snapshot || "");
  const url = text.match(/^url:\s*(.+)$/m)?.[1]?.trim() || "";
  const title = text.match(/^title:\s*(.*)$/m)?.[1]?.trim() || "";
  return url || title ? { url, title } : null;
}

// --- workflow memory: reusable instructions for changing sites ---
tool(
  "browser_workflow_recall",
  "Search local workflow memory BEFORE starting any multi-step or repeated browser task. Use this first for changing sites like app stores, admin consoles, checkout flows, dashboards, or any task you may have done before.",
  {
    query: z.string().optional().describe("Task objective or memory id, e.g. 'create a new app in Google Play Console'."),
    site: z.string().optional().describe("Site name or domain, e.g. 'Google Play Console' or 'play.google.com'."),
    tags: z.array(z.string()).optional().describe("Optional tags to narrow recall."),
    limit: z.number().optional().describe("Maximum matches to return (1-10, default 5)."),
  },
  async ({ query = "", site = "", tags = [], limit }) => {
    const activeTab = await activeTabIfAvailable();
    const activeDomain = hostnameFromUrl(activeTab?.url);
    const matches = workflowMemory.search({
      query,
      site: site || activeDomain,
      domain: site ? "" : activeDomain,
      tags,
      limit,
    });
    return text(formatWorkflowMemories(matches, { query, site: site || activeDomain }));
  }
);

tool(
  "browser_workflow_remember",
  "Save the verified reusable workflow after discovering or completing a browser task. Store durable UI labels, decisions, and pitfalls; do not store passwords, one-time codes, or transient [ref=eN] handles.",
  {
    task: z.string().describe("Reusable task objective, e.g. 'Create a new Android app in Google Play Console'."),
    steps: z.array(z.string()).describe("Ordered durable steps that worked. Use visible labels and page names, not transient refs."),
    site: z.string().optional().describe("Human site name, e.g. 'Google Play Console'."),
    domain: z.string().optional().describe("Domain, e.g. 'play.google.com'."),
    url: z.string().optional().describe("Useful starting URL if stable."),
    title: z.string().optional().describe("Page title where the workflow starts or was verified."),
    tags: z.array(z.string()).optional().describe("Search tags such as 'android', 'play-store', 'release'."),
    pitfalls: z.array(z.string()).optional().describe("Things that were wrong, surprising, changed, or easy to miss."),
    selectors: z.array(z.string()).optional().describe("Durable UI cues: visible labels, section names, field names. Avoid transient refs."),
    notes: z.string().optional().describe("Short extra context for future agents."),
    outcome: z.string().optional().describe("What succeeded or what state was reached."),
    confidence: z.enum(["low", "medium", "high"]).optional().describe("Confidence that the workflow is reusable."),
    lastVerified: z.string().optional().describe("Verification date, default today."),
    supersedes: z.array(z.string()).optional().describe("Workflow memory ids this record replaces because they are stale or incomplete."),
  },
  async (args) => {
    const activeTab = await activeTabIfAvailable();
    const record = workflowMemory.remember(secretsVault.scrub(args), { activeTab });
    return text({
      saved: true,
      id: record.id,
      task: record.task,
      site: record.site,
      domain: record.domain,
      lastVerified: record.lastVerified,
      file: memoryFileFromEnv(),
      recall: `browser_workflow_recall({ "query": "${record.id}" })`,
    });
  }
);

tool(
  "browser_workflow_forget",
  "Remove a stale, sensitive, or incorrect workflow memory by id. This appends a local tombstone; normal recall will stop returning that memory.",
  {
    id: z.string().describe("Workflow memory id, e.g. wm_20260604123000_ab12cd34."),
    reason: z.string().optional().describe("Optional short reason for the deletion."),
  },
  async ({ id, reason = "" }) => text(workflowMemory.forget(id, reason))
);

// ---------------------------------------------------------------------------
// OS-level input (macOS sidecar) — the last mile for native chrome and
// isTrusted-checking pages. These run in this process, not the extension.
// ---------------------------------------------------------------------------
tool(
  "browser_native_status",
  "Report which OS-level input capabilities are available (trusted keystrokes, native-dialog control, raw clicks) and any setup needed. Check this before relying on the browser_os_* / browser_native_dialog tools.",
  {},
  async () => text(await nativeInput.availability())
);

tool(
  "browser_os_type",
  "Type text using REAL OS keystrokes into whatever currently has focus. Use only when in-page typing fails because the element checks event.isTrusted (some payment fields, editors, games). Focus the field first (e.g. browser_click), then call this. macOS only; needs Accessibility permission.",
  { text: z.string(), modifiers: z.array(z.string()).optional() },
  async ({ text: t, modifiers }) => text(await nativeInput.type(t, { modifiers }))
);

tool(
  "browser_os_key",
  "Press a REAL OS key (Enter, Tab, Escape, ArrowDown, F1-F8, or a single char), optionally with modifiers. For native UI and isTrusted-checking pages. macOS only.",
  { key: z.string(), modifiers: z.array(z.string()).optional() },
  async ({ key, modifiers }) => text(await nativeInput.key(key, { modifiers }))
);

tool(
  "browser_os_click",
  "Click at absolute screen coordinates with a REAL OS mouse event. Prefer browser_click; use this only for trusted clicks or native chrome. macOS only; raw clicks need `brew install cliclick`.",
  {
    x: z.number(),
    y: z.number(),
    button: z.enum(["left", "right"]).optional(),
    count: z.number().optional().describe("2 = double-click."),
  },
  async ({ x, y, button, count }) => text(await nativeInput.click(x, y, { button, count }))
);

// OS-level input must land in the browser the extension is actually running
// in. The extension reports its flavor in the bridge hello; the app name can
// be overridden for nonstandard installs (e.g. Chrome for Testing, Chromium).
function connectedBrowserAppName() {
  if (process.env.UBA_BROWSER_APP_NAME) return process.env.UBA_BROWSER_APP_NAME;
  return extensionInfo && extensionInfo.browser === "chrome" ? "Google Chrome" : "Firefox";
}

tool(
  "browser_os_click_ref",
  "Click a page element by ref with a REAL, OS-trusted mouse event (for elements that ignore synthetic clicks). Computes the element's on-screen position via the connected browser, raises its window, then clicks. On Firefox coordinates are exact; on Chrome they are approximate (refused unless allowApproximate is set) and iframe elements are not supported. macOS only; needs cliclick + Accessibility permission.",
  {
    ref: z.string(),
    button: z.enum(["left", "right"]).optional(),
    count: z.number().optional(),
    allowApproximate: z
      .boolean()
      .optional()
      .describe(
        "Chrome only: opt in to clicking at APPROXIMATE screen coordinates (no exact viewport-origin API exists there). Only set this after visually confirming the window is a normal browser window (no docked devtools/sidebar), because the real OS click lands wherever the estimate says."
      ),
  },
  async ({ ref, button, count, allowApproximate }) => {
    const rect = await call("element_screen_rect", { ref });
    if (rect.approximate && !allowApproximate) {
      throw new Error(
        "Refusing to fire a real OS click at approximate coordinates. On Chrome the element's screen position is an estimate (no exact viewport-origin API), and a trusted click at the wrong point can land in another application. Retry with allowApproximate: true only if the browser window is a normal window with no docked devtools, or use browser_click instead."
      );
    }
    const app = connectedBrowserAppName();
    try {
      await nativeInput.focusApp(app);
    } catch (e) {
      // A typo'd explicit override must be loud: a trusted click with the
      // wrong app focused lands in whatever is frontmost.
      if (process.env.UBA_BROWSER_APP_NAME) {
        throw new Error(`Could not focus "${app}" (from UBA_BROWSER_APP_NAME): ${e.message}`);
      }
      // Default names: keep the pre-existing best-effort behavior (the
      // browser window is usually already frontmost).
    }
    const result = await nativeInput.click(rect.centerX, rect.centerY, { button, count });
    return text({
      ...result,
      ref,
      app,
      approximate: !!rect.approximate,
      via: rect.approximate ? "chromeApproximate" : "mozInnerScreen",
    });
  }
);

tool(
  "browser_native_dialog",
  "Inspect or operate a NATIVE browser dialog that no extension can touch — the file picker, print dialog, basic-auth popup, or 'Leave page?'. action='list' shows the dialog's buttons; 'click_button' presses one by name (e.g. 'Open', 'Save', 'Don't Save'); 'set_text' types into the focused dialog field. macOS only; needs Accessibility permission.",
  {
    action: z.enum(["list", "click_button", "set_text"]).optional(),
    button: z.string().optional().describe("Button label for click_button."),
    text: z.string().optional().describe("Text for set_text."),
    process: z.string().optional().describe("Process name (default firefox)."),
  },
  async (a) => text(await nativeInput.dialog(a))
);

tool(
  "browser_focus_browser",
  "Bring the connected browser (Firefox or Chrome, per the bridge connection) to the foreground so OS-level input lands in it. macOS only.",
  {},
  async () => text(await nativeInput.focusApp(connectedBrowserAppName()))
);

// --- human-in-the-loop escape hatch (Tier 4) ---
tool(
  "browser_request_human_help",
  "Hand control to the human for something automation must not or cannot do — CAPTCHAs, anti-bot 'verify you're human' walls, 2FA approvals, or a deliberate judgment call. Sends a desktop notification and returns a message you should relay to the user, then STOP and wait for them to act before continuing. Do not attempt to bypass CAPTCHAs yourself.",
  {
    message: z.string().describe("What you need the human to do, e.g. 'Solve the CAPTCHA on the login page, then tell me to continue.'"),
    reason: z.string().optional().describe("Short category, e.g. 'captcha', '2fa', 'permission'."),
  },
  async ({ message, reason }) => {
    // Notify via both channels so the user sees it regardless of focus.
    await Promise.allSettled([
      call("notify", { title: "Browser agent needs you", message }, { waitTimeoutMs: 1500 }),
      nativeInput.notify("Browser agent needs you", message),
    ]);
    return text({
      humanHelpRequested: true,
      reason: reason || "manual",
      message,
      instruction:
        "Relay this request to the user verbatim, then stop and wait. The browser is on their screen; they will act and tell you when to resume.",
    });
  }
);

// --- snapshot: the primary perception tool ---
tool(
  "browser_snapshot",
  "Capture an accessibility/DOM snapshot of the active Firefox tab as a structured tree. Each interactive element gets a stable [ref=eN] handle. USE THIS to understand the page before acting, and re-run it after the page changes — refs become stale after navigation or DOM updates. If workflow-memory hints appear, call browser_workflow_recall before continuing.",
  { maxNodes: z.number().optional().describe("Max nodes to include (default 1500).") },
  async ({ maxNodes }) => {
    const snapshot = (await call("snapshot", { maxNodes })).snapshot;
    return text(withWorkflowMemoryHints(snapshot, tabFromSnapshot(snapshot), { compact: true }));
  }
);

// --- navigation ---
tool(
  "browser_navigate",
  "Navigate the active tab to a URL and wait for it to finish loading.",
  { url: z.string().describe("Full URL including https://"), timeout: z.number().optional() },
  async ({ url, timeout }) => {
    const result = await call("navigate", { url, timeout });
    return text(withWorkflowMemoryHints(result, result !== null && typeof result === "object" ? result : { url }));
  }
);

tool("browser_back", "Go back in the active tab's history.", {}, async () => text(await call("back")));
tool("browser_forward", "Go forward in the active tab's history.", {}, async () => text(await call("forward")));
tool("browser_reload", "Reload the active tab.", {}, async () => text(await call("reload")));

// --- actions ---
tool(
  "browser_click",
  "Click an element by its ref from the latest snapshot. Supports right/middle button, double-click, and modifier keys (ctrl/shift/alt/meta) for context menus, multi-select, and open-in-new-tab.",
  {
    ref: z.string().describe("Element ref, e.g. e12, from browser_snapshot."),
    button: z.enum(["left", "right", "middle"]).optional().describe("Mouse button (default left). 'right' opens context menus."),
    count: z.number().optional().describe("Click count; 2 = double-click."),
    modifiers: z
      .array(z.enum(["ctrl", "shift", "alt", "meta", "cmd"]))
      .optional()
      .describe("Modifier keys held during the click."),
  },
  async (a) => text(await call("click", a))
);

tool(
  "browser_drag",
  "Drag one element onto another (kanban cards, sortable lists, file tiles, sliders). Fires both HTML5 drag-and-drop and a pointer-drag sequence so native and JS-library targets both respond.",
  {
    fromRef: z.string().describe("Ref of the element to drag."),
    toRef: z.string().describe("Ref of the drop target."),
  },
  async (a) => text(await call("drag", a))
);

tool(
  "browser_type",
  "Focus a text field by ref and type text into it. Set submit=true to press Enter afterward (e.g. to submit a search).",
  {
    ref: z.string(),
    text: z.string(),
    submit: z.boolean().optional().describe("Press Enter after typing."),
    clear: z.boolean().optional().describe("Clear the field first (default true)."),
  },
  async (a) => text(await call("type", a))
);

tool(
  "browser_fill_form",
  "Fill multiple fields in one call. Pass fields as an array of {ref, text}. Faster and more reliable than many browser_type calls for forms.",
  { fields: z.array(z.object({ ref: z.string(), text: z.string() })) },
  async ({ fields }) => text(await call("fill_form", { fields }))
);

tool(
  "browser_fill_secret",
  "Fill a username or password field from the server-side credential broker. Pass only a secret alias; secret values are never accepted as tool input or returned.",
  {
    ref: z.string().describe("Element ref, e.g. e12, from browser_snapshot."),
    secret: z.string().describe("Secret alias from the server-side secrets vault."),
    field: z.enum(["username", "password"]).optional().describe("Which secret field to fill (default password)."),
  },
  async (args) => text(await withBrokerAction(() => fillSecret(args, { vault: secretsVault, call })))
);

tool(
  "browser_login",
  "Atomically fill username/password fields from a server-side secret alias and submit the login form. Pass only refs and the secret alias; secret values are never accepted as tool input or returned.",
  {
    secret: z.string().describe("Secret alias from the server-side secrets vault."),
    password_ref: z.string().describe("Password field ref, e.g. e12, from browser_snapshot."),
    username_ref: z.string().optional().describe("Username field ref. Filled only when provided and the secret has a username."),
    submit_ref: z.string().optional().describe("Submit button ref. If omitted, the password field's enclosing form is submitted."),
  },
  async (args) => text(await withBrokerAction(() => loginSecret(args, { vault: secretsVault, call })))
);

tool(
  "browser_select",
  "Choose an option in a <select> dropdown by visible label or value.",
  { ref: z.string(), value: z.string() },
  async (a) => text(await call("select", a))
);

tool("browser_hover", "Hover the pointer over an element by ref.", { ref: z.string() }, async (a) => text(await call("hover", a)));

tool(
  "browser_press_key",
  "Press a key (Enter, Tab, Escape, ArrowDown, etc.). Optionally target an element by ref; otherwise the focused element receives it.",
  { key: z.string(), ref: z.string().optional() },
  async (a) => text(await call("press_key", a))
);

// --- clipboard & paste ---
tool(
  "browser_clipboard_read",
  "Read text from the system clipboard. Use after the page put something on the clipboard (e.g. a 'Copy' button) or to move data between pages and apps.",
  {},
  async () => text((await call("clipboard_read")).text ?? "")
);

tool(
  "browser_clipboard_write",
  "Write text to the system clipboard.",
  { text: z.string() },
  async ({ text: value }) => text(await call("clipboard_write", { text: value }))
);

tool(
  "browser_paste",
  "Paste into an element by ref as a real paste event — rich editors (Google Docs, Notion, contenteditable) handle this better than typing. Pastes the given text, or the current clipboard contents when text is omitted.",
  {
    ref: z.string(),
    text: z.string().optional().describe("Text to paste. Omit to paste the current clipboard contents."),
  },
  async (a) => text(await call("paste", a))
);

tool(
  "browser_clipboard_read_image",
  "Read an image from the system clipboard (e.g. after a 'Copy image' action) and return it as a PNG/JPEG. Errors if the clipboard holds no image.",
  {},
  async () => {
    const { mimeType, data } = await call("clipboard_read_image");
    return { content: [{ type: "image", data, mimeType: mimeType || "image/png" }] };
  }
);

tool(
  "browser_clipboard_write_image",
  "Put a local image file onto the system clipboard so it can be pasted into a page.",
  { path: z.string().describe("Absolute path to a local image file.") },
  async ({ path: p }) => {
    const buf = await readFile(p);
    if (buf.length > MAX_UPLOAD_BYTES) throw new Error(`Image ${p} is ${buf.length} bytes; max is ${MAX_UPLOAD_BYTES}.`);
    const mimeType = MIME_TYPES[extname(p).toLowerCase()] || "image/png";
    return text(await call("clipboard_write_image", { data: buf.toString("base64"), mimeType }));
  }
);

// --- JS dialogs (alert/confirm/prompt/beforeunload) ---
tool(
  "browser_set_dialog_policy",
  "Set how native JS dialogs are auto-answered so they never block the agent. accept=true confirms (default), promptText sets what prompt() returns, suppress=true neutralizes 'Leave page?' beforeunload guards. Applies to the current page; re-set after navigation if needed.",
  {
    accept: z.boolean().optional().describe("Answer confirm()/prompt() affirmatively (default true)."),
    promptText: z.string().optional().describe("Value returned from prompt() when accepted."),
    suppress: z.boolean().optional().describe("Neutralize beforeunload 'leave page?' guards (default true)."),
  },
  async (a) => text(await call("set_dialog_policy", a))
);

tool(
  "browser_dialogs",
  "List native JS dialogs (alert/confirm/prompt) the page tried to open and how they were auto-answered. Use this to see if the page asked something.",
  {},
  async () => text(await call("dialogs"))
);

tool(
  "browser_mock_geolocation",
  "Make navigator.geolocation return a fixed position (so location-gated tasks proceed without the native permission prompt). Pass clear=true to stop mocking. Applies to the current page; re-set after navigation.",
  {
    latitude: z.number().optional(),
    longitude: z.number().optional(),
    accuracy: z.number().optional().describe("Accuracy in meters (default 20)."),
    clear: z.boolean().optional().describe("Stop mocking and restore real geolocation."),
  },
  async (a) => text(await call("mock_geolocation", a))
);

// --- downloads ---
tool(
  "browser_download",
  "Download a file to disk WITHOUT the OS save dialog, and return its local path so you can read it. Use for PDFs, exports, attachments — the file lands in the browser's downloads folder.",
  {
    url: z.string().describe("Full URL of the file to download."),
    filename: z.string().optional().describe("Optional filename (relative to the downloads folder)."),
    timeout: z.number().optional().describe("Max ms to wait for completion (default 60000)."),
  },
  async (a) => text(await call("download", a, { waitTimeoutMs: 8000 }))
);

tool(
  "browser_downloads_list",
  "List recent downloads with their on-disk paths and state.",
  { limit: z.number().optional() },
  async (a) => text(await call("downloads_list", a))
);

tool(
  "browser_save_pdf",
  "Save the current tab as a PDF to the downloads folder (dialog-free). Useful to capture a rendered page. If your Firefox build still shows a save dialog, use browser_native_dialog to confirm it.",
  { filename: z.string().optional().describe("Optional output filename.") },
  async (a) => text(await call("save_pdf", a))
);

// --- network visibility ---
tool(
  "browser_network_log",
  "Inspect recent network requests (method, URL, status, type, errors) the browser made. Use to diagnose why a button 'did nothing', find an API endpoint, or confirm a request succeeded.",
  {
    filter: z.string().optional().describe("Only requests whose URL contains this substring."),
    onlyErrors: z.boolean().optional().describe("Only failed requests (network error or status >= 400)."),
    type: z.string().optional().describe("Resource type, e.g. xmlhttprequest, script, document, image."),
    limit: z.number().optional().describe("Max requests to return (default 50)."),
  },
  async (a) => text(await call("network_log", a))
);

// --- HTTP basic auth (via the server-side credential broker) ---
tool(
  "browser_http_auth",
  "Arm answers for HTTP basic-auth prompts (the native username/password dialog) from a server-side secret alias, scoped to that secret's domains. Pass only the alias; the credential value is never accepted as input or returned. Call before navigating to the protected URL.",
  {
    secret: z.string().describe("Secret alias from the server-side secrets vault."),
    once: z.boolean().optional().describe("Answer only the next auth challenge, then disarm."),
  },
  async (a) => text(await withBrokerAction(() => setHttpAuthSecret(a, { vault: secretsVault, call })))
);

tool(
  "browser_clear_http_auth",
  "Disarm previously-armed HTTP basic-auth answers (all domains, or specific ones).",
  { domains: z.array(z.string()).optional() },
  async (a) => text(await call("clear_http_auth", a))
);

// --- file upload ---
const MAX_UPLOAD_BYTES = 50 * 1024 * 1024;
const MIME_TYPES = {
  ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif",
  ".webp": "image/webp", ".svg": "image/svg+xml", ".ico": "image/x-icon", ".bmp": "image/bmp",
  ".pdf": "application/pdf", ".txt": "text/plain", ".md": "text/markdown", ".csv": "text/csv",
  ".json": "application/json", ".xml": "application/xml", ".html": "text/html",
  ".zip": "application/zip", ".gz": "application/gzip", ".tar": "application/x-tar",
  ".mp3": "audio/mpeg", ".wav": "audio/wav", ".mp4": "video/mp4", ".webm": "video/webm", ".mov": "video/quicktime",
  ".doc": "application/msword",
  ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".xls": "application/vnd.ms-excel",
  ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ".ppt": "application/vnd.ms-powerpoint",
  ".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
};

tool(
  "browser_upload_file",
  "Attach local file(s) to the page WITHOUT opening the OS file picker (the picker cannot be automated — never click elements that open it). Pass the ref of a file input (hidden ones appear in snapshots as 'file-input ... [hidden]'), or of an upload button/dropzone near it, plus absolute local file paths. Sets the input's files directly, or simulates a drag-and-drop when no file input is found.",
  {
    ref: z.string().describe("Ref of the file input, upload button, or dropzone."),
    paths: z.array(z.string()).describe("Absolute paths of local files to attach."),
    mode: z
      .enum(["auto", "drop"])
      .optional()
      .describe("auto (default): find and fill the file input. drop: force a drag-and-drop onto the ref'd element (for dropzones)."),
  },
  async ({ ref, paths, mode }) => {
    if (!paths.length) throw new Error("No file paths provided.");
    const files = [];
    for (const p of paths) {
      const buf = await readFile(p);
      if (buf.length > MAX_UPLOAD_BYTES)
        throw new Error(`File ${p} is ${buf.length} bytes; max upload size is ${MAX_UPLOAD_BYTES}.`);
      files.push({
        name: basename(p),
        type: MIME_TYPES[extname(p).toLowerCase()] || "application/octet-stream",
        data: buf.toString("base64"),
      });
    }
    return text(await call("upload_file", { ref, files, mode }));
  }
);

tool(
  "browser_scroll",
  "Scroll the page or a specific scrollable container. Pass a ref to scroll that container (inner panes, virtualized/infinite lists); omit it to scroll the window. Use to='bottom' to jump to the end (e.g. trigger infinite-scroll loading).",
  {
    direction: z.enum(["up", "down", "left", "right"]).optional(),
    amount: z.number().optional(),
    ref: z.string().optional().describe("Scroll this container (or, with no direction/to, just reveal it)."),
    to: z.enum(["top", "bottom"]).optional().describe("Jump to the top or bottom of the target."),
  },
  async (a) => text(await call("scroll", a))
);

// --- reading ---
tool(
  "browser_read_text",
  "Get the visible text of the page (or of one element by ref). Use for reading article/content; use browser_snapshot for interactive structure.",
  { ref: z.string().optional(), maxChars: z.number().optional() },
  async (a) => text((await call("get_text", a)).text)
);

tool("browser_get_value", "Get the current value/text of a field or element by ref.", { ref: z.string() }, async (a) => text(await call("get_value", a)));

// --- waiting ---
tool("browser_wait", "Wait a fixed number of milliseconds (use sparingly).", { ms: z.number() }, async (a) => text(await call("wait", a)));
tool(
  "browser_wait_for_text",
  "Wait until the given text appears anywhere on the page (or timeout).",
  { text: z.string(), timeout: z.number().optional() },
  async (a) => text(await call("wait_for_text", a))
);

// --- tabs ---
tool("browser_list_tabs", "List all open tabs with their ids, urls, and titles.", {}, async () => text(await call("list_tabs")));
tool("browser_select_tab", "Make a tab active by id (the agent acts on the active tab).", { tabId: z.number() }, async (a) => text(await call("select_tab", a)));
tool("browser_new_tab", "Open a new tab, optionally at a URL, and make it active.", { url: z.string().optional() }, async (a) => text(await call("new_tab", a)));
tool("browser_close_tab", "Close a tab by id (defaults to the active tab).", { tabId: z.number().optional() }, async (a) => text(await call("close_tab", a)));

// --- meta ---
tool("browser_status", "Check the bridge connection and the current active tab. If the active tab has workflow memories, this returns short hints.", {}, async () =>
  text(withWorkflowMemoryHints(await call("status")))
);
tool("browser_info", "Get the active tab's url, title, load state, scroll position, and short workflow-memory hints when available.", {}, async () =>
  text(withWorkflowMemoryHints(await call("info")))
);

tool(
  "browser_screenshot",
  "Capture a PNG screenshot of the visible part of the active tab. Use only when the snapshot is insufficient (e.g. canvas, charts, visual layout).",
  {},
  async () => {
    const dataUrl = await captureScreenshot({
      call,
      brokerInProgress: brokerActionsInProgress > 0,
      strictSecrets: STRICT_SECRETS,
    });
    const base64 = dataUrl.replace(/^data:image\/png;base64,/, "");
    return { content: [{ type: "image", data: base64, mimeType: "image/png" }] };
  }
);

tool(
  "browser_eval",
  "Run JavaScript in the page and return the result. Disabled under hardened mode, which is the default; the operator enables it by setting UBA_STRICT_SECRETS=0 in the server environment. On Firefox the code runs in the content-script sandbox; on Chrome it runs in the page's own realm, where the page can observe it and its CSP applies. Use only when no dedicated tool fits.",
  { code: z.string().describe("JS body; use `return value;` to return data.") },
  async ({ code }) => {
    if (STRICT_SECRETS) {
      throw new Error(
        "browser_eval is disabled: hardened mode is on by default. Set UBA_STRICT_SECRETS=0 in the server environment to enable it."
      );
    }
    return text(await call("eval", { code }));
  }
);

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------
const transport = new StdioServerTransport();
await server.connect(transport);
process.stderr.write(`[uba] MCP server ready. WebSocket bridge on ws://127.0.0.1:${PORT}\n`);
