import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { compactEntity, compactList, type Entity } from "../format.js";
import { resourceFor, type Ref } from "../resolvers.js";
import type { Scope } from "../client.js";
import { defineTool, scopeOf, scopeShape, type Ctx } from "./shared.js";

/** Friendly fields shared by the triage and bulk tools. */
const changeShape = {
  phase: z.string().optional().describe("New phase by name or logical name: 'In Progress', 'Fixed', 'Done'."),
  owner: z.string().nullable().optional().describe("Owner by email, full name, id or '@me'. null clears."),
  severity: z.string().optional().describe("Defects only: 'Low', 'Medium', 'High', 'Very High', 'Urgent'."),
  priority: z.string().optional().describe("Priority list value by name."),
  sprint: z.string().nullable().optional().describe("Sprint by name or id. null clears."),
  release: z.string().nullable().optional().describe("Release by name or id. null clears."),
  team: z.string().nullable().optional().describe("Team by name or id."),
  parent: z.string().optional().describe("New parent (feature/epic/backlog root) by id or exact name."),
  story_points: z.number().optional().describe("Stories and features."),
  name: z.string().optional().describe("Rename."),
  description: z.string().optional().describe("Replace the description (HTML or plain text)."),
  fields: z.record(z.string(), z.unknown()).optional().describe("Any other fields, including UDFs; names on reference fields are resolved."),
};

type Change = z.infer<z.ZodObject<typeof changeShape>>;

/** Resolve everything except phase (phase depends on the subtype). */
async function resolveCommon(ctx: Ctx, c: Change, subtype: string, scope: Scope): Promise<Record<string, unknown>> {
  const data: Record<string, unknown> = {};
  const ref = (r: Ref) => ({ type: r.type, id: r.id });
  if (c.owner !== undefined) data.owner = c.owner === null ? null : ref(await ctx.resolvers.user(c.owner, scope));
  if (c.severity !== undefined) data.severity = ref(await ctx.resolvers.listValueForField(subtype, "severity", c.severity, scope));
  if (c.priority !== undefined) data.priority = ref(await ctx.resolvers.listValueForField(subtype, "priority", c.priority, scope));
  if (c.sprint !== undefined) data.sprint = c.sprint === null ? null : ref(await ctx.resolvers.byName("sprints", c.sprint, scope));
  if (c.release !== undefined) data.release = c.release === null ? null : ref(await ctx.resolvers.byName("releases", c.release, scope));
  if (c.team !== undefined) data.team = c.team === null ? null : ref(await ctx.resolvers.byName("teams", c.team, scope));
  if (c.parent !== undefined) data.parent = ref(await ctx.resolvers.parentRef(c.parent, scope));
  if (c.story_points !== undefined) data.story_points = c.story_points;
  if (c.name !== undefined) data.name = c.name;
  if (c.description !== undefined) data.description = c.description;
  if (c.fields) Object.assign(data, await ctx.resolvers.normalizePayload(subtype, c.fields, scope));
  return data;
}

export function registerWorkItemTools(server: McpServer, ctx: Ctx): void {
  defineTool(server, ctx, {
    name: "work_item_triage",
    title: "Triage a work item",
    description:
      "Update a defect, story, feature or epic in one call using names instead of ids, and optionally add a comment. " +
      "Typical use: set phase, severity, owner, sprint and leave a note explaining the decision. The subtype is detected from the id.",
    schema: {
      id: z.string().describe("Work item id (defect, story, quality story, feature or epic)."),
      comment: z.string().optional().describe("Comment to add after the update (HTML or plain text)."),
      ...changeShape,
      ...scopeShape,
    },
    write: true,
    handler: async (a) => {
      const scope = scopeOf(a);
      const wi = await ctx.resolvers.workItem(a.id, scope);
      const subtype = String(wi.subtype ?? "work_item");
      const data = await resolveCommon(ctx, a, subtype, scope);
      if (a.phase !== undefined) {
        const p = await ctx.resolvers.phase(subtype, a.phase, scope);
        data.phase = { type: "phase", id: p.id };
      }
      let updated: Entity | undefined;
      if (Object.keys(data).length) updated = await ctx.client.update(resourceFor(subtype), a.id, data, scope);
      let comment: Entity | undefined;
      if (a.comment) {
        [comment] = await ctx.client.create("comments", { text: a.comment, owner_work_item: { type: "work_item", id: a.id } }, scope);
      }
      if (!updated && !comment) return { message: "Nothing to change." };
      return { updated: updated ? compactEntity(updated) : undefined, comment: comment ? compactEntity(comment) : undefined };
    },
  });

  defineTool(server, ctx, {
    name: "backlog_bulk_update",
    title: "Bulk backlog grooming",
    description:
      "Change many work items at once using names: move to a sprint or release, re-assign, re-parent, set phase or points. " +
      "Items can be mixed types; phase is resolved per subtype. One request per subtype is sent.",
    schema: {
      ids: z.array(z.string()).min(1).describe("Work item ids."),
      ...changeShape,
      ...scopeShape,
    },
    write: true,
    handler: async (a) => {
      const scope = scopeOf(a);
      const items = await ctx.client.listAll("work_items", { query: `id IN ${a.ids.join(",")}`, fields: ["id", "subtype"], scope, max: 2000 });
      const found = new Set(items.data.map((e) => String(e.id)));
      const missing = a.ids.filter((id) => !found.has(id));
      const bySubtype = new Map<string, string[]>();
      for (const e of items.data) {
        const st = String(e.subtype ?? "work_item");
        bySubtype.set(st, [...(bySubtype.get(st) ?? []), String(e.id)]);
      }
      const results: Record<string, unknown> = {};
      for (const [subtype, ids] of bySubtype) {
        const data = await resolveCommon(ctx, a, subtype, scope);
        if (a.phase !== undefined) data.phase = { type: "phase", id: (await ctx.resolvers.phase(subtype, a.phase, scope)).id };
        if (!Object.keys(data).length) continue;
        const updated = await ctx.client.bulkUpdate(resourceFor(subtype), ids.map((id) => ({ id, ...data })), scope);
        results[subtype] = { updated: updated.length, ids: updated.map((e) => e.id) };
      }
      return { results, not_found: missing.length ? missing : undefined };
    },
  });

  defineTool(server, ctx, {
    name: "work_item_tree",
    title: "Work item with its children",
    description:
      "Show an epic, feature or story with its descendants (features under an epic, stories and defects under a feature, tasks under a story) " +
      "and a phase rollup per level. Good for 'how is feature X going?'.",
    schema: {
      id: z.string().describe("Root work item id."),
      depth: z.number().int().min(1).max(3).optional().describe("Levels of children to include. Default 2."),
      include_tasks: z.boolean().optional().describe("Include tasks under stories. Default false."),
      ...scopeShape,
    },
    handler: async (a) => {
      const scope = scopeOf(a);
      const fields = ["id", "name", "subtype", "phase", "owner", "story_points", "release", "sprint", "severity"];
      const root = await ctx.client.get("work_items", a.id, [...fields, "description"], scope);
      if (!root) return null;

      const walk = async (parentIds: string[], level: number): Promise<Entity[]> => {
        if (!parentIds.length || level > (a.depth ?? 2)) return [];
        const q = parentIds.length === 1 ? `parent EQ {id EQ ${parentIds[0]}}` : `(${parentIds.map((id) => `parent EQ {id EQ ${id}}`).join("||")})`;
        const children = await ctx.client.listAll("work_items", { query: q, fields: [...fields, "parent"], orderBy: "id", scope, max: 2000 });
        const grandchildren = await walk(children.data.map((c) => String(c.id)), level + 1);
        const byParent = new Map<string, Entity[]>();
        for (const g of grandchildren) {
          const pid = String((g.parent as Entity | undefined)?.id ?? "");
          byParent.set(pid, [...(byParent.get(pid) ?? []), g]);
        }
        return children.data.map((c) => {
          const out = compactEntity(c) as Record<string, unknown>;
          delete out.parent;
          const kids = byParent.get(String(c.id));
          if (kids?.length) out.children = kids;
          return out as Entity;
        });
      };

      const children = await walk([a.id], 1);
      let tasks: unknown;
      if (a.include_tasks) {
        const storyIds = collectIds(children, (e) => e.type === "story" || e.type === "quality_story");
        if (String(root.subtype) === "story") storyIds.push(a.id);
        if (storyIds.length) {
          const q = `(${storyIds.map((id) => `story EQ {id EQ ${id}}`).join("||")})`;
          const t = await ctx.client.listAll("tasks", { query: q, fields: ["id", "name", "phase", "owner", "story", "remaining_hours"], scope, max: 2000 });
          tasks = compactList(t);
        }
      }
      return {
        root: compactEntity(root),
        rollup: rollup(children),
        children,
        tasks,
      };
    },
  });

  defineTool(server, ctx, {
    name: "octane_comment",
    title: "Comment on an item",
    description: "Add a comment to a work item, test, run or requirement, or list the existing comments on it.",
    schema: {
      id: z.string().describe("Id of the item."),
      owner_type: z.enum(["work_item", "test", "run", "requirement", "task"]).optional().describe("What kind of item the id is. Default work_item."),
      text: z.string().optional().describe("Comment to add (HTML or plain text). Omit to just list comments."),
      limit: z.number().int().min(1).max(200).optional().describe("How many existing comments to return. Default 20."),
      ...scopeShape,
    },
    write: true,
    handler: async (a) => {
      const scope = scopeOf(a);
      const type = a.owner_type ?? "work_item";
      const field = `owner_${type}`;
      let added: Entity | undefined;
      if (a.text) [added] = await ctx.client.create("comments", { text: a.text, [field]: { type, id: a.id } }, scope);
      const existing = await ctx.client.list("comments", {
        query: `${field} EQ {id EQ ${a.id}}`,
        fields: ["id", "text", "author", "creation_time"],
        orderBy: "-creation_time",
        limit: a.limit ?? 20,
        scope,
      });
      return { added: added ? compactEntity(added) : undefined, comments: compactList(existing) };
    },
  });
}

function collectIds(nodes: Entity[], pred: (e: Entity) => boolean): string[] {
  const out: string[] = [];
  for (const n of nodes) {
    if (pred(n)) out.push(String(n.id));
    if (Array.isArray(n.children)) out.push(...collectIds(n.children as Entity[], pred));
  }
  return out;
}

function rollup(nodes: Entity[]): Record<string, Record<string, number>> {
  const out: Record<string, Record<string, number>> = {};
  const visit = (list: Entity[]) => {
    for (const n of list) {
      const type = String(n.type ?? "item");
      const phase = String((n.phase as Entity | undefined)?.name ?? "unknown");
      out[type] ??= {};
      out[type][phase] = (out[type][phase] ?? 0) + 1;
      out[type].total = (out[type].total ?? 0) + 1;
      if (Array.isArray(n.children)) visit(n.children as Entity[]);
    }
  };
  visit(nodes);
  return out;
}
