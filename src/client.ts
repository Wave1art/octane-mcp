import type { Dispatcher } from "undici";
import { fetch as undiciFetch, FormData } from "undici";
import type { Response as UResponse, BodyInit as UBodyInit } from "undici";
import type { OctaneConfig } from "./config.js";
import type { Entity } from "./format.js";

export interface Scope {
  sharedSpaceId?: string;
  workspaceId?: string;
}

export interface ListOptions {
  fields?: string[];
  /** Already-translated OQL, without outer quotes. */
  query?: string;
  orderBy?: string;
  limit?: number;
  offset?: number;
  scope?: Scope;
  /** "*" or comma-separated workspace ids, see Octane cross_workspace clause. */
  crossWorkspace?: string;
}

export interface ListResult<T = Entity> {
  total_count: number;
  data: T[];
  exceeds_total_count?: boolean;
}

export interface RequestOptions {
  params?: Record<string, string | number | undefined>;
  json?: unknown;
  body?: UBodyInit;
  headers?: Record<string, string>;
  /** Skip the Octane `errors` array check (used for raw/binary responses). */
  raw?: boolean;
}

export class OctaneError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly method: string,
    public readonly path: string,
    public readonly body: unknown,
  ) {
    super(message);
    this.name = "OctaneError";
  }
}

export interface AttachmentUpload {
  name: string;
  content: Uint8Array;
  contentType?: string;
  /** e.g. { field: "owner_work_item", type: "work_item", id: "1001" } */
  owner: { field: string; type: string; id: string };
  description?: string;
}

type FetchFn = typeof undiciFetch;

const PAGE_SIZE = 200;

function describeError(status: number, body: unknown): string {
  if (body && typeof body === "object") {
    const b = body as Record<string, unknown>;
    const parts: string[] = [];
    for (const key of ["description_translated", "description", "message", "error_code"]) {
      if (typeof b[key] === "string") parts.push(String(b[key]));
    }
    if (parts.length) return `${status}: ${parts.join(" | ")}`;
    if (Array.isArray(b.errors)) {
      const inner = (b.errors as unknown[]).map((e) => describeError(status, e)).join("; ");
      return inner;
    }
  }
  if (typeof body === "string" && body.trim()) return `${status}: ${body.slice(0, 500)}`;
  return `HTTP ${status}`;
}

/**
 * Low-level ALM Octane REST client.
 *
 * Auth: POST /authentication/sign_in, then replay every cookie the server set
 * (Octane rotates LWSSO_COOKIE_KEY to extend the session). A 401 triggers one
 * re-sign-in and retry.
 */
export class OctaneClient {
  private readonly cookies = new Map<string, string>();
  private signedIn = false;
  private signingIn: Promise<void> | null = null;
  private readonly fetchFn: FetchFn;
  private readonly dispatcher: Dispatcher | undefined;

  constructor(
    public readonly cfg: OctaneConfig,
    deps: { fetch?: FetchFn; dispatcher?: Dispatcher } = {},
  ) {
    this.fetchFn = deps.fetch ?? undiciFetch;
    this.dispatcher = deps.dispatcher;
  }

  // ----- paths --------------------------------------------------------------

  scope(s?: Scope): Required<Scope> {
    return {
      sharedSpaceId: s?.sharedSpaceId || this.cfg.sharedSpaceId,
      workspaceId: s?.workspaceId || this.cfg.workspaceId,
    };
  }

  wsPath(resource: string, s?: Scope): string {
    const { sharedSpaceId, workspaceId } = this.scope(s);
    return `/api/shared_spaces/${sharedSpaceId}/workspaces/${workspaceId}/${resource}`;
  }

  ssPath(resource: string, s?: Scope): string {
    return `/api/shared_spaces/${this.scope(s).sharedSpaceId}/${resource}`;
  }

  // ----- auth ---------------------------------------------------------------

  private async signIn(): Promise<void> {
    if (this.signingIn) return this.signingIn;
    this.signingIn = (async () => {
      const a = this.cfg.auth;
      const payload = a.kind === "apikey"
        ? { client_id: a.clientId, client_secret: a.clientSecret }
        : { user: a.username, password: a.password };
      this.cookies.clear();
      const res = await this.rawFetch("POST", "/authentication/sign_in", {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify(payload),
      });
      this.absorbCookies(res);
      if (!res.ok) {
        const body = await res.text();
        throw new OctaneError(
          `Octane sign-in failed (${describeError(res.status, safeJson(body))}). Check OCTANE_BASE_URL and credentials.`,
          res.status, "POST", "/authentication/sign_in", body,
        );
      }
      if (!this.cookies.has("LWSSO_COOKIE_KEY")) {
        throw new OctaneError("Octane sign-in returned no LWSSO_COOKIE_KEY cookie", res.status, "POST", "/authentication/sign_in", null);
      }
      this.signedIn = true;
    })();
    try {
      await this.signingIn;
    } finally {
      this.signingIn = null;
    }
  }

  async signOut(): Promise<void> {
    if (!this.signedIn) return;
    try {
      await this.fetchFn(`${this.cfg.baseUrl}/authentication/sign_out`, {
        method: "POST",
        headers: this.baseHeaders(),
        dispatcher: this.dispatcher,
      } as never);
    } catch {
      /* best effort */
    }
    this.cookies.clear();
    this.signedIn = false;
  }

  private absorbCookies(res: UResponse): void {
    const headers = res.headers as unknown as { getSetCookie?: () => string[] };
    const setCookies = headers.getSetCookie ? headers.getSetCookie() : [];
    for (const sc of setCookies) {
      const [pair] = sc.split(";");
      const eq = pair.indexOf("=");
      if (eq > 0) this.cookies.set(pair.slice(0, eq).trim(), pair.slice(eq + 1).trim());
    }
  }

  private baseHeaders(): Record<string, string> {
    const h: Record<string, string> = {
      Accept: "application/json",
      "Accept-Encoding": "gzip",
      HPECLIENTTYPE: "HPE_MQM_UI",
    };
    if (this.cfg.techPreview) h["ALM-OCTANE-TECH-PREVIEW"] = "true";
    if (this.cookies.size) {
      h.Cookie = [...this.cookies].map(([k, v]) => `${k}=${v}`).join("; ");
    }
    const csrf = this.cookies.get("HPSSO_COOKIE_CSRF");
    if (csrf) h["HPSSO-HEADER-CSRF"] = csrf;
    return h;
  }

  // ----- core request -------------------------------------------------------

  async request<T = unknown>(method: string, path: string, opts: RequestOptions = {}): Promise<T> {
    if (!this.signedIn) await this.signIn();
    let res = await this.send(method, path, opts);
    if (res.status === 401) {
      this.signedIn = false;
      await this.signIn();
      res = await this.send(method, path, opts);
    }
    this.absorbCookies(res);

    if (res.status === 404 && method === "GET") return null as T;
    if (res.status === 204) return { status: "ok" } as T;

    const contentType = res.headers.get("content-type") ?? "";
    if (opts.raw) {
      if (!res.ok) {
        const text = await res.text();
        throw new OctaneError(`Octane ${method} ${path} failed: ${describeError(res.status, safeJson(text))}`, res.status, method, path, text);
      }
      return res as unknown as T;
    }

    const text = await res.text();
    const body = contentType.includes("json") ? safeJson(text) : text;
    if (!res.ok) {
      throw new OctaneError(`Octane ${method} ${path} failed: ${describeError(res.status, body)}`, res.status, method, path, body);
    }
    // 200/207 with per-entity errors means a partial failure, not success.
    if (body && typeof body === "object" && Array.isArray((body as { errors?: unknown }).errors) && (body as { errors: unknown[] }).errors.length) {
      throw new OctaneError(`Octane ${method} ${path} reported errors: ${describeError(res.status, body)}`, 207, method, path, body);
    }
    return (text ? body : { status: "ok" }) as T;
  }

  private async send(method: string, path: string, opts: RequestOptions): Promise<UResponse> {
    const url = new URL(this.cfg.baseUrl + path);
    for (const [k, v] of Object.entries(opts.params ?? {})) {
      if (v !== undefined && v !== "") url.searchParams.set(k, String(v));
    }
    const headers = { ...this.baseHeaders(), ...(opts.headers ?? {}) };
    let body: UBodyInit | undefined = opts.body;
    if (opts.json !== undefined) {
      headers["Content-Type"] = "application/json";
      body = JSON.stringify(opts.json);
    }
    return this.rawFetch(method, path, { method, headers, body }, url);
  }

  /** fetch with timeout and network-level error translation (TLS, DNS, proxy, timeout). */
  private async rawFetch(method: string, path: string, init: { method: string; headers: Record<string, string>; body?: UBodyInit }, url?: URL): Promise<UResponse> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.cfg.timeoutMs);
    try {
      return (await this.fetchFn(url ?? `${this.cfg.baseUrl}${path}`, {
        ...init,
        dispatcher: this.dispatcher,
        signal: controller.signal,
      } as never)) as unknown as UResponse;
    } catch (e) {
      const err = e as Error & { cause?: Error & { code?: string } };
      const code = err.cause?.code ?? "";
      const detail = err.cause?.message ? ` (${code ? code + ": " : ""}${err.cause.message})` : "";
      let hint = "";
      if (/CERT|certificate|self.signed|UNABLE_TO_VERIFY|altname/i.test(code + detail)) {
        hint = " TLS verification failed: set OCTANE_CA_CERT to your CA bundle, or OCTANE_VERIFY_SSL=false for internal servers.";
      } else if (err.name === "AbortError" || /timeout/i.test(code)) {
        hint = ` Timed out after ${this.cfg.timeoutMs}ms (OCTANE_TIMEOUT_MS).`;
      } else if (/ENOTFOUND|EAI_AGAIN/.test(code)) {
        hint = " Host not found: check OCTANE_BASE_URL (and HTTPS_PROXY if you need a proxy).";
      } else if (/ECONNREFUSED/.test(code)) {
        hint = " Connection refused: check the port in OCTANE_BASE_URL and that the server is reachable from this machine.";
      }
      throw new OctaneError(`Octane ${method} ${path}: ${err.message}${detail}.${hint}`, 0, method, path, null);
    } finally {
      clearTimeout(timer);
    }
  }

  // ----- collections --------------------------------------------------------

  async listPath(path: string, o: ListOptions = {}): Promise<ListResult> {
    const params: Record<string, string | number | undefined> = {
      limit: o.limit ?? 50,
      offset: o.offset ?? 0,
    };
    if (o.fields?.length) params.fields = o.fields.join(",");
    if (o.query) params.query = `"${o.query}"`;
    if (o.orderBy) params.order_by = o.orderBy;
    if (o.crossWorkspace) params.cross_workspace = o.crossWorkspace;
    const res = await this.request<ListResult | null>("GET", path, { params });
    if (!res) throw new OctaneError(`Collection not found: ${path}. Check the resource name (plural, e.g. "defects").`, 404, "GET", path, null);
    return { total_count: res.total_count ?? res.data?.length ?? 0, data: res.data ?? [], exceeds_total_count: res.exceeds_total_count };
  }

  list(resource: string, o: ListOptions = {}): Promise<ListResult> {
    return this.listPath(this.wsPath(resource, o.scope), o);
  }

  /** Page through a collection up to `max` entities. */
  async listAll(resource: string, o: ListOptions & { max?: number } = {}): Promise<ListResult> {
    const max = o.max ?? 2000;
    const all: Entity[] = [];
    let offset = o.offset ?? 0;
    let total = 0;
    while (all.length < max) {
      const page = await this.list(resource, { ...o, limit: Math.min(PAGE_SIZE, max - all.length), offset });
      total = page.total_count;
      all.push(...page.data);
      offset += page.data.length;
      if (page.data.length === 0 || offset >= total) break;
    }
    return { total_count: total, data: all, exceeds_total_count: all.length < total };
  }

  async get(resource: string, id: string, fields?: string[], scope?: Scope): Promise<Entity | null> {
    const params: Record<string, string | undefined> = {};
    if (fields?.length) params.fields = fields.join(",");
    return this.request<Entity | null>("GET", `${this.wsPath(resource, scope)}/${encodeURIComponent(id)}`, { params });
  }

  async create(resource: string, data: Record<string, unknown> | Record<string, unknown>[], scope?: Scope): Promise<Entity[]> {
    const items = Array.isArray(data) ? data : [data];
    const res = await this.request<{ data?: Entity[]; total_count?: number }>("POST", this.wsPath(resource, scope), { json: { data: items } });
    return res?.data ?? [];
  }

  async update(resource: string, id: string, data: Record<string, unknown>, scope?: Scope): Promise<Entity> {
    return this.request<Entity>("PUT", `${this.wsPath(resource, scope)}/${encodeURIComponent(id)}`, { json: data });
  }

  /** Bulk update: every item needs an `id`. Octane default max is 2000 per call. */
  async bulkUpdate(resource: string, items: Array<Record<string, unknown> & { id: string }>, scope?: Scope): Promise<Entity[]> {
    if (!items.length) return [];
    const res = await this.request<{ data?: Entity[] }>("PUT", this.wsPath(resource, scope), { json: { data: items } });
    return res?.data ?? [];
  }

  async delete(resource: string, id: string, scope?: Scope): Promise<void> {
    await this.request("DELETE", `${this.wsPath(resource, scope)}/${encodeURIComponent(id)}`);
  }

  async bulkDelete(resource: string, ids: string[], scope?: Scope): Promise<void> {
    if (!ids.length) return;
    await this.request("DELETE", this.wsPath(resource, scope), { params: { query: `"id IN ${ids.join(",")}"` } });
  }

  // ----- tests & runs -------------------------------------------------------

  async getScript(testId: string, scope?: Scope): Promise<{ script: string; creation_time?: string; last_modified?: string } | null> {
    return this.request("GET", `${this.wsPath("tests", scope)}/${encodeURIComponent(testId)}/script`);
  }

  async putScript(testId: string, body: { script: string; comment?: string; revision_type?: "Major" | "Minor" }, scope?: Scope): Promise<unknown> {
    return this.request("PUT", `${this.wsPath("tests", scope)}/${encodeURIComponent(testId)}/script`, {
      json: { script: body.script, comment: body.comment ?? "", revision_type: body.revision_type ?? "Minor" },
    });
  }

  /** Materialise the run steps of a planned manual run without executing it. */
  async generateRunSteps(runId: string, scope?: Scope): Promise<unknown> {
    return this.request("PUT", `${this.wsPath("runs", scope)}/${encodeURIComponent(runId)}/steps`, { json: {} });
  }

  // ----- attachments --------------------------------------------------------

  async uploadAttachment(a: AttachmentUpload, scope?: Scope): Promise<Entity[]> {
    const entity: Record<string, unknown> = { name: a.name, [a.owner.field]: { type: a.owner.type, id: a.owner.id } };
    if (a.description) entity.description = a.description;
    const form = new FormData();
    form.append("entity", new Blob([JSON.stringify(entity)], { type: "application/json" }));
    form.append("content", new Blob([a.content], { type: a.contentType ?? "application/octet-stream" }), a.name);
    const res = await this.request<{ data?: Entity[] }>("POST", this.wsPath("attachments", scope), { body: form as unknown as UBodyInit });
    return res?.data ?? [];
  }

  async downloadAttachment(id: string, scope?: Scope): Promise<{ bytes: Uint8Array; contentType: string }> {
    const res = await this.request<UResponse>("GET", `${this.wsPath("attachments", scope)}/${encodeURIComponent(id)}/content`, {
      raw: true,
      headers: { Accept: "*/*" },
    });
    if (!res) throw new OctaneError(`Attachment ${id} not found`, 404, "GET", "attachments", null);
    return { bytes: new Uint8Array(await res.arrayBuffer()), contentType: res.headers.get("content-type") ?? "application/octet-stream" };
  }

  // ----- metadata & discovery ----------------------------------------------

  metadataEntities(name?: string, scope?: Scope): Promise<ListResult> {
    return this.listPath(this.wsPath("metadata/entities", scope), { limit: 500, query: name ? `name EQ ^${name}^` : undefined });
  }

  metadataFields(entityName: string, scope?: Scope): Promise<ListResult> {
    return this.listPath(this.wsPath("metadata/fields", scope), { limit: 1000, query: `entity_name EQ ^${entityName}^` });
  }

  listWorkspaces(scope?: Scope, o: ListOptions = {}): Promise<ListResult> {
    return this.listPath(this.ssPath("workspaces", scope), { fields: ["id", "name", "description"], limit: 200, ...o });
  }

  listSharedSpaces(o: ListOptions = {}): Promise<ListResult> {
    return this.listPath("/api/shared_spaces", { fields: ["id", "name"], limit: 200, ...o });
  }

  /** The signed-in user, if the instance exposes /api/current_user. */
  async currentUser(): Promise<Entity | null> {
    try {
      return await this.request<Entity | null>("GET", "/api/current_user");
    } catch {
      return null;
    }
  }
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}
