import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { expandHome, hostMatchesDomain, normalizeHostname } from "./secrets.js";

export const DEFAULT_MEMORY_FILE = "~/.local/state/usable-browser-agent/workflow-memory.jsonl";
const TRANSIENT_REF_PATTERN = /\[\s*ref\s*=\s*(?:f\d+-)?e\d+\s*\]/i;

export function memoryFileFromEnv(env = process.env) {
  return expandHome(env.UBA_MEMORY_FILE || DEFAULT_MEMORY_FILE);
}

export function hostnameFromUrl(url) {
  if (!url) return "";
  try {
    return normalizeHostname(new URL(url).hostname);
  } catch {
    return "";
  }
}

function maybeDomain(value) {
  const text = String(value || "").trim();
  if (!text) return "";
  const fromUrl = hostnameFromUrl(text);
  if (fromUrl) return fromUrl;
  if (/^[a-z0-9.-]+\.[a-z]{2,}$/i.test(text)) return normalizeHostname(text);
  return "";
}

function isoDate(value) {
  if (!value) return "";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "" : date.toISOString();
}

function cleanText(value, maxChars = 2000) {
  if (typeof value !== "string") return "";
  const normalized = redactPotentialSecrets(value.replace(/\r\n?/g, "\n").trim());
  return normalized.length > maxChars ? `${normalized.slice(0, maxChars - 3)}...` : normalized;
}

function decodePathSegment(segment) {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

function isLikelyIdentifierSegment(segment) {
  const text = decodePathSegment(String(segment || ""));
  return (
    /^\d+$/.test(text) ||
    /^[0-9a-f]{12,}$/i.test(text) ||
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(text) ||
    (/^[a-z][a-z0-9_]*(?:\.[a-z0-9_]+){2,}$/i.test(text) && text.length >= 10) ||
    (/^[a-z0-9_-]{16,}$/i.test(text) && /\d/.test(text))
  );
}

function sanitizeWorkflowUrl(value) {
  const cleaned = cleanText(value || "", 2000);
  if (!cleaned) return "";
  try {
    const parsed = new URL(cleaned);
    if (!["http:", "https:"].includes(parsed.protocol)) return cleaned;
    const segments = parsed.pathname.split("/").map((segment) => (isLikelyIdentifierSegment(segment) ? ":id" : segment));
    const pathname = segments.join("/");
    return `${parsed.origin}${pathname === "/" ? "" : pathname}`;
  } catch {
    return cleaned;
  }
}

function cleanList(value, { maxItems = 50, maxChars = 1000, lower = false } = {}) {
  if (!Array.isArray(value)) return [];
  const out = [];
  for (const item of value) {
    const cleaned = cleanText(String(item || ""), maxChars);
    if (!cleaned) continue;
    out.push(lower ? cleaned.toLowerCase() : cleaned);
    if (out.length >= maxItems) break;
  }
  return out;
}

function redactPotentialSecrets(text) {
  return String(text || "")
    .replace(
      /\b((?:password|passwd|passcode|token|secret|api[_ -]?key|access[_ -]?token|refresh[_ -]?token|client[_ -]?secret)\b\s*[:=]\s*)(["']?)([^"',;\s]{4,})(\2)/gi,
      (_match, prefix, quote) => `${prefix}${quote}[redacted]${quote}`
    )
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]{12,}\b/g, "Bearer [redacted]")
    .replace(/\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9_]{20,}\b/g, "[redacted]");
}

function workflowId(now = new Date()) {
  const stamp = now.toISOString().replace(/[-:.TZ]/g, "").slice(0, 14);
  return `wm_${stamp}_${crypto.randomUUID().slice(0, 8)}`;
}

function searchText(entry) {
  return [
    entry.id,
    entry.task,
    entry.site,
    entry.domain,
    entry.url,
    entry.title,
    entry.outcome,
    entry.notes,
    ...(entry.tags || []),
    ...(entry.steps || []),
    ...(entry.pitfalls || []),
    ...(entry.selectors || []),
  ]
    .filter(Boolean)
    .join("\n")
    .toLowerCase();
}

function queryTerms(query) {
  return String(query || "")
    .toLowerCase()
    .split(/[^a-z0-9._-]+/)
    .filter((term) => term.length >= 2);
}

function memorySortValue(entry) {
  return isoDate(entry.lastVerified) || isoDate(entry.updatedAt) || isoDate(entry.createdAt) || "";
}

function hasTransientRef(value) {
  if (Array.isArray(value)) return value.some((item) => hasTransientRef(item));
  return TRANSIENT_REF_PATTERN.test(String(value || ""));
}

function rejectTransientRefs(fields) {
  const badFields = Object.entries(fields)
    .filter(([, value]) => hasTransientRef(value))
    .map(([field]) => field);
  if (badFields.length) {
    throw new Error(
      `workflow memory contains transient snapshot refs in ${badFields.join(", ")}. Save visible labels, page names, and stable UI cues instead of [ref=eN] handles.`
    );
  }
}

function staleWarning(lastVerified, now = new Date()) {
  const verified = new Date(lastVerified || "");
  if (Number.isNaN(verified.getTime())) return "";
  const ageDays = Math.floor((now.getTime() - verified.getTime()) / 86400000);
  if (ageDays < 30) return "";
  return `last verified ${ageDays} days ago; verify the live UI before following.`;
}

export class WorkflowMemoryStore {
  constructor({
    filePath = memoryFileFromEnv(),
    now = () => new Date(),
    warn = (message) => process.stderr.write(`${message}\n`),
  } = {}) {
    this.filePath = expandHome(filePath);
    this.now = now;
    this.warn = warn;
    this.warnedInvalidLine = false;
    this.recordsCacheKey = "";
    this.recordsCache = null;
  }

  ensureParent() {
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true, mode: 0o700 });
  }

  append(record) {
    this.ensureParent();
    fs.appendFileSync(this.filePath, `${JSON.stringify(record)}\n`, { mode: 0o600 });
    this.recordsCacheKey = "";
    this.recordsCache = null;
    try {
      fs.chmodSync(this.filePath, 0o600);
    } catch {}
  }

  readRecords() {
    if (!fs.existsSync(this.filePath)) return [];
    const stat = fs.statSync(this.filePath);
    const cacheKey = `${stat.size}:${stat.mtimeMs}`;
    if (this.recordsCache && this.recordsCacheKey === cacheKey) return this.recordsCache.slice();
    const raw = fs.readFileSync(this.filePath, "utf8");
    const records = [];
    for (const line of raw.split("\n")) {
      if (!line.trim()) continue;
      try {
        records.push(JSON.parse(line));
      } catch (e) {
        if (!this.warnedInvalidLine) {
          this.warn(`[uba] WARNING: ignoring invalid workflow memory line in ${this.filePath}: ${e.message}`);
          this.warnedInvalidLine = true;
        }
      }
    }
    this.recordsCacheKey = cacheKey;
    this.recordsCache = records;
    return records.slice();
  }

  list() {
    const workflows = new Map();
    const deleted = new Set();
    const superseded = new Set();

    for (const record of this.readRecords()) {
      if (!record || typeof record !== "object") continue;
      if (record.type === "delete" && record.id) {
        deleted.add(record.id);
        continue;
      }
      if (record.type !== "workflow" || !record.id) continue;
      workflows.set(record.id, record);
      for (const id of Array.isArray(record.supersedes) ? record.supersedes : []) {
        if (id) superseded.add(id);
      }
    }

    return Array.from(workflows.values())
      .filter((entry) => !deleted.has(entry.id) && !superseded.has(entry.id))
      .sort((a, b) => memorySortValue(b).localeCompare(memorySortValue(a)));
  }

  remember(input, context = {}) {
    const now = this.now();
    const activeTab = context.activeTab || {};
    const rawUrl = input.url || activeTab.url || "";
    const url = sanitizeWorkflowUrl(rawUrl);
    const title = cleanText(input.title || activeTab.title || "", 500);
    const site = cleanText(input.site || "", 200);
    const domain = normalizeHostname(input.domain || hostnameFromUrl(rawUrl) || hostnameFromUrl(url) || maybeDomain(site) || hostnameFromUrl(activeTab.url));
    const task = cleanText(input.task || "", 500);
    const steps = cleanList(input.steps, { maxItems: 80, maxChars: 1200 });
    const pitfalls = cleanList(input.pitfalls, { maxItems: 40, maxChars: 1000 });
    const selectors = cleanList(input.selectors, { maxItems: 40, maxChars: 1000 });
    const notes = cleanText(input.notes || "", 3000);
    const outcome = cleanText(input.outcome || "", 1000);

    if (!task) throw new Error("task is required.");
    if (!steps.length) throw new Error("steps must include at least one reusable step.");
    rejectTransientRefs({ task, steps, pitfalls, selectors, notes, outcome });

    const record = {
      type: "workflow",
      id: workflowId(now),
      task,
      site: site || domain || "",
      domain,
      url,
      title,
      tags: cleanList(input.tags, { maxItems: 20, maxChars: 80, lower: true }),
      steps,
      pitfalls,
      selectors,
      notes,
      outcome,
      confidence: ["low", "medium", "high"].includes(input.confidence) ? input.confidence : "medium",
      lastVerified: cleanText(input.lastVerified || now.toISOString().slice(0, 10), 50),
      supersedes: cleanList(input.supersedes, { maxItems: 20, maxChars: 200 }),
      createdAt: now.toISOString(),
      updatedAt: now.toISOString(),
    };

    this.append(record);
    return record;
  }

  forget(id, reason = "") {
    const cleanId = cleanText(id || "", 200);
    if (!cleanId) throw new Error("id is required.");
    const existing = this.list().find((entry) => entry.id === cleanId);
    if (!existing) throw new Error(`workflow memory '${cleanId}' was not found.`);
    const now = this.now();
    this.append({
      type: "delete",
      id: cleanId,
      reason: cleanText(reason || "", 1000),
      deletedAt: now.toISOString(),
    });
    return { id: cleanId, deleted: true };
  }

  search({ query = "", site = "", domain = "", url = "", tags = [], limit = 5 } = {}) {
    const requestedLimit = Math.max(1, Math.min(Number(limit) || 5, 10));
    const normalizedQuery = String(query || "").trim().toLowerCase();
    const terms = queryTerms(normalizedQuery);
    const normalizedSite = String(site || "").trim().toLowerCase();
    const searchDomain = normalizeHostname(domain || hostnameFromUrl(url) || maybeDomain(site));
    const requestedTags = new Set(cleanList(tags, { maxItems: 20, maxChars: 80, lower: true }));
    const hasFilter = Boolean(normalizedQuery || normalizedSite || searchDomain || requestedTags.size);

    const scored = [];
    for (const entry of this.list()) {
      const haystack = searchText(entry);
      let score = 0;

      if (!hasFilter) score += 1;
      if (normalizedQuery) {
        if (entry.id.toLowerCase() === normalizedQuery) score += 100;
        if (haystack.includes(normalizedQuery)) score += 18;
        for (const term of terms) {
          if (haystack.includes(term)) score += 3;
        }
      }
      if (normalizedSite) {
        if (haystack.includes(normalizedSite)) score += 6;
      }
      if (searchDomain) {
        if (entry.domain === searchDomain) score += 24;
        else if (entry.domain && (hostMatchesDomain(entry.domain, searchDomain) || hostMatchesDomain(searchDomain, entry.domain))) {
          score += 12;
        }
        if (entry.url && entry.url.toLowerCase().includes(searchDomain)) score += 4;
      }
      if (requestedTags.size) {
        const entryTags = new Set(entry.tags || []);
        for (const tag of requestedTags) {
          if (entryTags.has(tag)) score += 8;
        }
      }

      if (score > 0) scored.push({ entry, score });
    }

    return scored
      .sort((a, b) => b.score - a.score || memorySortValue(b.entry).localeCompare(memorySortValue(a.entry)))
      .slice(0, requestedLimit)
      .map(({ entry, score }) => ({ ...entry, score }));
  }

  hintsForTab(tab, { limit = 2 } = {}) {
    const domain = hostnameFromUrl(tab?.url);
    if (!domain) return [];
    return this.search({ domain, query: tab?.title || "", limit }).map((entry) => ({
      id: entry.id,
      task: entry.task,
      site: entry.site,
      domain: entry.domain,
      lastVerified: entry.lastVerified,
      confidence: entry.confidence,
      firstSteps: (entry.steps || []).slice(0, 3),
    }));
  }
}

export function formatWorkflowMemories(matches, { query = "", site = "" } = {}) {
  const target = [query && `query "${query}"`, site && `site "${site}"`].filter(Boolean).join(", ");
  if (!matches.length) {
    return `No workflow memories matched${target ? ` for ${target}` : ""}. If you discover a reusable path, call browser_workflow_remember after the task succeeds.`;
  }

  const lines = [`Workflow memories${target ? ` for ${target}` : ""} (${matches.length})`];
  matches.forEach((entry, index) => {
    lines.push("");
    lines.push(`${index + 1}. ${entry.task} [${entry.id}]`);
    if (entry.site || entry.domain) lines.push(`   site: ${[entry.site, entry.domain].filter(Boolean).join(" / ")}`);
    if (entry.url) lines.push(`   url: ${entry.url}`);
    if (entry.title) lines.push(`   page title: ${entry.title}`);
    lines.push(`   last verified: ${entry.lastVerified || "unknown"}; confidence: ${entry.confidence || "medium"}`);
    const warning = staleWarning(entry.lastVerified);
    if (warning) lines.push(`   caution: ${warning}`);
    if (entry.outcome) lines.push(`   outcome: ${entry.outcome}`);
    if (entry.tags?.length) lines.push(`   tags: ${entry.tags.join(", ")}`);
    lines.push("   steps:");
    for (const step of entry.steps || []) lines.push(`   - ${step}`);
    if (entry.pitfalls?.length) {
      lines.push("   pitfalls:");
      for (const pitfall of entry.pitfalls) lines.push(`   - ${pitfall}`);
    }
    if (entry.selectors?.length) {
      lines.push("   durable UI cues:");
      for (const selector of entry.selectors) lines.push(`   - ${selector}`);
    }
    if (entry.notes) lines.push(`   notes: ${entry.notes}`);
    if (entry.supersedes?.length) lines.push(`   supersedes: ${entry.supersedes.join(", ")}`);
  });
  return lines.join("\n");
}
