// Boots the MCP server as a subprocess, performs the MCP handshake over stdio,
// lists tools, and confirms the WebSocket bridge is listening. No Firefox needed.
import { spawn } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { WebSocket } from "ws";

async function pickPort() {
  if (process.env.UBA_PORT) return Number(process.env.UBA_PORT);
  return await new Promise((resolve, reject) => {
    const s = net.createServer();
    s.on("error", reject);
    s.listen(0, "127.0.0.1", () => {
      const port = s.address().port;
      s.close(() => resolve(port));
    });
  });
}

const PORT = await pickPort();
const memoryDir = fs.mkdtempSync(path.join(os.tmpdir(), "uba-smoke-memory-"));
const memoryFile = path.join(memoryDir, "workflow-memory.jsonl");
const proc = spawn("node", ["server/index.js"], {
  stdio: ["pipe", "pipe", "inherit"],
  env: { ...process.env, UBA_PORT: String(PORT), UBA_MEMORY_FILE: memoryFile },
});
let fakeExtension = null;
let cleaned = false;
function cleanup() {
  if (cleaned) return;
  cleaned = true;
  try { fakeExtension?.close(); } catch {}
  try { proc.kill(); } catch {}
  try { fs.rmSync(memoryDir, { recursive: true, force: true }); } catch {}
}
process.on("exit", cleanup);

let buf = "";
const pending = new Map();
proc.stdout.on("data", (d) => {
  buf += d.toString();
  let i;
  while ((i = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, i).trim();
    buf = buf.slice(i + 1);
    if (!line) continue;
    let msg;
    try { msg = JSON.parse(line); } catch { continue; }
    if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); }
  }
});

let id = 0;
function rpc(method, params) {
  return new Promise((resolve) => {
    const myId = ++id;
    pending.set(myId, resolve);
    proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: myId, method, params }) + "\n");
  });
}
function notify(method, params) {
  proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", method, params }) + "\n");
}

function checkPort(port) {
  return new Promise((resolve) => {
    const s = net.connect(port, "127.0.0.1");
    s.on("connect", () => { s.end(); resolve(true); });
    s.on("error", () => resolve(false));
  });
}

function connectFakeExtension(port) {
  return new Promise((resolve, reject) => {
    const activeTab = { id: 1, url: "https://example.com/start", title: "Example" };
    const ws = new WebSocket(`ws://127.0.0.1:${port}/extension`);
    let settled = false;
    const timer = setTimeout(() => {
      if (!settled) reject(new Error("fake extension did not connect"));
    }, 5000);

    ws.on("open", () => {
      // The server adopts a socket as the extension only on this hello
      // (bare sockets on the port must never displace the real extension).
      ws.send(JSON.stringify({ type: "hello", role: "extension", browser: "firefox", version: "0.0.0-smoke" }));
      settled = true;
      clearTimeout(timer);
      resolve(ws);
    });
    ws.on("error", (e) => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        reject(e);
      }
    });
    ws.on("message", (data) => {
      let msg;
      try { msg = JSON.parse(data.toString()); } catch { return; }
      if (!msg || msg.type !== "command") return;

      let result;
      if (msg.method === "status") {
        result = { connected: true, activeTab };
      } else if (msg.method === "info") {
        result = { url: activeTab.url, title: activeTab.title, loadState: "complete" };
      } else if (msg.method === "navigate") {
        activeTab.url = msg.params?.url || activeTab.url;
        activeTab.title = "Example";
        result = "OK";
      } else if (msg.method === "snapshot") {
        result = {
          snapshot: `# Page snapshot\nurl: ${activeTab.url}\ntitle: ${activeTab.title}\n\n- text "Example Domain"`,
        };
      } else {
        result = { ok: true };
      }
      ws.send(JSON.stringify({ type: "response", id: msg.id, ok: true, result }));
    });
  });
}

await new Promise((r) => setTimeout(r, 800));

const init = await rpc("initialize", {
  protocolVersion: "2024-11-05",
  capabilities: {},
  clientInfo: { name: "smoke", version: "1.0" },
});
console.log("initialize -> server:", init.result?.serverInfo);
notify("notifications/initialized", {});

const tools = await rpc("tools/list", {});
const names = (tools.result?.tools || []).map((t) => t.name);
console.log(`tools (${names.length}):`, names.join(", "));

const remember = await rpc("tools/call", {
  name: "browser_workflow_remember",
  arguments: {
    task: "Smoke test reusable workflow",
    site: "example.com",
    steps: ["Open example.com.", "Verify the page loaded."],
    confidence: "high",
  },
});
const rememberText = remember.result?.content?.[0]?.text || "";
console.log("browser_workflow_remember:", rememberText.slice(0, 80));

const recall = await rpc("tools/call", {
  name: "browser_workflow_recall",
  arguments: { query: "smoke reusable workflow", site: "example.com" },
});
const recallText = recall.result?.content?.[0]?.text || "";
console.log("browser_workflow_recall:", recallText.slice(0, 80));

const portOpen = await checkPort(PORT);
console.log(`WebSocket bridge listening on ${PORT}:`, portOpen);

// Call a tool that needs the extension; should fail gracefully (no Firefox here).
const res = await rpc("tools/call", { name: "browser_status", arguments: {} });
const t = res.result?.content?.[0]?.text || "";
console.log("browser_status (no extension):", t.slice(0, 80));

fakeExtension = await connectFakeExtension(PORT);

const status = await rpc("tools/call", { name: "browser_status", arguments: {} });
const statusText = status.result?.content?.[0]?.text || "";
console.log("browser_status (with memory hint):", statusText.slice(0, 120));

const nav = await rpc("tools/call", { name: "browser_navigate", arguments: { url: "https://example.com/console/u/123" } });
const navText = nav.result?.content?.[0]?.text || "";
console.log("browser_navigate (with memory hint):", navText.slice(0, 120));

const snap = await rpc("tools/call", { name: "browser_snapshot", arguments: {} });
const snapText = snap.result?.content?.[0]?.text || "";
console.log("browser_snapshot (with memory hint):", snapText.slice(0, 120).replace(/\n/g, " "));

fakeExtension.close();
fakeExtension = null;

const passiveHintsWork =
  statusText.includes("workflowMemoryHints") &&
  statusText.includes("Smoke test reusable workflow") &&
  navText.includes("[workflow-memory") &&
  navText.includes("Smoke test reusable workflow") &&
  snapText.includes("[workflow-memory") &&
  snapText.includes("browser_workflow_recall");

const pass =
  names.length >= 20 &&
  portOpen &&
  t.includes("not connected") &&
  recallText.includes("Smoke test reusable workflow") &&
  passiveHintsWork;
console.log(pass ? "\nSMOKE TEST PASSED ✅" : "\nSMOKE TEST FAILED ❌");
cleanup();
process.exit(pass ? 0 : 1);
