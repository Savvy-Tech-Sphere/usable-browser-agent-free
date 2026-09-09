# Free tier (personal use and evaluation)

The free tier is the open-core packaging of Usable Browser Agent: the same
single-session extension and local MCP server as the commercial build,
licensed for personal use and evaluation. There is no license key in the free
tier and no key check anywhere in the product. The tiers differ in the
license grant, the extension identity (name and add-on id), and the bundled
license text; `test/free-build.mjs` locks that equivalence so the free build
cannot silently diverge from the commercial one.

## What the free tier includes

- The full single-session Firefox extension. The shared core files are
  byte-identical to the commercial build.
- The local MCP server with every `browser_*` tool, including the credential
  broker and workflow memory.
- A license for personal, non-commercial use and for evaluating the product
  before buying the commercial license. The terms are in
  `LICENSE-FREE-TIER.txt` at the repo root, bundled into the artifact as
  `LICENSE.txt`.

## What the free tier excludes

- Commercial use rights. Use in or for a business, use in paid client work,
  and use inside a commercial product or service require the commercial
  license.
- A Chrome build. The free tier ships Firefox first; the commercial license includes the
  Chrome (MV3) build.

## Get it

- Firefox extension: <https://addons.mozilla.org/firefox/addon/usable-browser-agent-free/>
- MCP server (this repository): see the README's **Get started**; `node bin/uba-install.mjs`
  wires it into Claude Code or Codex.

The extension is only half of the product: it talks to the local MCP server, which you run
yourself. The server is the same in both tiers.
