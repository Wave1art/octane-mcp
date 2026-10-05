/**
 * Response shaping. Octane entities carry a lot of structural noise
 * (workspace_id on every object, {type,id,name,...} on every reference,
 * HTML in every memo). Compacting them keeps tool output small.
 */

export type Json = null | boolean | number | string | Json[] | { [k: string]: Json };
export type Entity = { [k: string]: unknown } & { id?: string; type?: string };

export interface FormatOptions {
  /** "text" converts HTML memo fields to plain text (default). "html" leaves them. */
  html?: "text" | "html";
  /** Return the raw Octane payload untouched. */
  raw?: boolean;
}

const MEMO_FIELDS = new Set([
  "description", "steps_to_reproduce", "text", "comment", "script", "acceptance_criteria",
  "expected_result", "actual_result", "notes", "summary",
]);

const DROP_FIELDS = new Set(["workspace_id", "client_lock_stamp"]);

const ENTITY_DECODE: Record<string, string> = {
  "&amp;": "&", "&lt;": "<", "&gt;": ">", "&quot;": '"', "&#39;": "'", "&apos;": "'", "&nbsp;": " ",
};

export function htmlToText(html: string): string {
  if (!/<[a-z!/]/i.test(html)) return decode(html).trim();
  let s = html;
  s = s.replace(/<\s*(script|style)[^>]*>[\s\S]*?<\s*\/\s*\1\s*>/gi, "");
  s = s.replace(/<\s*br\s*\/?>/gi, "\n");
  s = s.replace(/<\s*\/\s*(p|div|li|tr|h[1-6]|blockquote|pre)\s*>/gi, "\n");
  s = s.replace(/<\s*li[^>]*>/gi, "- ");
  s = s.replace(/<\s*\/\s*t[dh]\s*>/gi, "\t");
  s = s.replace(/<[^>]+>/g, "");
  s = decode(s);
  s = s.replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n");
  return s.trim();
}

function decode(s: string): string {
  return s
    .replace(/&(amp|lt|gt|quot|#39|apos|nbsp);/g, (m) => ENTITY_DECODE[m] ?? m)
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)));
}

function isRef(v: unknown): v is Entity {
  return typeof v === "object" && v !== null && !Array.isArray(v) && "type" in v && "id" in v;
}

function isRefList(v: unknown): v is { total_count?: number; data: Entity[] } {
  return typeof v === "object" && v !== null && Array.isArray((v as { data?: unknown }).data) && "total_count" in v;
}

function compactRef(r: Entity): Json {
  const out: { [k: string]: Json } = { id: String(r.id) };
  if (typeof r.name === "string") out.name = r.name;
  if (typeof r.logical_name === "string") out.logical_name = r.logical_name;
  if (typeof r.subtype === "string") out.type = r.subtype;
  else if (typeof r.type === "string" && !["list_node", "phase", "workspace_user", "release", "sprint", "team", "milestone"].includes(r.type)) out.type = r.type;
  if (typeof r.email === "string") out.email = r.email;
  if (typeof r.full_name === "string" && !out.name) out.name = r.full_name;
  return out;
}

export function compactEntity(e: Entity, opts: FormatOptions = {}): Json {
  if (opts.raw) return e as Json;
  const out: { [k: string]: Json } = {};
  for (const [k, v] of Object.entries(e)) {
    if (DROP_FIELDS.has(k)) continue;
    if (v === null || v === undefined) continue;
    if (k === "type" && typeof e.subtype === "string") continue; // subtype is the useful one
    if (k === "subtype" && typeof v === "string") { out.type = v; continue; }
    if (isRefList(v)) { out[k] = v.data.map(compactRef); continue; }
    if (isRef(v)) { out[k] = compactRef(v); continue; }
    if (typeof v === "string" && (opts.html ?? "text") === "text" && (MEMO_FIELDS.has(k) || k.endsWith("_udf"))) {
      out[k] = htmlToText(v);
      continue;
    }
    out[k] = v as Json;
  }
  return out;
}

export interface ListLike { total_count?: number; data: Entity[]; exceeds_total_count?: boolean }

export function compactList(r: ListLike, opts: FormatOptions = {}): Json {
  if (opts.raw) return r as unknown as Json;
  const out: { [k: string]: Json } = {
    total_count: r.total_count ?? r.data.length,
    returned: r.data.length,
    data: r.data.map((e) => compactEntity(e, opts)),
  };
  if (r.exceeds_total_count) out.exceeds_total_count = true;
  return out;
}

export function toText(value: unknown): string {
  return typeof value === "string" ? value : JSON.stringify(value, null, 2);
}
