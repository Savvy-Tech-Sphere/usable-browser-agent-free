// Installer license note: the commercial-license note at "Setup complete"
// prints only for the free tier, decided from the extension artifacts that sit
// next to the copy (a signed Firefox XPI or the Chrome build means the
// purchased bundle). Deterministic, no browser needed.
// Run: node test/installer-license-note.mjs

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

delete process.env.UBA_PORT;
const { findArtifacts, isFreeTierInstall, licenseNote } = await import("../bin/uba-install.mjs");

const VERSION = "9.9.9";
let passed = 0;
function check(name, fn) {
  fn();
  passed++;
  console.log(`  ✓ ${name}`);
}

function layout(files) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "uba-install-note-"));
  for (const rel of files) {
    const full = path.join(root, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, "{}");
  }
  return root;
}

function decide(files) {
  const root = layout(files);
  try {
    const artifacts = findArtifacts(root, VERSION);
    return { artifacts, free: isFreeTierInstall(artifacts), note: licenseNote(artifacts) };
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

console.log("Installer license note");

check("importing the installer does not start it", () => {
  assert.equal(typeof findArtifacts, "function");
});

check("no extension artifacts (the free export): the note prints", () => {
  const r = decide(["package.json", "server/index.js"]);
  assert.equal(r.free, true);
  assert.equal(r.note.length, 3);
});

check("only an unsigned Firefox zip: still the free tier, the note prints", () => {
  const r = decide([`web-ext-artifacts/usable_browser_agent-${VERSION}.zip`]);
  assert.ok(r.artifacts.firefoxUnsignedZip);
  assert.equal(r.free, true);
});

check("an XPI for another version does not count as the paid build", () => {
  assert.equal(decide(["usable-browser-agent-1.0.0.xpi"]).free, true);
});

for (const [label, files] of [
  ["signed Firefox XPI at the root", [`usable-browser-agent-${VERSION}.xpi`]],
  ["signed Firefox XPI under web-ext-artifacts", [`web-ext-artifacts/usable-browser-agent-${VERSION}.xpi`]],
  ["unpacked Chrome build in chrome/", ["chrome/manifest.json"]],
  ["unpacked Chrome build in dist/chrome/", ["dist/chrome/manifest.json"]],
  ["Chrome zip", [`uba-chrome-${VERSION}.zip`]],
]) {
  check(`${label} (paid bundle): no note`, () => {
    const r = decide(files);
    assert.equal(r.free, false);
    assert.deepEqual(r.note, []);
  });
}

check("note wording: price, link on its own line, refund on its own line, no em dash or email", () => {
  const note = decide([]).note;
  assert.equal(note[0], "  Using it for work? The commercial license is $39 once (no subscription, includes the Chrome build):");
  assert.equal(note[1], "  https://savvytechsphere.com/usable-browser-agent?utm_source=installer&utm_medium=cli&utm_campaign=free-tier");
  assert.equal(note[2], "  14-day, no-questions refund.");
  for (const line of note) {
    assert.ok(!line.includes("—"), "no em dash");
    assert.ok(!/@/.test(line), "no email address");
  }
});

console.log(`\nall ${passed} installer license note checks passed`);
