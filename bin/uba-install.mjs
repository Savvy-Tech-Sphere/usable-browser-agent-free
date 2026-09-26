#!/usr/bin/env node
// Usable Browser Agent: one-command installer.
//
//   node bin/uba-install.mjs                    (or: npm run setup)
//   node bin/uba-install.mjs --non-interactive  accept every default, never prompt
//
// Sets a buyer up end to end without support: checks Node and the port,
// installs deps, registers the MCP server with Claude Code and/or Codex using
// THIS copy's absolute path, runs the smoke test, optionally stores a first
// credential, prints the macOS Accessibility / cliclick steps, and prints the
// exact extension install steps for Firefox and Chrome. It is idempotent: it
// never silently clobbers an existing config; it detects, then merges or asks.
// Dependency-free (node built-ins only), so it runs before npm install.
//
// Prompts: with --non-interactive (or UBA_NON_INTERACTIVE=1) every question
// takes its default and stdin is never read. Otherwise answers can be typed at
// a TTY or piped in; end of input means "accept the remaining defaults".

import { spawnSync } from "node:child_process";
import { createInterface } from "node:readline";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SERVER_ENTRY = path.join(ROOT, "server", "index.js");
const HOME = os.homedir();
// Same resolution as server/secrets.js (secretsFileFromEnv): UBA_SECRETS_FILE
// wins, "~" expands to the home dir. Inlined so the installer stays free of
// imports and runs before npm install.
function expandHome(p) {
  return p === "~" ? HOME : p.startsWith("~/") ? path.join(HOME, p.slice(2)) : p;
}
// Resolved to an absolute path: the value is persisted into both agent
// configs, where the server resolves it against the AGENT's cwd, not ours.
const SECRETS_FILE = path.resolve(expandHome(process.env.UBA_SECRETS_FILE || "~/.config/usable-browser-agent/secrets.json"));
const CODEX_CONFIG = path.join(HOME, ".codex", "config.toml");
const PKG = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"));
const VERSION = PKG.version;

const ARGS = new Set(process.argv.slice(2));
if (ARGS.has("--help") || ARGS.has("-h")) {
  console.log(
    [
      "Usage: node bin/uba-install.mjs [--non-interactive]",
      "",
      "  --non-interactive   accept every default without prompting (no login is",
      "                      stored, no Homebrew install is attempted). Same as",
      "                      UBA_NON_INTERACTIVE=1.",
      "",
      "Environment: UBA_PORT (default 8876) is the port the MCP server hosts the",
      "extension WebSocket on; the installer checks it and writes it into the Codex",
      "config block.",
    ].join("\n")
  );
  process.exit(0);
}
const NON_INTERACTIVE = ARGS.has("--non-interactive") || process.env.UBA_NON_INTERACTIVE === "1";

// UBA_PORT is written into both agent configs, so refuse anything that is not
// a usable TCP port instead of persisting NaN or 0.
const PORT = (() => {
  const raw = process.env.UBA_PORT;
  if (raw === undefined || raw === "") return 8876;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1 || n > 65535) {
    console.error(`UBA_PORT must be an integer between 1 and 65535 (got ${JSON.stringify(raw)}).`);
    process.exit(2);
  }
  return n;
})();

// The opt-out registration printed wherever hardened mode is mentioned: the
// same remove-and-re-add shape the docs use, carrying the port and, when the
// install set one, the custom vault path.
const SECRETS_ENV_ARGS = process.env.UBA_SECRETS_FILE ? ["-e", `UBA_SECRETS_FILE=${SECRETS_FILE}`] : [];
const CLAUDE_OPT_OUT_CMD = `claude ${["mcp", "add", "browser", "--scope", "user", "-e", `UBA_PORT=${PORT}`, "-e", "UBA_STRICT_SECRETS=0", ...SECRETS_ENV_ARGS, "--", "node", SERVER_ENTRY].map(shellQuote).join(" ")}`;
const CLAUDE_OPT_OUT_REMOVE_AND_ADD = `claude mcp remove browser --scope user && ${CLAUDE_OPT_OUT_CMD}`;

// On Windows, npm and claude are .cmd shims. Node refuses to spawn a .cmd
// directly (EINVAL since the CVE-2024-27980 fix), so there the command goes
// through the shell with every argument quoted for cmd.exe. The bare name is
// used on both platforms, so commandExists (where / command -v) and runSync
// resolve the same thing, PATHEXT included.
function runSync(cmd, args, opts = {}) {
  let r;
  if (process.platform === "win32") {
    r = spawnSync([cmd, ...args].map(cmdQuote).join(" "), { ...opts, shell: true });
  } else {
    r = spawnSync(cmd, args, opts);
  }
  if (r.error) fail(`${cmd} could not be started: ${r.error.message}`);
  return r;
}
function cmdQuote(arg) {
  const s = String(arg);
  if (s.includes('"')) throw new Error(`Cannot pass an argument containing a double quote through cmd.exe: ${s}`);
  return s === "" || /[\s&|<>^()]/.test(s) ? `"${s}"` : s;
}
// Quoting for the commands the installer PRINTS for the user to paste into
// their shell: bare when the token is plain; otherwise single-quoted for sh
// (nothing expands inside single quotes, an embedded quote becomes '\\'') and
// double-quoted for cmd.exe on Windows.
function shellQuote(arg) {
  const s = String(arg);
  if (/^[A-Za-z0-9_./:\\~+=@,-]+$/.test(s)) return s;
  if (process.platform === "win32") return cmdQuote(s);
  return `'${s.replace(/'/g, "'\\''")}'`;
}

// ---------------------------------------------------------------------------
// Console helpers (no external deps).
// ---------------------------------------------------------------------------
const useColor = process.stdout.isTTY && !process.env.NO_COLOR;
const ESC = "\u001b";
const paint = (code, s) => (useColor ? `${ESC}[${code}m${s}${ESC}[0m` : s);
const bold = (s) => paint("1", s);
const green = (s) => paint("32", s);
const yellow = (s) => paint("33", s);
const red = (s) => paint("31", s);
const cyan = (s) => paint("36", s);
const dim = (s) => paint("2", s);

let stepNum = 0;
function step(title) {
  stepNum += 1;
  console.log(`\n${bold(cyan(`[${stepNum}] ${title}`))}`);
}
const ok = (s) => console.log(`  ${green("+")} ${s}`);
const warn = (s) => console.log(`  ${yellow("!")} ${s}`);
const info = (s) => console.log(`  ${dim("-")} ${s}`);
const fail = (s) => console.log(`  ${red("x")} ${s}`);

function commandExists(cmd) {
  if (process.platform === "win32") {
    return spawnSync("where", [cmd], { stdio: "ignore" }).status === 0;
  }
  // `command -v` is a shell builtin; invoke a shell with a fixed script (no
  // user-controlled args interpolated) to avoid the shell-args deprecation.
  return spawnSync("/bin/sh", ["-c", 'command -v "$1" >/dev/null 2>&1', "sh", cmd], { stdio: "ignore" }).status === 0;
}

function isPortFree(port) {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.once("error", () => resolve(false));
    srv.once("listening", () => srv.close(() => resolve(true)));
    srv.listen(port, "127.0.0.1");
  });
}

function tilde(p) {
  if (p === HOME) return "~";
  return p.startsWith(HOME + path.sep) ? "~" + p.slice(HOME.length) : p;
}

// ---------------------------------------------------------------------------
// readline prompts. ONE shared interface for the whole run, with a line queue
// so it works identically for an interactive TTY and for piped stdin (where
// every line, and EOF, can arrive before we ask the next question). Creating a
// fresh interface per question, or recreating it after EOF, drops buffered
// input. In non-interactive mode stdin is never touched.
// ---------------------------------------------------------------------------
let rl = null;
const lineQueue = [];
const lineWaiters = [];
let stdinEnded = false;

function getRl() {
  if (rl) return rl;
  // terminal follows stdin, not stdout: with stdout piped, readline would
  // otherwise drop terminal mode and the hidden password prompt would echo.
  // historySize 0: readline keeps no line history, so a hidden password can
  // never be recalled (and echoed) with the Up arrow at a later prompt.
  rl = createInterface({
    input: process.stdin,
    output: process.stdout,
    terminal: Boolean(process.stdin.isTTY),
    historySize: 0,
  });
  // Ctrl-C at a prompt aborts the run; without a listener readline would
  // merely pause, which the line queue reads as "accept the defaults".
  rl.on("SIGINT", () => {
    process.stdout.write("\nAborted.\n");
    process.exit(130);
  });
  rl.on("line", (line) => {
    if (lineWaiters.length) lineWaiters.shift()(line);
    else lineQueue.push(line);
  });
  rl.on("close", () => {
    stdinEnded = true;
    // Drain any pending waiters with empty answers (EOF means accept defaults).
    while (lineWaiters.length) lineWaiters.shift()("");
  });
  return rl;
}
function closeRl() {
  if (rl) {
    rl.close();
    rl = null;
  }
}

function nextLine() {
  return new Promise((resolve) => {
    if (lineQueue.length) return resolve(lineQueue.shift());
    if (stdinEnded) return resolve("");
    lineWaiters.push(resolve);
  });
}

async function ask(question, { hidden = false } = {}) {
  if (NON_INTERACTIVE) return "";
  const r = getRl();
  process.stdout.write(question);
  let restore = null;
  if (hidden) {
    // Mute the echoed keystrokes (the prompt itself is already written above).
    const original = r._writeToOutput;
    r._writeToOutput = function (chunk) {
      if (chunk === "\n" || chunk === "\r\n") return original.call(this, chunk);
      return original.call(this, "");
    };
    restore = () => {
      r._writeToOutput = original;
    };
  }
  const line = await nextLine();
  if (restore) {
    restore();
    process.stdout.write("\n");
  }
  // A password is stored exactly as typed; only visible answers are trimmed.
  return hidden ? String(line) : String(line).trim();
}

function askHidden(question) {
  return ask(question, { hidden: true });
}

async function askYesNo(question, def = true) {
  if (NON_INTERACTIVE) {
    info(`${question} (non-interactive: ${def ? "yes" : "no"})`);
    return def;
  }
  const hint = def ? "[Y/n]" : "[y/N]";
  const a = (await ask(`  ${question} ${hint} `)).toLowerCase();
  if (!a) return def;
  return a === "y" || a === "yes";
}

// ---------------------------------------------------------------------------
// Extension artifacts. The purchased bundle keeps them at the bundle root
// (next to package.json); a source checkout produces them under
// web-ext-artifacts/ (npm run package) and dist/chrome/ (npm run build:chrome).
// Only report what is actually on disk, so the final instructions never point
// at a file this copy does not have.
// ---------------------------------------------------------------------------
function findArtifacts() {
  const found = { firefoxXpi: null, firefoxUnsignedZip: null, chromeZip: null, chromeDir: null };
  for (const dir of [ROOT, path.join(ROOT, "web-ext-artifacts")]) {
    if (!fs.existsSync(dir)) continue;
    for (const name of fs.readdirSync(dir).sort()) {
      const full = path.join(dir, name);
      if (!fs.statSync(full).isFile()) continue;
      if (name.endsWith(".xpi") && name.includes(VERSION)) {
        if (!found.firefoxXpi) found.firefoxXpi = full;
      } else if (/^uba-chrome-.*\.zip$/.test(name)) {
        if (!found.chromeZip) found.chromeZip = full;
      } else if (/^usable[-_]browser[-_]agent-.*\.zip$/.test(name) && !/^usable-browser-agent-[0-9.]+\.zip$/.test(name)) {
        if (!found.firefoxUnsignedZip) found.firefoxUnsignedZip = full;
      }
    }
  }
  for (const dir of [path.join(ROOT, "chrome"), path.join(ROOT, "dist", "chrome")]) {
    if (fs.existsSync(path.join(dir, "manifest.json"))) {
      found.chromeDir = dir;
      break;
    }
  }
  return found;
}

// ---------------------------------------------------------------------------
// Step implementations
// ---------------------------------------------------------------------------
function checkNode() {
  step("Check Node.js");
  const major = Number(process.versions.node.split(".")[0]);
  if (major >= 18) {
    ok(`Node ${process.version} (18 or newer required).`);
    return true;
  }
  fail(`Node ${process.version} is too old. Usable Browser Agent needs Node 18 or newer.`);
  info("Install a newer Node from https://nodejs.org (or via Homebrew: brew install node), then re-run.");
  return false;
}

async function checkPort() {
  step(`Check port ${PORT}`);
  const free = await isPortFree(PORT);
  if (free) {
    ok(`Port ${PORT} is free (the MCP server hosts the extension WebSocket here).`);
  } else {
    warn(`Port ${PORT} is already in use.`);
    info("That is fine if it is a Usable Browser Agent server your agent already launched.");
    info("If it is something else, free the port or set UBA_PORT to another value (then update");
    info("PORT in the extension's background.js to match). See docs/TROUBLESHOOTING.md.");
  }
  return free;
}

function installDeps() {
  step("Install dependencies");
  if (fs.existsSync(path.join(ROOT, "node_modules"))) {
    ok("node_modules already present, skipping npm install.");
    return true;
  }
  info("Running npm install (runtime dependencies only) ...");
  const r = runSync("npm", ["install", "--omit=dev", "--no-audit", "--no-fund"], { cwd: ROOT, stdio: "inherit" });
  if (r.status === 0) {
    ok("Dependencies installed.");
    return true;
  }
  fail("npm install failed. Fix the error above and re-run.");
  return false;
}

// --- Claude Code MCP registration -----------------------------------------
function configureClaude() {
  step("Register the MCP server with Claude Code");
  // Pass the port explicitly, mirroring the Codex block, so one UBA_PORT at
  // install time configures both agents the same way.
  // A custom vault location (UBA_SECRETS_FILE) has to reach the server the
  // agent launches, not just this installer, so it is registered alongside
  // the port.
  const addArgs = ["mcp", "add", "browser", "--scope", "user", "-e", `UBA_PORT=${PORT}`, ...SECRETS_ENV_ARGS, "--", "node", SERVER_ENTRY];
  const printedCmd = `claude ${addArgs.map(shellQuote).join(" ")}`;
  if (!commandExists("claude")) {
    warn("`claude` CLI not found on PATH, skipping automatic registration.");
    info("If you use Claude Code, run this once it is installed:");
    console.log(`\n    ${printedCmd}\n`);
    return;
  }
  // Idempotent: if a `browser` server is already registered, leave it alone.
  const existing = runSync("claude", ["mcp", "get", "browser"], { encoding: "utf8" });
  if (existing.status === 0) {
    ok("A `browser` MCP server is already registered with Claude Code, leaving it as is.");
    info("To repoint it at this copy, remove and re-add it:");
    console.log(`\n    claude mcp remove browser --scope user && ${printedCmd}\n`);
    info("To also opt out of hardened mode (UBA_STRICT_SECRETS=0), use this instead:");
    console.log(`\n    ${CLAUDE_OPT_OUT_REMOVE_AND_ADD}\n`);
    return;
  }
  const r = runSync("claude", addArgs, { stdio: "inherit" });
  if (r.status === 0) {
    ok("Registered `browser` with Claude Code (user scope).");
    info("To opt out of hardened mode later (UBA_STRICT_SECRETS=0), remove and re-add it:");
    console.log(`\n    ${CLAUDE_OPT_OUT_REMOVE_AND_ADD}\n`);
  } else {
    warn("`claude mcp add` did not succeed. Run it manually:");
    console.log(`\n    ${printedCmd}\n`);
  }
}

// --- Codex MCP registration ------------------------------------------------
function configureCodex() {
  step("Register the MCP server with Codex");
  const envLines = ['UBA_PORT = "' + PORT + '"'];
  if (process.env.UBA_SECRETS_FILE) envLines.push(`UBA_SECRETS_FILE = ${JSON.stringify(SECRETS_FILE)}`);
  const block = [
    "",
    "[mcp_servers.browser]",
    'command = "node"',
    `args = [${JSON.stringify(SERVER_ENTRY)}]`,
    "",
    "[mcp_servers.browser.env]",
    ...envLines,
    "",
  ].join("\n");

  // The single-line form of the same entry, for configs the installer must
  // not edit (inline root table) and for machines without Codex.
  const inlineEntry = `browser = { command = "node", args = [${JSON.stringify(SERVER_ENTRY)}], env = { ${envLines.join(", ")} } }`;

  if (!commandExists("codex") && !fs.existsSync(path.dirname(CODEX_CONFIG))) {
    info("Codex not found (no `codex` CLI and no ~/.codex directory), skipping.");
    info(`If you install Codex later, add this to ${tilde(CODEX_CONFIG)}:`);
    console.log(block);
    return;
  }

  let existing = "";
  if (fs.existsSync(CODEX_CONFIG)) {
    existing = fs.readFileSync(CODEX_CONFIG, "utf8");
  }
  const state = codexBrowserState(existing);
  if (state === "inline") {
    warn(`${tilde(CODEX_CONFIG)} defines mcp_servers as an inline table; TOML does not allow adding a table to it from outside its braces, so this file is left untouched.`);
    info("Add this entry inside the mcp_servers braces (or update an existing browser entry to it):");
    console.log(`\n    ${inlineEntry}\n`);
    return;
  }
  if (state === "table") {
    ok(`Codex already defines a browser MCP server in ${tilde(CODEX_CONFIG)}, leaving it as is.`);
    info("If it points at an old path, edit that definition to:");
    console.log(`\n    args = [${JSON.stringify(SERVER_ENTRY)}]\n`);
    return;
  }
  fs.mkdirSync(path.dirname(CODEX_CONFIG), { recursive: true });
  if (existing) {
    // Appending to a hand-written config: keep a copy so any surprise is
    // one file rename away from undone.
    const backup = `${CODEX_CONFIG}.bak-${new Date().toISOString().replace(/[:.]/g, "-")}`;
    fs.copyFileSync(CODEX_CONFIG, backup);
    info(`Backed up the existing config to ${tilde(backup)}.`);
  }
  const needsNewline = existing && !existing.endsWith("\n");
  fs.appendFileSync(CODEX_CONFIG, (needsNewline ? "\n" : "") + block);
  ok(`Appended [mcp_servers.browser] to ${tilde(CODEX_CONFIG)} (resolved to this copy).`);
}

// How does the Codex config relate to mcp_servers.browser?
//   "table"  a browser server is defined in a form the installer could have
//            written: a [mcp_servers.browser] table (with or without
//            sub-tables), a top-level dotted key (mcp_servers.browser.x = ..),
//            or a `browser` / `browser.x` key inside the [mcp_servers] section.
//   "inline" mcp_servers is an INLINE TABLE (mcp_servers = { .. }) at the
//            root, whatever it contains (or, conservatively, anywhere). TOML forbids adding a table to an inline
//            table from outside its braces, so appending [mcp_servers.browser]
//            would make the whole file unparseable and Codex would drop every
//            server the user has. The installer never edits this shape; it
//            prints the entry for the user to paste inside the braces. No
//            brace or string scanning is attempted (a `}` inside a string
//            value defeats any scanner), which is exactly why the shape is
//            refused as a whole.
//   ""       nothing relevant: appending a table is valid.
// A `browser` key under any other table (say [tui]) does not count.
function codexBrowserState(toml) {
  const key = `(?:browser|"browser"|'browser')`;
  const servers = `(?:mcp_servers|"mcp_servers"|'mcp_servers')`;
  const keyAssign = `${key}\\s*(?:\\.[^=\\n]*)?=`;
  // No attempt is made to find "the root": a line starting with `[` can be
  // an array continuation or text inside a """ string, so any boundary guess
  // can hide a real root-level key and turn a refusal into a corrupting
  // append. Both root-level forms are therefore tested against the whole
  // file; a match under some other table only costs a printed hint.
  if (new RegExp(`^\\s*${servers}\\s*=`, "m").test(toml)) return "inline";
  // [mcp_servers.browser] or [mcp_servers.browser.env]
  if (new RegExp(`^\\s*\\[\\s*${servers}\\s*\\.\\s*${key}\\s*(?:\\.[^\\]]*)?\\]`, "m").test(toml)) return "table";
  // mcp_servers.browser = { .. } or mcp_servers.browser.command = .. (dotted key)
  if (new RegExp(`^\\s*${servers}\\s*\\.\\s*${keyAssign}`, "m").test(toml)) return "table";
  // browser = .. or browser.command = .. between the [mcp_servers] header and the next header
  const section = new RegExp(`^\\s*\\[\\s*${servers}\\s*\\][^\\n]*\\n([\\s\\S]*?)(?=^\\s*\\[|(?![\\s\\S]))`, "m").exec(toml);
  if (section && new RegExp(`^\\s*${keyAssign}`, "m").test(section[1])) return "table";
  return "";
}

// --- Smoke test ------------------------------------------------------------
function runSmoke(portFree) {
  step("Run the smoke test");
  info("Booting the MCP server, listing tools, confirming the bridge listens (no browser needed) ...");
  const env = { ...process.env };
  if (!portFree) {
    // The checked port is held (usually by the user's own running server).
    // The smoke test picks a free port when UBA_PORT is unset, so drop it
    // rather than fail with EADDRINUSE.
    delete env.UBA_PORT;
    info(`Port ${PORT} is busy, so the smoke test starts its own server on a free port.`);
  }
  const r = runSync("npm", ["run", "smoke"], { cwd: ROOT, stdio: "inherit", env });
  if (r.status === 0) {
    ok("Smoke test PASSED.");
    return true;
  }
  fail("Smoke test FAILED. See the output above and docs/TROUBLESHOOTING.md.");
  if (fs.existsSync(SECRETS_FILE)) {
    info(`The server loads the credential vault at boot: if ${tilde(SECRETS_FILE)} is not valid JSON, that alone fails this test.`);
  }
  return false;
}

// --- Guided secret ---------------------------------------------------------
function readVault() {
  if (!fs.existsSync(SECRETS_FILE)) return [];
  const raw = fs.readFileSync(SECRETS_FILE, "utf8").trim();
  if (!raw) return [];
  const parsed = JSON.parse(raw);
  if (!Array.isArray(parsed)) throw new Error("secrets.json must contain a JSON array.");
  return parsed;
}

function writeVault(entries) {
  const dir = path.dirname(SECRETS_FILE);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  // Write to a fresh sibling file that is created exclusively with mode 0600
  // (and fchmod'd to 0600 regardless of umask) BEFORE any plaintext is written,
  // then rename it over the target. A pre-existing secrets.json with looser
  // permissions is therefore never rewritten in place: the plaintext is only
  // ever readable through a 0600 inode, and the swap is atomic.
  const tmp = path.join(dir, `.secrets.json.${process.pid}.${Date.now()}.tmp`);
  const fd = fs.openSync(tmp, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL, 0o600);
  try {
    fs.fchmodSync(fd, 0o600);
    fs.writeSync(fd, JSON.stringify(entries, null, 2) + "\n");
    fs.fsyncSync(fd);
  } catch (e) {
    fs.closeSync(fd);
    fs.rmSync(tmp, { force: true });
    throw e;
  }
  fs.closeSync(fd);
  try {
    fs.renameSync(tmp, SECRETS_FILE);
  } catch (e) {
    fs.rmSync(tmp, { force: true });
    throw e;
  }
}

async function maybeAddSecret() {
  step("Add a login (optional)");
  info("The credential broker logs you into a site by ALIAS; the agent never sees the value.");
  info(`Stored locally at ${tilde(SECRETS_FILE)} (mode 0600). You can skip and add later.`);
  const wants = await askYesNo("Add a login now?", false);
  if (!wants) {
    info("Skipped. Add one anytime by re-running this installer or editing secrets.json.");
    return;
  }

  let entries;
  try {
    entries = readVault();
  } catch (e) {
    // A SyntaxError from JSON.parse quotes the offending source text in its
    // message, which for this file can be a password fragment. Never echo it.
    const why = e instanceof SyntaxError ? "it is not valid JSON" : e.message;
    fail(`Could not read existing ${tilde(SECRETS_FILE)}: ${why}`);
    info("Fix or remove that file, then re-run. Not touching it.");
    return;
  }

  const alias = await ask("  Alias (a short name, e.g. github): ");
  if (!alias) {
    warn("No alias given, skipping.");
    return;
  }
  if (entries.some((e) => e && e.alias === alias)) {
    warn(`An entry with alias "${alias}" already exists, not overwriting it.`);
    info("Choose a different alias or edit secrets.json by hand.");
    return;
  }
  const domainsRaw = await ask("  Allowed domain(s), comma-separated (e.g. github.com): ");
  const domains = [...new Set(domainsRaw.split(",").map(toHostname).filter(Boolean))];
  if (domains.join(",") !== domainsRaw.split(",").map((d) => d.trim()).filter(Boolean).join(",")) {
    info(`Stored as hostnames: ${domains.join(", ")}`);
  }
  if (!domains.length) {
    warn("No domains given, skipping (a login must be domain-locked).");
    return;
  }
  const username = await ask("  Username / email (leave blank if the site has none): ");
  const password = await askHidden("  Password (hidden): ");
  if (!password) {
    warn("No password given, skipping.");
    return;
  }

  entries.push({ alias, domains, username, password });
  try {
    writeVault(entries);
    ok(`Saved login "${alias}" for ${domains.join(", ")} to ${tilde(SECRETS_FILE)} (0600).`);
  } catch (e) {
    fail(`Could not write secrets file: ${e.message}`);
  }
}

// A pasted URL ("https://github.com/login") is stored as its hostname, which
// is the only form the server's domain matcher compares against.
function toHostname(raw) {
  const s = raw.trim();
  if (!s) return "";
  const looksLikeUrl = /^[a-z][a-z0-9+.-]*:\/\//i.test(s) || s.includes("/") || s.includes(":");
  if (looksLikeUrl) {
    try {
      return new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(s) ? s : `https://${s}`).hostname.toLowerCase();
    } catch {
      return s.toLowerCase();
    }
  }
  return s.toLowerCase();
}

// --- OS-level input notes ---------------------------------------------------
async function osLevelNotes() {
  step("OS-level input tools");
  if (process.platform === "darwin") {
    info("The last-mile OS tools (browser_os_type / browser_os_click / native dialogs) need:");
    console.log(`    1. ${bold("Accessibility permission")}: System Settings > Privacy & Security >`);
    console.log("       Accessibility > enable the app that runs the MCP server (your terminal,");
    console.log("       iTerm or IDE). Without it, OS keystrokes silently do nothing.");
    console.log(`    2. ${bold("cliclick")}: needed only for raw coordinate clicks (browser_os_click*).`);
    if (commandExists("cliclick")) {
      ok("cliclick is already installed.");
    } else if (commandExists("brew")) {
      const wants = await askYesNo("Install cliclick now via Homebrew (brew install cliclick)?", false);
      if (wants) {
        // Release the TTY (readline keeps it in raw mode while a prompt is
        // open) so brew's own prompts and Ctrl-C work during the install.
        // This is the last prompt-driven step, so nothing needs readline after.
        closeRl();
        const r = spawnSync("brew", ["install", "cliclick"], { stdio: "inherit" });
        if (r.error) fail(`brew could not be started: ${r.error.message}`);
        if (r.status === 0) ok("cliclick installed.");
        else warn("brew install cliclick failed. Install it later with: brew install cliclick");
      } else {
        info("Skipped. Install later with: brew install cliclick");
      }
    } else {
      info("Homebrew not found. Install it from https://brew.sh, then: brew install cliclick");
    }
    info("Run `npm run native` (or the browser_native_status tool) to see what is available.");
  } else {
    info(`Detected ${process.platform}. The OS-level input tools (browser_os_*, native dialogs)`);
    info("are macOS-only. The core browser tools AND the credential broker work fully here;");
    info("you only lose the rare last-mile cases that need OS-trusted input.");
  }
}

// --- Extension install steps, both browsers ---------------------------------
function extensionSteps(artifacts) {
  step("Install the Firefox extension (Firefox 142 or newer)");
  if (artifacts.firefoxXpi) {
    console.log(`  Open Firefox > ${bold("about:addons")} > gear icon > ${bold("Install Add-on From File")}`);
    console.log(`  > choose ${bold(artifacts.firefoxXpi)} > ${bold("Add")}.`);
    info("This is the Mozilla-signed build: it installs permanently and survives restarts.");
  } else if (artifacts.firefoxUnsignedZip) {
    warn(`This copy has an unsigned Firefox build: ${artifacts.firefoxUnsignedZip}`);
    info("Release Firefox only installs signed add-ons permanently. Either sign it yourself");
    info("(npm run package with free AMO credentials, see docs/INSTALL.md), use Firefox");
    info("Developer Edition / Nightly / ESR with xpinstall.signatures.required set to false in");
    info("about:config, or load it temporarily from about:debugging#/runtime/this-firefox.");
  } else {
    warn("No Firefox artifact found next to this copy.");
    info("From source: npm run package produces the .xpi (signed when AMO credentials are set,");
    info("unsigned otherwise). For development, about:debugging#/runtime/this-firefox >");
    info("Load Temporary Add-on > extension/manifest.json (unloads when Firefox restarts).");
  }

  step("Install the Chrome extension (Chrome 116 or newer)");
  info("The Chrome Web Store listing is not published yet; once it is, install from the store.");
  info("Until then, load the unpacked build:");
  if (artifacts.chromeDir) {
    console.log(`  Open Chrome > ${bold("chrome://extensions")} > enable ${bold("Developer mode")} >`);
    console.log(`  ${bold("Load unpacked")} > select ${bold(artifacts.chromeDir)}.`);
  } else if (artifacts.chromeZip) {
    console.log(`  Unzip ${bold(artifacts.chromeZip)} into a folder, then open Chrome >`);
    console.log(`  ${bold("chrome://extensions")} > enable ${bold("Developer mode")} > ${bold("Load unpacked")} > select that folder.`);
  } else {
    warn("No Chrome build found next to this copy.");
    info("From source: npm run build:chrome, then chrome://extensions > Developer mode >");
    info("Load unpacked > select dist/chrome/.");
  }
  info("Chrome shows a 'developer mode extensions' notice at startup for unpacked builds; that is expected.");

  console.log("");
  console.log(`  ${bold("Either browser:")} the toolbar badge turns ${bold(green("ON"))} once the extension connects`);
  console.log("  to the MCP server your agent launched. Then log into your sites and ask your agent");
  console.log("  to run a browser task.");
}

function finalNote(results, artifacts) {
  console.log(`\n${bold("--------------------------------------------------------")}`);
  console.log(bold(`Setup complete for Usable Browser Agent ${VERSION}.`));
  console.log("");
  console.log("  Extension artifacts in this copy:");
  console.log(`    Firefox signed XPI:   ${artifacts.firefoxXpi ? tilde(artifacts.firefoxXpi) : "not present"}`);
  if (artifacts.firefoxUnsignedZip) console.log(`    Firefox unsigned zip: ${tilde(artifacts.firefoxUnsignedZip)}`);
  console.log(`    Chrome (unpacked):    ${artifacts.chromeDir ? tilde(artifacts.chromeDir) : "not present"}`);
  console.log(`    Chrome zip:           ${artifacts.chromeZip ? tilde(artifacts.chromeZip) : "not present"}`);
  console.log("  (The free personal/eval Firefox build is a source-checkout artifact and is not part of");
  console.log("  the purchased bundle; see docs/FREE-TIER.md in the source repository.)");
  console.log("");
  console.log("  Hardened mode is on by default: browser_eval is disabled and screenshots are blocked");
  console.log("  near password fields. To opt out (UBA_STRICT_SECRETS=0), remove and re-add the Claude Code");
  console.log("  registration:");
  console.log(`\n    ${CLAUDE_OPT_OUT_REMOVE_AND_ADD}\n`);
  console.log("  or set UBA_STRICT_SECRETS = \"0\" under [mcp_servers.browser.env] for Codex (docs/INSTALL.md).");
  console.log("");
  console.log("  Docs:  docs/INSTALL.md, docs/TROUBLESHOOTING.md, docs/UNINSTALL.md");
  console.log("  Trust: docs/CREDENTIAL-SAFETY.md (how your passwords stay out of the agent)");
  console.log("  Terms: legal/EULA.md (commercial license), legal/PRIVACY.md, legal/REFUND-POLICY.md");
  console.log("");
  console.log("  Using it for work? The commercial license is $39 once (no subscription, includes the Chrome build):");
  console.log("  https://savvytechsphere.com/usable-browser-agent?utm_source=installer&utm_medium=cli&utm_campaign=free-tier   14-day, no-questions refund.");
  if (!results.smoke) {
    console.log("");
    warn("The smoke test did not pass. Resolve that before relying on the agent.");
  }
  console.log(bold("--------------------------------------------------------\n"));
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main() {
  console.log(bold(`\nUsable Browser Agent ${VERSION}: installer${NON_INTERACTIVE ? " (non-interactive)" : ""}`));
  console.log(dim(`Install dir: ${ROOT}`));

  if (!checkNode()) process.exit(1);
  const portFree = await checkPort();
  if (!installDeps()) process.exit(1);
  configureClaude();
  configureCodex();
  const smoke = runSmoke(portFree);
  await maybeAddSecret();
  await osLevelNotes();
  closeRl();
  const artifacts = findArtifacts();
  extensionSteps(artifacts);
  finalNote({ smoke }, artifacts);
  process.exit(smoke ? 0 : 1);
}

main().catch((e) => {
  console.error(`\n${red("Installer error:")} ${e?.stack || e}`);
  process.exit(1);
});
