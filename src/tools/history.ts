import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { OctaneError } from "../client.js";
import { compactList } from "../format.js";
import { defineTool, scopeOf, scopeShape, type Ctx } from "./shared.js";

export function registerHistoryTools(server: McpServer, ctx: Ctx): void {
  defineTool(server, ctx, {
    name: "octane_history",
    title: "Change history",
    description:
      "Field-level change history: what changed on an entity, who changed it and when. Filter by entity, user, action and time range. " +
      "Uses the history_records resource (technical preview; needs OCTANE_TECH_PREVIEW=true, the default) and falls back to audits.",
    schema: {
      entity_type: z.string().optional().describe("Entity type: 'defect', 'story', 'feature', 'test_manual'..."),
      entity_id: z.string().optional().describe("Entity id."),
      user: z.string().optional().describe("Only changes by this user (email, name or id)."),
      action: z.enum(["create", "update", "delete"]).optional(),
      since: z.string().optional().describe("ISO date/time lower bound, e.g. 2026-09-01."),
      until: z.string().optional().describe("ISO date/time upper bound."),
      field: z.string().optional().describe("Only changes to this field name."),
      limit: z.number().int().min(1).max(1000).optional().describe("Default 100."),
      ...scopeShape,
    },
    handler: async (a) => {
      const scope = scopeOf(a);
      const parts: string[] = [];
      if (a.entity_type) parts.push(`entity_type EQ ^${a.entity_type}^`);
      if (a.entity_id) parts.push(`entity_id EQ ${a.entity_id}`);
      if (a.action) parts.push(`action EQ ^${a.action}^`);
      if (a.field) parts.push(`field_name EQ ^${a.field}^`);
      if (a.user) parts.push(`user_id EQ ${(await ctx.resolvers.user(a.user, scope)).id}`);
      if (a.since) parts.push(`timestamp GE ^${iso(a.since)}^`);
      if (a.until) parts.push(`timestamp LE ^${iso(a.until)}^`);
      const query = parts.join(";");
      const opts = { query: query || undefined, orderBy: "-timestamp", limit: a.limit ?? 100, scope };
      try {
        const r = await ctx.client.list("history_records", {
          ...opts,
          fields: ["entity_type", "entity_id", "field_name", "action", "old_value", "value", "user_name", "timestamp"],
        });
        return { source: "history_records", ...(compactList(r) as object) };
      } catch (e) {
        if (!(e instanceof OctaneError) || ![403, 404, 400].includes(e.status)) throw e;
        const r = await ctx.client.list("audits", { ...opts, fields: ["entity_type", "entity_id", "action", "user_name", "timestamp", "change_set"] });
        return { source: "audits", ...(compactList(r) as object) };
      }
    },
  });
}

function iso(s: string): string {
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return `${s}T00:00:00Z`;
  if (!/(Z|[+-]\d{2}:\d{2})$/.test(s)) return `${s}Z`;
  return s;
}
