import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { WorkflowMemoryStore, formatWorkflowMemories } from "../server/memory.js";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "uba-workflow-memory-"));
const file = path.join(dir, "workflow-memory.jsonl");

try {
  const store = new WorkflowMemoryStore({
    filePath: file,
    now: () => new Date("2026-06-04T12:00:00.000Z"),
    warn: () => {},
  });

  const first = store.remember({
    task: "Create a new Android app in Google Play Console",
    site: "Google Play Console",
    url: "https://play.google.com/console/u/0/developers/123/app-create",
    title: "Create app - Google Play Console",
    tags: ["play-store", "android"],
    steps: [
      "Open Play Console and choose All apps.",
      "Click Create app.",
      "Fill App name, default language, app/game, and free/paid fields.",
      "Acknowledge the declarations, then click Create app.",
    ],
    pitfalls: ["The old App content path was moved under the Setup section."],
    selectors: ["Button label: Create app", "Field label: App name"],
    notes: "Do not store one-time codes. token=abc123456789 should be redacted.",
    outcome: "App draft created.",
    confidence: "high",
  });

  assert.equal(first.domain, "play.google.com");
  assert.equal(first.url, "https://play.google.com/console/u/:id/developers/:id/app-create");
  assert.equal(fs.readFileSync(file, "utf8").includes("abc123456789"), false, "memory file stored a token-like value");
  assert.equal(fs.readFileSync(file, "utf8").includes("/developers/123"), false, "memory file stored a raw developer id URL path");
  assert.throws(
    () =>
      store.remember({
        task: "Bad transient ref workflow",
        site: "example.com",
        steps: ["Click [ref=e42] to continue."],
      }),
    /transient snapshot refs/,
    "workflow memory should reject transient snapshot refs"
  );

  const matches = store.search({
    query: "add another app to play store",
    site: "play.google.com",
  });
  assert.equal(matches[0].id, first.id);
  assert.equal(matches[0].confidence, "high");

  const formatted = formatWorkflowMemories(matches, { query: "add another app to play store", site: "play.google.com" });
  assert.match(formatted, /Create a new Android app/);
  assert.match(formatted, /Button label: Create app/);

  const replacement = store.remember({
    task: "Create a new Android app in Google Play Console",
    site: "play.google.com",
    steps: ["Open All apps.", "Click Create app.", "Use the updated Policy declaration panel before creating the app."],
    supersedes: [first.id],
    confidence: "medium",
  });
  assert.equal(store.list().some((entry) => entry.id === first.id), false, "superseded memory should not be active");
  assert.equal(store.list().some((entry) => entry.id === replacement.id), true, "replacement memory should be active");

  const hints = store.hintsForTab({ url: "https://play.google.com/console/u/0/developers/123", title: "Google Play Console" });
  assert.equal(hints[0].id, replacement.id);
  assert.deepEqual(hints[0].firstSteps, replacement.steps.slice(0, 3));

  store.forget(replacement.id, "stale");
  assert.equal(store.list().some((entry) => entry.id === replacement.id), false, "forgotten memory should not be active");
  assert.throws(() => store.forget("missing"), /not found/);

  console.log("workflow memory tests passed");
} finally {
  fs.rmSync(dir, { recursive: true, force: true });
}
