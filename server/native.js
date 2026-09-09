// Usable Browser Agent — OS-level input sidecar (macOS).
//
// The last mile: things no browser extension can do because they require
// OS-trusted input (event.isTrusted === true) or live in native browser chrome
// (file pickers, print dialogs, basic-auth popups, permission prompts).
//
// This runs in the local MCP server process — NOT the extension sandbox — so it
// can drive the real keyboard/mouse via:
//   • osascript + System Events  (built into macOS; trusted keystrokes, dialog buttons)
//   • cliclick                   (optional `brew install cliclick`; raw coordinate clicks)
//
// One-time setup: grant Accessibility permission to the app running this server
// (Terminal / iTerm / your IDE) in System Settings → Privacy & Security →
// Accessibility. Without it, System Events keystrokes silently no-op.

import { execFile } from "node:child_process";
import { platform } from "node:os";

const IS_MAC = platform() === "darwin";

function run(cmd, args, { timeout = 8000 } = {}) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout }, (error, stdout, stderr) => {
      if (error) {
        const msg = (stderr || error.message || "").toString().trim();
        reject(new Error(msg || `${cmd} failed`));
      } else {
        resolve((stdout || "").toString().trim());
      }
    });
  });
}

let cliclickPath = null;
let cliclickChecked = false;
async function findCliclick() {
  if (cliclickChecked) return cliclickPath;
  cliclickChecked = true;
  try {
    cliclickPath = await run("/usr/bin/which", ["cliclick"]);
  } catch {
    cliclickPath = null;
  }
  return cliclickPath;
}

function requireMac() {
  if (!IS_MAC) throw new Error("OS-level input is only implemented on macOS.");
}

// AppleScript that reads its inputs from argv, so we never string-interpolate
// (and never break) on quotes, backslashes, or unicode in the text.
async function osascript(script, args = []) {
  requireMac();
  return run("/usr/bin/osascript", ["-e", script, ...args.map(String)]);
}

// Special keys -> macOS key codes (for System Events `key code`).
const KEY_CODES = {
  enter: 36, return: 36, tab: 48, space: 49, delete: 51, backspace: 51,
  escape: 53, esc: 53, left: 123, right: 124, down: 125, up: 126,
  home: 115, end: 119, pageup: 116, pagedown: 121, forwarddelete: 117,
  f1: 122, f2: 120, f3: 99, f4: 118, f5: 96, f6: 97, f7: 98, f8: 100,
};

function modifierClause(modifiers = []) {
  const map = { cmd: "command down", command: "command down", meta: "command down", ctrl: "control down", control: "control down", alt: "option down", option: "option down", shift: "shift down" };
  const downs = (modifiers || []).map((m) => map[String(m).toLowerCase()]).filter(Boolean);
  return downs.length ? ` using {${downs.join(", ")}}` : "";
}

export const nativeInput = {
  isMac: IS_MAC,

  async availability() {
    const cliclick = IS_MAC ? await findCliclick() : null;
    return {
      platform: platform(),
      osascript: IS_MAC, // built in on macOS
      cliclick: !!cliclick,
      cliclickPath: cliclick || null,
      notes: IS_MAC
        ? cliclick
          ? "Ready. Ensure this app has Accessibility permission."
          : "Trusted keystrokes + native dialogs ready. For raw coordinate clicks, run: brew install cliclick"
        : "OS-level input is implemented for macOS only.",
    };
  },

  // Trusted typing into whatever has focus (e.g. a native field or an
  // isTrusted-checking editor). Bring Firefox to the front first if asked.
  async type(textToType, { modifiers = [] } = {}) {
    requireMac();
    const clause = modifierClause(modifiers);
    await osascript(`on run argv\ntell application "System Events" to keystroke (item 1 of argv)${clause}\nend run`, [textToType]);
    return { ok: true, typed: textToType.length };
  },

  // Press a named key (Enter, Tab, Escape, arrows, F-keys, or a single char).
  async key(keyName, { modifiers = [] } = {}) {
    requireMac();
    const clause = modifierClause(modifiers);
    const code = KEY_CODES[String(keyName).toLowerCase()];
    if (code != null) {
      await osascript(`tell application "System Events" to key code ${code}${clause}`);
    } else if (String(keyName).length === 1) {
      await osascript(`on run argv\ntell application "System Events" to keystroke (item 1 of argv)${clause}\nend run`, [keyName]);
    } else {
      throw new Error(`Unknown key "${keyName}". Use Enter/Tab/Escape/Arrow*/F1-F8 or a single character.`);
    }
    return { ok: true, key: keyName };
  },

  // Raw screen-coordinate mouse action via cliclick (points, top-left origin).
  async click(x, y, { button = "left", count = 1 } = {}) {
    requireMac();
    const cliclick = await findCliclick();
    if (!cliclick)
      throw new Error("Raw coordinate clicks need cliclick. Install it with: brew install cliclick");
    const X = Math.round(x);
    const Y = Math.round(y);
    const cmds = [];
    if (button === "right") cmds.push(`rc:${X},${Y}`);
    else if (count >= 2) cmds.push(`dc:${X},${Y}`);
    else cmds.push(`c:${X},${Y}`);
    await run(cliclick, cmds);
    return { ok: true, x: X, y: Y, button, count };
  },

  async moveTo(x, y) {
    requireMac();
    const cliclick = await findCliclick();
    if (!cliclick) throw new Error("Mouse move needs cliclick. Install it with: brew install cliclick");
    await run(cliclick, [`m:${Math.round(x)},${Math.round(y)}`]);
    return { ok: true, x: Math.round(x), y: Math.round(y) };
  },

  // Bring a process (default Firefox) to the front so input lands there.
  async focusApp(appName = "Firefox") {
    requireMac();
    await osascript(`on run argv\ntell application (item 1 of argv) to activate\nend run`, [appName]);
    return { ok: true, app: appName };
  },

  // Interact with a native dialog/sheet of a process (file picker, print,
  // basic-auth, "Leave page?"). Best-effort: dialogs vary by macOS version.
  async dialog({ action = "list", button, text, process = "firefox" } = {}) {
    requireMac();
    if (action === "list") {
      const script = `on run argv
set procName to item 1 of argv
tell application "System Events" to tell process procName
  if (count of windows) is 0 then return "no windows"
  set out to ""
  try
    set out to out & "buttons: " & (name of buttons of window 1 as string)
  end try
  return out
end tell
end run`;
      return { ok: true, info: await osascript(script, [process]) };
    }
    if (action === "click_button") {
      if (!button) throw new Error("button name is required to click a dialog button.");
      const script = `on run argv
set procName to item 1 of argv
set btn to item 2 of argv
tell application "System Events" to tell process procName to click button btn of window 1
end run`;
      await osascript(script, [process, button]);
      return { ok: true, clicked: button };
    }
    if (action === "set_text") {
      // Type into the focused field of the frontmost dialog (e.g. a filename or
      // a basic-auth username). Assumes the field already has focus.
      if (text == null) throw new Error("text is required for set_text.");
      await this.focusApp(process === "firefox" ? "Firefox" : process);
      await this.type(String(text));
      return { ok: true };
    }
    throw new Error(`Unknown dialog action "${action}". Use list, click_button, or set_text.`);
  },

  async notify(title, message) {
    if (!IS_MAC) return { ok: false, reason: "notifications are macOS-only here" };
    await osascript(`on run argv\ndisplay notification (item 2 of argv) with title (item 1 of argv)\nend run`, [title || "Usable Browser Agent", message || ""]);
    return { ok: true };
  },
};
