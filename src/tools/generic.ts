import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { compactEntity, compactList, type Entity } from "../format.js";
import { entityNameFor, resourceFor, type FieldMeta } from "../resolvers.js";
import { buildQuery, defineTool, FIELDS_HELP, formatShape, QUERY_HELP, scopeOf, scopeShape, type Ctx } from "./shared.js";

/** Default fields per collection: enough to recognise an item, not its whole body. */
export const DEFAULT_FIELDS: Record<string, string[]> = {
  defects: ["id", "name", "phase", "severity", "priority", "owner", "detected_by", "release", "sprint", "parent", "creation_time", "last_modified"],
  stories: ["id", "name", "phase", "story_points", "owner", "release", "sprint", "parent", "creation_time", "last_modified"],
  quality_stories: ["id", "name", "phase", "story_points", "owner", "release", "sprint", "parent", "last_modified"],
  features: ["id", "name", "phase", "owner", "release", "milestone", "team", "parent", "story_points", "last_modified"],
  epics: ["id", "name", "phase", "owner", "parent", "last_modified"],
  work_items: ["id", "name", "subtype", "phase", "owner", "release", "sprint", "parent", "last_modified"],
  tasks: ["id", "name", "phase", "owner", "story", "estimated_hours", "remaining_hours", "invested_hours"],
  requirements: ["id", "name", "subtype", "phase", "owner", "parent", "last_modified"],
  tests: ["id", "name", "subtype", "phase", "owner", "test_type", "last_modified"],
  manual_tests: ["id", "name", "phase", "owner", "estimated_duration", "last_modified"],
  gherkin_tests: ["id", "name", "phase", "owner", "automation_status", "last_modified"],
  test_suites: ["id", "name", "phase", "owner", "last_modified"],
  runs: ["id", "name", "subtype", "native_status", "status", "test", "release", "started", "duration", "run_by", "last_modified"],
  manual_runs: ["id", "name", "native_status", "test", "release", "run_by", "started", "last_modified"],
  suite_run: ["id", "name", "native_status", "test", "release", "started", "last_modified"],
  run_steps: ["id", "name", "description", "status", "expected_result", "actual_result", "run"],
  releases: ["id", "name", "start_date", "end_date", "is_default"],
  sprints: ["id", "name", "start_date", "end_date", "release"],
  milestones: ["id", "name", "date", "release"],
  teams: ["id", "name", "team_lead", "estimated_velocity"],
  phases: ["id", "name", "logical_name", "entity"],
  list_nodes: ["id", "name", "logical_name", "list_root"],
  workspace_users: ["id", "name", "full_name", "email", "activity_level"],
  comments: ["id", "text", "author", "creation_time", "owner_work_item", "owner_test", "owner_run"],
  attachments: ["id", "name", "size", "owner_work_item", "owner_test", "owner_run", "creation_time"],
  application_modules: ["id", "name", "parent", "owner"],
  product_areas: ["id", "name", "parent"],
  ci_builds: ["id", "name", "status", "result", "start_time", "duration"],
  pipelines: ["id", "name", "ci_server", "root_job_name"],
  pipeline_runs: ["id", "name", "status", "result", "start_time", "pipeline"],
  scm_commits: ["id", "revision", "message", "committer", "time", "branch"],
  history_records: ["entity_type", "entity_id", "field_name", "action", "old_value", "value", "user_name", "timestamp"],
};

export function defaultFields(resource: string): string[] {
  return DEFAULT_FIELDS[resource] ?? ["id", "name", "subtype", "phase", "owner", "last_modified"];
}

function compactField(f: FieldMeta): Record<string, unknown> {
  const out: Record<string, unknown> = { name: f.name, type: f.field_type };
  if (f.label && f.label !== f.name) out.label = f.label;
  if (f.required) out.required = true;
  if (f.editable === false) out.read_only = true;
  if (f.is_user_defined) out.udf = true;
  if (f.field_type_data?.multiple) out.multiple = true;
  const targets = f.field_type_data?.targets;
  if (targets?.length) {
    out.targets = targets.map((t) => t.logical_name ? `${t.type}:${t.logical_name}` : t.type);
  }
  return out;
}

export function registerGenericTools(server: McpServer, ctx: Ctx): void {
  defineTool(server, ctx, {
    name: "octane_search",
    title: "Search Octane entities",
    description:
      "Search any Octane collection with a filter. Works for defects, stories, features, epics, tasks, requirements, tests, " +
      "manual_tests, gherkin_tests, test_suites, runs, manual_runs, run_steps, releases, sprints, milestones, teams, " +
      "workspace_users, comments, attachments, application_modules, phases, list_nodes, ci_builds, pipelines, scm_commits and more. " +
      "Returns total_count plus a page of compact entities. Set all=true to fetch every match (capped by max).",
    schema: {
      resource: z.string().describe("Collection name, plural: 'defects', 'stories', 'tests', 'runs', 'releases'..."),
      query: z.string().optional().describe(QUERY_HELP),
      fields: z.array(z.string()).optional().describe(FIELDS_HELP),
      order_by: z.string().optional().describe("Sort, comma-separated, '-' prefix for descending: '-creation_time' or 'name,-story_points'."),
      limit: z.number().int().min(1).max(1000).optional().describe("Page size, default 50."),
      offset: z.number().int().min(0).optional().describe("Page offset, default 0."),
      all: z.boolean().optional().describe("Fetch all matching pages (up to max). Default false."),
      max: z.number().int().min(1).max(5000).optional().describe("Cap when all=true. Default 1000."),
      cross_workspace: z.string().optional().describe("'*' or comma-separated workspace ids to search several workspaces at once."),
      ...formatShape,
      ...scopeShape,
    },
    handler: async (a) => {
      const scope = scopeOf(a);
      const query = await buildQuery(ctx, a.resource, a.query, scope);
      const opts = {
        fields: a.fields ?? defaultFields(a.resource),
        query: query || undefined,
        orderBy: a.order_by,
        scope,
        crossWorkspace: a.cross_workspace,
      };
      const result = a.all
        ? await ctx.client.listAll(a.resource, { ...opts, offset: a.offset, max: a.max ?? 1000 })
        : await ctx.client.list(a.resource, { ...opts, limit: a.limit, offset: a.offset });
      const out = compactList(result, { raw: a.raw, html: a.html }) as Record<string, unknown>;
      if (query) out.oql = query;
      return out;
    },
  });

  defineTool(server, ctx, {
    name: "octane_get",
    title: "Get one entity",
    description: "Fetch a single entity by id, including memo fields like description. Returns null if it does not exist in the workspace.",
    schema: {
      resource: z.string().describe("Collection name, plural. Use 'work_items' if you do not know whether an id is a defect, story or feature."),
      id: z.string().describe("Entity id."),
      fields: z.array(z.string()).optional().describe(FIELDS_HELP + " Default: common fields plus description."),
      ...formatShape,
      ...scopeShape,
    },
    handler: async (a) => {
      const fields = a.fields ?? [...defaultFields(a.resource), "description"];
      const e = await ctx.client.get(a.resource, a.id, fields, scopeOf(a));
      return e ? compactEntity(e, { raw: a.raw, html: a.html }) : null;
    },
  });

  defineTool(server, ctx, {
    name: "octane_create",
    title: "Create entities",
    description:
      "Create one or more entities of a type. Reference fields accept plain names or ids and are resolved for you: " +
      "{\"name\":\"Login fails\",\"severity\":\"High\",\"owner\":\"jane@x.com\",\"parent\":1001,\"release\":\"R26.3\"}. " +
      "Required fields vary; defects need name, features under a release need team and milestone. Use octane_describe to check.",
    schema: {
      resource: z.string().describe("Collection name, plural: 'defects', 'stories', 'features', 'manual_tests', 'releases'..."),
      data: z.union([z.record(z.string(), z.unknown()), z.array(z.record(z.string(), z.unknown()))]).describe("One entity object, or an array for bulk create."),
      ...scopeShape,
    },
    write: true,
    handler: async (a) => {
      const scope = scopeOf(a);
      const entity = entityNameFor(a.resource);
      const items = Array.isArray(a.data) ? a.data : [a.data];
      const payload = [];
      for (const item of items) payload.push(await ctx.resolvers.normalizePayload(entity, item, scope));
      const created = await ctx.client.create(a.resource, payload, scope);
      return { created: created.length, data: created.map((e) => compactEntity(e)) };
    },
  });

  defineTool(server, ctx, {
    name: "octane_update",
    title: "Update an entity",
    description:
      "Update fields on one entity. Reference fields accept names or ids: {\"phase\":\"Fixed\",\"owner\":\"@me\",\"sprint\":\"Sprint 12\"}. " +
      "Set a field to null to clear it. For many items use octane_bulk_update or backlog_bulk_update.",
    schema: {
      resource: z.string().describe("Collection name, plural, matching the entity's subtype: 'defects' for a defect."),
      id: z.string().describe("Entity id."),
      data: z.record(z.string(), z.unknown()).describe("Fields to change."),
      ...scopeShape,
    },
    write: true,
    handler: async (a) => {
      const scope = scopeOf(a);
      const payload = await ctx.resolvers.normalizePayload(entityNameFor(a.resource), a.data, scope);
      const updated = await ctx.client.update(a.resource, a.id, payload, scope);
      return compactEntity(updated);
    },
  });

  defineTool(server, ctx, {
    name: "octane_bulk_update",
    title: "Bulk update entities",
    description:
      "Apply the same change to many entities of one type in a single request (Octane allows up to 2000). " +
      "Example: move defects 1,2,3 to sprint 'Sprint 12'. Names on reference fields are resolved once and reused.",
    schema: {
      resource: z.string().describe("Collection name, plural. 'work_items' works for mixed defects/stories/features when the fields are shared."),
      ids: z.array(z.string()).min(1).describe("Entity ids to update."),
      data: z.record(z.string(), z.unknown()).describe("Fields to set on every entity."),
      ...scopeShape,
    },
    write: true,
    handler: async (a) => {
      const scope = scopeOf(a);
      const payload = await ctx.resolvers.normalizePayload(entityNameFor(a.resource), a.data, scope);
      const items = a.ids.map((id) => ({ id, ...payload }));
      const updated = await ctx.client.bulkUpdate(a.resource, items, scope);
      return { updated: updated.length, ids: updated.map((e) => e.id) };
    },
  });

  defineTool(server, ctx, {
    name: "octane_delete",
    title: "Delete entities",
    description: "Permanently delete one or more entities of a type. Irreversible. Runs, commits and history are not deletable.",
    schema: {
      resource: z.string().describe("Collection name, plural."),
      ids: z.array(z.string()).min(1).describe("Entity ids to delete."),
      ...scopeShape,
    },
    write: true,
    destructive: true,
    handler: async (a) => {
      const scope = scopeOf(a);
      if (a.ids.length === 1) await ctx.client.delete(a.resource, a.ids[0], scope);
      else await ctx.client.bulkDelete(a.resource, a.ids, scope);
      return { deleted: a.ids };
    },
  });

  defineTool(server, ctx, {
    name: "octane_describe",
    title: "Describe an entity type",
    description:
      "Schema discovery. Lists the fields of an entity type with type, required/read-only flags, reference targets and list roots, " +
      "plus which operations the type supports. Call this before building a query or payload when unsure of a field name. " +
      "Pass no entity to list every entity type in the workspace.",
    schema: {
      entity: z.string().optional().describe("Entity type or collection: 'defect' or 'defects', 'story', 'test_manual', 'run_manual', 'requirement'..."),
      filter: z.string().optional().describe("Only fields whose name or label contains this text."),
      include_read_only: z.boolean().optional().describe("Include non-editable fields. Default true."),
      ...scopeShape,
    },
    handler: async (a) => {
      const scope = scopeOf(a);
      if (!a.entity) {
        const all = await ctx.client.metadataEntities(undefined, scope);
        return {
          entities: all.data.map((e) => ({
            name: e.name,
            label: e.label,
            collection: resourceFor(String(e.name)),
            features: Array.isArray(e.features) ? (e.features as Array<{ name: string }>).map((f) => f.name).filter((n) => ["rest", "phases", "hierarchy", "attachments", "comments", "subtypes", "has_attachments"].includes(n)) : undefined,
          })),
        };
      }
      const entity = a.entity.includes("_") || !a.entity.endsWith("s") ? (DEFAULT_FIELDS[a.entity] ? entityNameFor(a.entity) : a.entity) : entityNameFor(a.entity);
      const [meta, fields] = await Promise.all([
        ctx.client.metadataEntities(entity, scope).catch(() => ({ data: [] as Entity[] })),
        ctx.resolvers.fields(entity, scope),
      ]);
      const info = meta.data[0];
      const rest = Array.isArray(info?.features) ? (info.features as Array<{ name: string; methods?: string[] }>).find((f) => f.name === "rest") : undefined;
      const needle = a.filter?.toLowerCase();
      let list = fields;
      if (a.include_read_only === false) list = list.filter((f) => f.editable !== false);
      if (needle) list = list.filter((f) => f.name.toLowerCase().includes(needle) || (f.label ?? "").toLowerCase().includes(needle));
      return {
        entity,
        collection: resourceFor(entity),
        operations: rest?.methods,
        field_count: list.length,
        fields: list.map(compactField),
      };
    },
  });

  defineTool(server, ctx, {
    name: "octane_lookup",
    title: "Look up reference values",
    description:
      "Find the valid values for a reference field: phases of an entity type, values of a list field (severity, priority, run status...), " +
      "users, releases, sprints, milestones, teams or application modules. Optional name filter. Use the returned ids when a name is ambiguous.",
    schema: {
      kind: z.enum(["phases", "list_values", "users", "releases", "sprints", "milestones", "teams", "application_modules", "product_areas"]).describe("What to look up."),
      entity: z.string().optional().describe("For phases and list_values: the entity type, e.g. 'defect', 'story', 'test_manual', 'run_manual'."),
      field: z.string().optional().describe("For list_values: the field name, e.g. 'severity', 'priority', 'native_status'."),
      name: z.string().optional().describe("Filter by (partial) name."),
      release: z.string().optional().describe("For sprints and milestones: limit to this release (name or id)."),
      ...scopeShape,
    },
    handler: async (a) => {
      const scope = scopeOf(a);
      const needle = a.name?.toLowerCase();
      const match = (e: Entity) => !needle || [e.name, e.full_name, e.email, e.logical_name].some((v) => typeof v === "string" && v.toLowerCase().includes(needle));
      let data: Entity[];
      switch (a.kind) {
        case "phases": {
          if (!a.entity) throw new Error("phases lookup needs 'entity' (defect, story, feature, epic, test_manual, requirement...).");
          data = await ctx.resolvers.phases(a.entity, scope);
          break;
        }
        case "list_values": {
          if (!a.field) throw new Error("list_values lookup needs 'field' (and usually 'entity').");
          const entity = a.entity ?? "defect";
          const meta = await ctx.resolvers.field(entity, a.field, scope);
          const root = meta?.field_type_data?.targets?.find((t) => t.type === "list_node")?.logical_name ?? a.field;
          data = await ctx.resolvers.listNodes(root, scope);
          break;
        }
        case "users": {
          const r = await ctx.client.listAll("workspace_users", { fields: ["id", "name", "full_name", "email", "activity_level"], scope, max: 2000 });
          data = r.data;
          break;
        }
        default: {
          let query = "";
          if (a.release && (a.kind === "sprints" || a.kind === "milestones")) {
            const rel = await ctx.resolvers.byName("releases", a.release, scope);
            query = `release EQ {id EQ ${rel.id}}`;
          }
          const r = await ctx.client.listAll(a.kind, { fields: defaultFields(a.kind), query: query || undefined, scope, max: 2000 });
          data = r.data;
        }
      }
      const filtered = data.filter(match);
      return { kind: a.kind, count: filtered.length, data: filtered.map((e) => compactEntity(e)) };
    },
  });

  defineTool(server, ctx, {
    name: "octane_scopes",
    title: "Shared spaces, workspaces and current user",
    description:
      "Discover where you are: configured defaults, the signed-in user, the shared spaces visible to this account and the workspaces " +
      "in a shared space. Use the ids with the workspace_id / shared_space_id parameters of other tools.",
    schema: {
      shared_space_id: z.string().optional().describe("List workspaces of this shared space instead of the default one."),
    },
    handler: async (a) => {
      const scope = { sharedSpaceId: a.shared_space_id };
      const [me, spaces, workspaces] = await Promise.all([
        ctx.resolvers.currentUser(scope),
        ctx.client.listSharedSpaces().catch((e) => ({ data: [] as Entity[], error: String((e as Error).message) })),
        ctx.client.listWorkspaces(scope),
      ]);
      return {
        defaults: { base_url: ctx.cfg.baseUrl, shared_space_id: ctx.cfg.sharedSpaceId, workspace_id: ctx.cfg.workspaceId, read_only: ctx.cfg.readOnly },
        current_user: me,
        shared_spaces: spaces.data.map((e) => compactEntity(e)),
        workspaces: workspaces.data.map((e) => compactEntity(e)),
      };
    },
  });
}
