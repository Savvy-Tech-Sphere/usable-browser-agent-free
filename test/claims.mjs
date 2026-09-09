// Claim validation: each assertion below maps to a specific statement made
// about Usable Browser Agent's credential handling, so the product never
// makes a claim this suite does not back. Deterministic, no browser needed.
// Run: npm run claims

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  JsonSecretsVault,
  REDACTED,
  fillSecret,
  loginSecret,
  hostMatchesDomain,
  secretAllowedOnHost,
} from "../server/secrets.js";

// Deliberately NOT shaped like any real token prefix: this file ships to buyers
// and a scanner must not flag a test fixture.
const PASSWORD = "claims-secret-should-never-surface-9Z";
const USERNAME = "octo-claims@example.test";

let passed = 0;
async function claim(name, fn) {
  await fn();
  passed++;
  console.log(`  ✓ CLAIM: ${name}`);
}

function assertNoSecret(value) {
  const text = typeof value === "string" ? value : JSON.stringify(value);
  assert.equal(text.includes(PASSWORD), false, "secret password leaked");
  assert.equal(text.includes(USERNAME), false, "secret username leaked");
}

function writeVault() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "uba-claims-"));
  const file = path.join(dir, "secrets.json");
  fs.writeFileSync(
    file,
    JSON.stringify(
      [{ alias: "github", domains: ["github.com"], username: USERNAME, password: PASSWORD }],
      null,
      2
    ),
    { mode: 0o600 }
  );
  return { dir, file };
}

const { dir, file } = writeVault();
const vault = new JsonSecretsVault({ filePath: file, warn: () => {} });

try {
  console.log("Usable Browser Agent claim validation");

  await claim("The agent logs you in by alias and never receives the credential value", async () => {
    const result = await loginSecret(
      { secret: "github", username_ref: "e1", password_ref: "e2", submit_ref: "e3" },
      {
        vault,
        call: async (method) => {
          if (method === "status") return { activeTab: { id: 5, url: "https://github.com/login" } };
          if (method === "login") return { ok: true, submitted: "submit_ref" };
          throw new Error(`unexpected ${method}`);
        },
      }
    );
    // The agent's tool returns only a status string, no secret in it.
    assert.equal(result, "logged in via [e3]");
    assertNoSecret(result);
  });

  await claim("Credentials are refused on a host the alias does not allow (anti-phishing)", async () => {
    const calls = [];
    let threw = false;
    try {
      await fillSecret(
        { ref: "e1", secret: "github" },
        {
          vault,
          call: async (method, params) => {
            calls.push({ method, params });
            if (method === "status") return { activeTab: { url: "https://evilgithub.com/login" } };
            throw new Error(`unexpected ${method}`);
          },
        }
      );
    } catch (e) {
      threw = true;
      assert.match(e.message, /not allowed on host evilgithub\.com/);
      assertNoSecret(e.message);
    }
    assert.ok(threw, "expected refusal on a disallowed host");
    // ...and the value was never sent to the browser.
    assert.equal(calls.some((c) => c.method === "fill_secret"), false);
  });

  await claim("Host matching allows exact + subdomain but rejects lookalikes", async () => {
    assert.equal(hostMatchesDomain("github.com", "github.com"), true);
    assert.equal(hostMatchesDomain("gist.github.com", "github.com"), true);
    assert.equal(hostMatchesDomain("evilgithub.com", "github.com"), false);
    assert.equal(hostMatchesDomain("github.com.evil.test", "github.com"), false);
    assert.equal(secretAllowedOnHost({ domains: ["github.com"] }, "api.github.com"), true);
    assert.equal(secretAllowedOnHost({ domains: ["github.com"] }, "notgithub.com"), false);
  });

  await claim(
    "Secret values are scrubbed from every tool result the agent reads (snapshot text, read_text, eval)",
    async () => {
      // Mirrors what server/index.js does to every tool result: secretsVault.scrub(...).
      assert.equal(vault.scrubText(`token=${PASSWORD} user=${USERNAME}`), `token=${REDACTED} user=${REDACTED}`);
      const evalLike = vault.scrub({ content: [{ type: "text", text: `eval saw ${PASSWORD} and ${USERNAME}` }] });
      assert.equal(evalLike.content[0].text, `eval saw ${REDACTED} and ${REDACTED}`);
      assertNoSecret(vault.scrub({ a: [{ b: `deep ${PASSWORD}` }], c: USERNAME }));
    }
  );

  console.log(`\nall ${passed} product claims validated`);
} finally {
  fs.rmSync(dir, { recursive: true, force: true });
}
