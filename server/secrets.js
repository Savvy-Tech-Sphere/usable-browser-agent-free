import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const DEFAULT_SECRETS_FILE = "~/.config/usable-browser-agent/secrets.json";
export const REDACTED = "[redacted]";

export function expandHome(filePath, homeDir = os.homedir()) {
  if (filePath === "~") return homeDir;
  if (filePath.startsWith("~/")) return path.join(homeDir, filePath.slice(2));
  return filePath;
}

export function secretsFileFromEnv(env = process.env) {
  return expandHome(env.UBA_SECRETS_FILE || DEFAULT_SECRETS_FILE);
}

export function normalizeHostname(hostname) {
  return String(hostname || "")
    .trim()
    .toLowerCase()
    .replace(/^\*\./, "")
    .replace(/\.$/, "");
}

export function hostMatchesDomain(host, domain) {
  const normalizedHost = normalizeHostname(host);
  const normalizedDomain = normalizeHostname(domain);
  if (!normalizedHost || !normalizedDomain) return false;
  return normalizedHost === normalizedDomain || normalizedHost.endsWith(`.${normalizedDomain}`);
}

export function secretAllowedOnHost(secret, host) {
  return (secret.domains || []).some((domain) => hostMatchesDomain(host, domain));
}

export function activeHostFromStatus(status) {
  const url = status?.activeTab?.url;
  if (!url) return "";
  try {
    return new URL(url).hostname;
  } catch {
    return "";
  }
}

function fileMode(mode) {
  return (mode & 0o777).toString(8).padStart(4, "0");
}

function validateSecret(entry, index) {
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
    throw new Error(`Secret entry at index ${index} must be an object.`);
  }
  if (!entry.alias || typeof entry.alias !== "string") {
    throw new Error(`Secret entry at index ${index} must include a string alias.`);
  }
  if (!Array.isArray(entry.domains) || !entry.domains.every((domain) => typeof domain === "string" && domain.trim())) {
    throw new Error(`Secret '${entry.alias}' must include a non-empty domains array.`);
  }
  if (typeof entry.username !== "string") {
    throw new Error(`Secret '${entry.alias}' must include a string username.`);
  }
  if (typeof entry.password !== "string") {
    throw new Error(`Secret '${entry.alias}' must include a string password.`);
  }
  return {
    alias: entry.alias,
    domains: entry.domains.map(normalizeHostname),
    username: entry.username,
    password: entry.password,
  };
}

export class JsonSecretsVault {
  constructor({ filePath = secretsFileFromEnv(), warn = (message) => process.stderr.write(`${message}\n`) } = {}) {
    this.filePath = expandHome(filePath);
    this.warn = warn;
    this.loaded = false;
    this.scrubLoadWarningShown = false;
    this.secrets = new Map();
    this.secretValues = new Set();
  }

  load() {
    if (this.loaded) return;
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true, mode: 0o700 });
    if (!fs.existsSync(this.filePath)) {
      this.loaded = true;
      return;
    }

    const stat = fs.statSync(this.filePath);
    if ((stat.mode & 0o077) !== 0) {
      this.warn(`[uba] WARNING: secrets file ${this.filePath} has mode ${fileMode(stat.mode)}; recommended mode is 0600.`);
    }

    const raw = fs.readFileSync(this.filePath, "utf8");
    const parsed = raw.trim() ? JSON.parse(raw) : [];
    if (!Array.isArray(parsed)) {
      throw new Error("Secrets file must contain a JSON array.");
    }

    const aliases = new Set();
    for (let i = 0; i < parsed.length; i++) {
      const secret = validateSecret(parsed[i], i);
      if (aliases.has(secret.alias)) throw new Error(`Duplicate secret alias '${secret.alias}'.`);
      aliases.add(secret.alias);
      this.secrets.set(secret.alias, secret);
      if (secret.username) this.secretValues.add(secret.username);
      if (secret.password) this.secretValues.add(secret.password);
    }
    this.loaded = true;
  }

  get(alias) {
    this.load();
    return this.secrets.get(alias) || null;
  }

  loadForScrub() {
    if (this.loaded) return true;
    try {
      this.load();
      return true;
    } catch (e) {
      if (!this.scrubLoadWarningShown) {
        this.warn(`[uba] WARNING: could not load secrets file for output redaction: ${e.message}`);
        this.scrubLoadWarningShown = true;
      }
      return false;
    }
  }

  scrubText(text) {
    if (typeof text !== "string") return text;
    if (!this.loadForScrub()) return REDACTED;
    if (this.secretValues.size === 0) return text;
    let scrubbed = text;
    const values = Array.from(this.secretValues).sort((a, b) => b.length - a.length);
    for (const value of values) {
      if (!value) continue;
      scrubbed = scrubbed.split(value).join(REDACTED);
    }
    return scrubbed;
  }

  scrub(value) {
    if (typeof value === "string") return this.scrubText(value);
    if (Array.isArray(value)) return value.map((item) => this.scrub(item));
    if (!value || typeof value !== "object") return value;

    const scrubbed = {};
    for (const [key, item] of Object.entries(value)) {
      scrubbed[key] = this.scrub(item);
    }
    return scrubbed;
  }
}

async function allowedSecret(alias, { vault, call }) {
  if (!alias) throw new Error("secret alias is required.");

  const secret = vault.get(alias);
  if (!secret) throw new Error(`secret '${alias}' not found`);

  const status = await call("status");
  const host = normalizeHostname(activeHostFromStatus(status));
  if (!host) throw new Error(`could not determine active host for secret '${alias}'`);
  if (!secretAllowedOnHost(secret, host)) {
    throw new Error(`secret '${alias}' is not allowed on host ${host}`);
  }

  return { secret, tabId: status?.activeTab?.id };
}

export async function fillSecret({ ref, secret: alias, field = "password" }, { vault, call }) {
  if (!ref) throw new Error("ref is required.");
  if (!["username", "password"].includes(field)) throw new Error("field must be username or password.");

  const { secret, tabId } = await allowedSecret(alias, { vault, call });
  const params = { ref, value: secret[field] };
  if (Number.isInteger(tabId)) params.tabId = tabId;
  await call("fill_secret", params);
  return `filled ${field} into [${ref}]`;
}

export async function setHttpAuthSecret({ secret: alias, once = false }, { vault, call }) {
  if (!alias) throw new Error("secret alias is required.");
  const secret = vault.get(alias);
  if (!secret) throw new Error(`secret '${alias}' not found`);
  if (!secret.domains || !secret.domains.length) throw new Error(`secret '${alias}' has no domains to scope HTTP auth to.`);
  // The credential value travels server -> extension over loopback, scoped to the
  // secret's own domains. The agent only ever passed the alias.
  await call("set_http_auth", {
    username: secret.username,
    password: secret.password,
    domains: secret.domains,
    once: once === true,
  });
  return `HTTP auth armed for ${secret.domains.join(", ")} (alias '${alias}')`;
}

export async function loginSecret({ secret: alias, password_ref, username_ref, submit_ref }, { vault, call }) {
  if (!password_ref) throw new Error("password_ref is required.");

  const { secret, tabId } = await allowedSecret(alias, { vault, call });
  const params = {
    passwordRef: password_ref,
    password: secret.password,
  };
  if (Number.isInteger(tabId)) params.tabId = tabId;
  if (username_ref && secret.username) {
    params.usernameRef = username_ref;
    params.username = secret.username;
  }
  if (submit_ref) params.submitRef = submit_ref;

  const result = await call("login", params);
  if (submit_ref) return `logged in via [${submit_ref}]`;
  return result?.submitted === "enter" ? "submitted via Enter" : "submitted form";
}
