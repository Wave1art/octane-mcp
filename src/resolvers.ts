import type { OctaneClient, Scope } from "./client.js";
import type { OctaneConfig } from "./config.js";
import type { Entity } from "./format.js";
import { OctaneError } from "./client.js";

export interface FieldMeta {
  name: string;
  label?: string;
  field_type: string; // string | integer | boolean | date_time | memo | reference | float
  editable?: boolean;
  required?: boolean;
  filterable?: boolean;
  sortable?: boolean;
  is_user_defined?: boolean;
  field_type_data?: {
    multiple?: boolean;
    targets?: Array<{ type: string; logical_name?: string }>;
  };
}

export interface Ref { type: string; id: string; name?: string; logical_name?: string }

export class ResolveError extends Error {}

/** Plural REST collection -> entity type name used by metadata and `type`. */
export const RESOURCE_TO_ENTITY: Record<string, string> = {
  defects: "defect", stories: "story", quality_stories: "quality_story", epics: "epic", features: "feature",
  tasks: "task", work_items: "work_item", work_item_roots: "work_item_root", requirements: "requirement",
  requirement_documents: "requirement_document", requirement_folders: "requirement_folder", requirement_roots: "requirement_root",
  tests: "test", manual_tests: "test_manual", gherkin_tests: "test_gherkin", test_suites: "test_suite",
  automated_tests: "test_automated", runs: "run", manual_runs: "run_manual", suite_run: "run_suite", suite_runs: "run_suite",
  automated_runs: "run_automated", run_steps: "run_step", releases: "release", sprints: "sprint", milestones: "milestone",
  teams: "team", team_sprints: "team_sprint", phases: "phase", metaphases: "metaphase", transitions: "transition",
  list_nodes: "list_node", workspace_users: "workspace_user", users: "user", comments: "comment", attachments: "attachment",
  application_modules: "application_module", product_areas: "product_area", user_tags: "user_tag", taxonomy_nodes: "taxonomy_node",
  taxonomy_category_nodes: "taxonomy_category_node", taxonomy_item_nodes: "taxonomy_item_node", ci_builds: "ci_build",
  scm_commits: "scm_commit", pipelines: "pipeline", pipeline_runs: "pipeline_run", ci_servers: "ci_server",
  test_suite_link_to_tests: "test_suite_link_to_test", history_records: "history_record", audits: "audit",
};

/** Work item / test subtypes -> the collection to write them through. */
export const ENTITY_TO_RESOURCE: Record<string, string> = Object.fromEntries(
  Object.entries(RESOURCE_TO_ENTITY).map(([r, e]) => [e, r]),
);
ENTITY_TO_RESOURCE.run_suite = "suite_run";

export function entityNameFor(resource: string): string {
  if (RESOURCE_TO_ENTITY[resource]) return RESOURCE_TO_ENTITY[resource];
  if (resource.endsWith("ies")) return resource.slice(0, -3) + "y";
  if (resource.endsWith("s")) return resource.slice(0, -1);
  return resource;
}

export function resourceFor(entityType: string): string {
  return ENTITY_TO_RESOURCE[entityType] ?? (entityType.endsWith("y") ? entityType.slice(0, -1) + "ies" : entityType + "s");
}

/** Which entity's phases apply to a work item / test subtype. */
export function phaseEntityFor(subtype: string): string {
  return subtype;
}

function norm(s: string): string {
  return s.trim().toLowerCase();
}

function caret(v: string): string {
  return "^" + v.replace(/\\/g, "\\\\").replace(/\^/g, "\\^") + "^";
}

/**
 * Turns the names humans and LLMs use (phase "Fixed", severity "High",
 * owner "jane@x.com", release "R26.3") into the {type,id} references Octane
 * requires. Metadata and lookups are cached per workspace for the process
 * lifetime; Octane admin data changes rarely.
 */
export class Resolvers {
  private readonly fieldCache = new Map<string, Promise<FieldMeta[]>>();
  private readonly lookupCache = new Map<string, Promise<Entity[]>>();
  private currentUserPromise: Promise<Ref | null> | null = null;

  constructor(private readonly client: OctaneClient, private readonly cfg: OctaneConfig) {}

  private key(scope: Scope | undefined, ...parts: string[]): string {
    const s = this.client.scope(scope);
    return [s.sharedSpaceId, s.workspaceId, ...parts].join("/");
  }

  // ----- metadata -----------------------------------------------------------

  fields(entity: string, scope?: Scope): Promise<FieldMeta[]> {
    const k = this.key(scope, "fields", entity);
    let p = this.fieldCache.get(k);
    if (!p) {
      p = this.client.metadataFields(entity, scope).then((r) => r.data as unknown as FieldMeta[]);
      p.catch(() => this.fieldCache.delete(k));
      this.fieldCache.set(k, p);
    }
    return p;
  }

  async field(entity: string, name: string, scope?: Scope): Promise<FieldMeta | undefined> {
    const fields = await this.fields(entity, scope);
    return fields.find((f) => f.name === name);
  }

  async referenceFields(entity: string, scope?: Scope): Promise<Set<string>> {
    try {
      const fields = await this.fields(entity, scope);
      return new Set(fields.filter((f) => f.field_type === "reference").map((f) => f.name));
    } catch {
      return new Set();
    }
  }

  /** Apply OCTANE_UDF_ALIASES. */
  fieldName(name: string): string {
    return this.cfg.udfAliases[name] ?? name;
  }

  // ----- generic lookups ----------------------------------------------------

  private cachedList(resource: string, query: string, fields: string[], scope?: Scope): Promise<Entity[]> {
    const k = this.key(scope, resource, query, fields.join(","));
    let p = this.lookupCache.get(k);
    if (!p) {
      p = this.client.listAll(resource, { query, fields, scope, max: 2000 }).then((r) => r.data);
      p.catch(() => this.lookupCache.delete(k));
      this.lookupCache.set(k, p);
    }
    return p;
  }

  private pickUnique(candidates: Entity[], label: string, input: string, nameOf: (e: Entity) => string[]): Entity {
    const n = norm(input);
    const exact = candidates.filter((e) => nameOf(e).some((v) => norm(v) === n));
    if (exact.length === 1) return exact[0];
    if (exact.length > 1) {
      throw new ResolveError(`${label} "${input}" is ambiguous: ${exact.map((e) => `${e.name ?? e.full_name} (id ${e.id})`).join(", ")}. Use the id instead.`);
    }
    const partial = candidates.filter((e) => nameOf(e).some((v) => norm(v).includes(n)));
    if (partial.length === 1) return partial[0];
    if (partial.length > 1) {
      throw new ResolveError(`${label} "${input}" matches several: ${partial.slice(0, 10).map((e) => `${e.name ?? e.full_name} (id ${e.id})`).join(", ")}. Be more specific or use the id.`);
    }
    const sample = candidates.slice(0, 15).map((e) => String(e.name ?? e.full_name ?? e.logical_name)).join(", ");
    throw new ResolveError(`${label} "${input}" not found.${sample ? ` Known values: ${sample}` : ""}`);
  }

  /** Resolve a release/sprint/team/milestone/application module/etc. by id or name. */
  async byName(resource: string, input: string | number, scope?: Scope, extraQuery?: string): Promise<Ref> {
    const type = entityNameFor(resource);
    const s = String(input).trim();
    if (/^\d+$/.test(s)) return { type, id: s };
    const all = await this.cachedList(resource, extraQuery ?? "", ["id", "name"], scope);
    const e = this.pickUnique(all, type, s, (x) => [String(x.name ?? "")]);
    return { type, id: String(e.id), name: String(e.name) };
  }

  async user(input: string | number, scope?: Scope): Promise<Ref> {
    const s = String(input).trim();
    if (/^\d+$/.test(s)) return { type: "workspace_user", id: s };
    if (["me", "@me", "[current_user]", "current_user"].includes(norm(s))) {
      const me = await this.currentUser(scope);
      if (!me) throw new ResolveError("Cannot resolve 'me': set OCTANE_CURRENT_USER to your email or full name.");
      return me;
    }
    const users = await this.cachedList("workspace_users", "", ["id", "name", "full_name", "email", "first_name", "last_name"], scope);
    const e = this.pickUnique(users, "user", s, (u) => [String(u.email ?? ""), String(u.full_name ?? ""), String(u.name ?? ""), `${u.first_name ?? ""} ${u.last_name ?? ""}`]);
    return { type: "workspace_user", id: String(e.id), name: String(e.full_name ?? e.name) };
  }

  async currentUser(scope?: Scope): Promise<Ref | null> {
    if (!this.currentUserPromise) {
      this.currentUserPromise = (async () => {
        const me = await this.client.currentUser();
        if (me?.id) return { type: "workspace_user", id: String(me.id), name: String(me.full_name ?? me.name ?? me.email ?? "") };
        const hint = this.cfg.currentUser ?? (this.cfg.auth.kind === "password" ? this.cfg.auth.username : undefined);
        if (!hint) return null;
        try {
          return await this.user(hint, scope);
        } catch {
          return null;
        }
      })();
    }
    return this.currentUserPromise;
  }

  // ----- phases & list nodes -----------------------------------------------

  async phases(entity: string, scope?: Scope): Promise<Entity[]> {
    return this.cachedList("phases", `entity EQ ${caret(entity)}`, ["id", "name", "logical_name", "entity", "is_initial"], scope);
  }

  /** `entity` is the subtype whose workflow applies: defect, story, feature, epic, test_manual, requirement... */
  async phase(entity: string, input: string | number, scope?: Scope): Promise<Ref> {
    const s = String(input).trim();
    if (/^\d+$/.test(s)) return { type: "phase", id: s };
    const all = await this.phases(entity, scope);
    const e = this.pickUnique(all, `${entity} phase`, s, (p) => {
      const ln = String(p.logical_name ?? "");
      return [String(p.name ?? ""), ln, ln.split(".").pop() ?? ""];
    });
    return { type: "phase", id: String(e.id), name: String(e.name), logical_name: String(e.logical_name) };
  }

  /** List nodes under a list root, e.g. root "severity" -> list_node.severity.* */
  async listNodes(root: string, scope?: Scope): Promise<Entity[]> {
    const logical = root.startsWith("list_node.") ? root : `list_node.${root}`;
    return this.cachedList("list_nodes", `logical_name EQ ${caret(logical + ".*")}`, ["id", "name", "logical_name", "list_root"], scope);
  }

  async listNode(root: string, input: string | number, scope?: Scope): Promise<Ref> {
    const s = String(input).trim();
    if (/^\d+$/.test(s)) return { type: "list_node", id: s };
    const nodes = await this.listNodes(root, scope);
    const e = this.pickUnique(nodes, `${root} value`, s, (n) => {
      const ln = String(n.logical_name ?? "");
      return [String(n.name ?? ""), ln, ln.split(".").pop() ?? ""];
    });
    return { type: "list_node", id: String(e.id), name: String(e.name), logical_name: String(e.logical_name) };
  }

  /** Resolve a list-typed field's value using the field metadata to find its list root. */
  async listValueForField(entity: string, fieldName: string, input: string | number, scope?: Scope): Promise<Ref> {
    const s = String(input).trim();
    if (/^\d+$/.test(s)) return { type: "list_node", id: s };
    const meta = await this.field(entity, fieldName, scope);
    const target = meta?.field_type_data?.targets?.find((t) => t.type === "list_node");
    const root = target?.logical_name ?? `list_node.${fieldName}`;
    return this.listNode(root, s, scope);
  }

  // ----- work items ---------------------------------------------------------

  async workItem(id: string, scope?: Scope): Promise<Entity> {
    const e = await this.client.get("work_items", id, ["id", "name", "subtype", "phase", "parent"], scope);
    if (!e) throw new ResolveError(`Work item ${id} not found in workspace ${this.client.scope(scope).workspaceId}.`);
    return e;
  }

  /** A parent reference carries the real subtype (feature/epic/work_item_root). */
  async parentRef(input: string | number, scope?: Scope): Promise<Ref> {
    const s = String(input).trim();
    if (/^\d+$/.test(s)) {
      const wi = await this.workItem(s, scope);
      return { type: String(wi.subtype ?? "work_item"), id: s, name: String(wi.name ?? "") };
    }
    const items = await this.client.list("work_items", { query: `name EQ ${caret(s)}`, fields: ["id", "name", "subtype"], limit: 20, scope });
    const e = this.pickUnique(items.data, "parent work item", s, (x) => [String(x.name ?? "")]);
    return { type: String(e.subtype ?? "work_item"), id: String(e.id), name: String(e.name) };
  }

  async test(input: string | number, scope?: Scope): Promise<Ref> {
    const s = String(input).trim();
    if (/^\d+$/.test(s)) {
      const t = await this.client.get("tests", s, ["id", "name", "subtype"], scope);
      if (!t) throw new ResolveError(`Test ${s} not found.`);
      return { type: String(t.subtype ?? "test"), id: s, name: String(t.name ?? "") };
    }
    const r = await this.client.list("tests", { query: `name EQ ${caret(s)}`, fields: ["id", "name", "subtype"], limit: 20, scope });
    const e = this.pickUnique(r.data, "test", s, (x) => [String(x.name ?? "")]);
    return { type: String(e.subtype ?? "test"), id: String(e.id), name: String(e.name) };
  }

  // ----- payload normalisation ---------------------------------------------

  /**
   * Make a create/update payload Octane-ready:
   *  - apply UDF aliases
   *  - turn plain strings/numbers on reference fields into {type,id} by name lookup
   *  - leave already-shaped references and non-reference values alone
   */
  async normalizePayload(entity: string, data: Record<string, unknown>, scope?: Scope): Promise<Record<string, unknown>> {
    let fields: FieldMeta[] = [];
    try {
      fields = await this.fields(entity, scope);
    } catch {
      /* metadata unavailable: pass through */
    }
    const byName = new Map(fields.map((f) => [f.name, f]));
    const out: Record<string, unknown> = {};
    for (const [rawKey, value] of Object.entries(data)) {
      const key = this.fieldName(rawKey);
      if (value === undefined) continue;
      const meta = byName.get(key);
      if (!meta || meta.field_type !== "reference" || value === null || typeof value === "object") {
        out[key] = value;
        continue;
      }
      out[key] = await this.referenceValue(entity, key, meta, value as string | number, scope);
    }
    return out;
  }

  async referenceValue(entity: string, key: string, meta: FieldMeta, value: string | number, scope?: Scope): Promise<unknown> {
    const multiple = meta.field_type_data?.multiple ?? false;
    const targets = meta.field_type_data?.targets ?? [];
    const values = multiple && typeof value === "string" ? value.split(",").map((v) => v.trim()).filter(Boolean) : [value];
    const refs: Ref[] = [];
    for (const v of values) refs.push(await this.singleReference(entity, key, targets, v, scope));
    return multiple ? { data: refs.map(({ type, id }) => ({ type, id })) } : { type: refs[0].type, id: refs[0].id };
  }

  private async singleReference(entity: string, key: string, targets: Array<{ type: string; logical_name?: string }>, v: string | number, scope?: Scope): Promise<Ref> {
    const types = targets.map((t) => t.type);
    const s = String(v);
    if (types.includes("list_node")) return this.listNode(targets.find((t) => t.type === "list_node")?.logical_name ?? key, s, scope);
    if (types.includes("phase")) return this.phase(entity, s, scope);
    if (types.includes("workspace_user")) return this.user(s, scope);
    if (key === "parent" || types.some((t) => ["work_item_root", "epic", "feature", "work_item"].includes(t))) {
      if (types.length === 1 && /^\d+$/.test(s)) return { type: types[0], id: s };
      return this.parentRef(s, scope);
    }
    if (types.some((t) => t.startsWith("test"))) return this.test(s, scope);
    if (types.length === 1) {
      const type = types[0];
      if (/^\d+$/.test(s)) return { type, id: s };
      return this.byName(resourceFor(type), s, scope);
    }
    if (/^\d+$/.test(s)) return { type: types[0] ?? "work_item", id: s };
    throw new ResolveError(`Cannot resolve "${s}" for field ${key}: give an id, or an object like {"type":"${types[0] ?? "..."}","id":"..."}.`);
  }

  /** Map a thrown resolver/Octane error into an actionable message. */
  static explain(e: unknown): string {
    if (e instanceof ResolveError) return e.message;
    if (e instanceof OctaneError) {
      let msg = e.message;
      if (e.status === 400 && /field|property|unknown|not exist|invalid/i.test(msg)) {
        msg += " Hint: call octane_describe with this entity to see the valid field names.";
      }
      if (e.status === 403) msg += " Hint: the API key may lack permission for this workspace or operation.";
      return msg;
    }
    return e instanceof Error ? e.message : String(e);
  }
}
