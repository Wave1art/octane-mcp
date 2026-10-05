import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { OctaneClient, Scope } from "../client.js";
import type { OctaneConfig } from "../config.js";
import { Resolvers, entityNameFor } from "../resolvers.js";
import { translateQuery, type TranslateOptions } from "../oql.js";
import { toText } from "../format.js";

export interface Ctx {
  client: OctaneClient;
  resolvers: Resolvers;
  cfg: OctaneConfig;
}

export const scopeShape = {
  shared_space_id: z.string().optional().describe("Target a different shared space than the configured default."),
  workspace_id: z.string().optional().describe("Target a different workspace than the configured default (see octane_scopes)."),
};

export const formatShape = {
  raw: z.boolean().optional().describe("Return Octane's untouched JSON instead of the compact form. Default false."),
  html: z.enum(["text", "html"]).optional().describe("Memo fields (description, steps...) as plain text (default) or original HTML."),
};

export function scopeOf(a: { shared_space_id?: string; workspace_id?: string }): Scope {
  return { sharedSpaceId: a.shared_space_id, workspaceId: a.workspace_id };
}

export function ok(value: unknown): CallToolResult {
  return { content: [{ type: "text", text: toText(value) }] };
}

export function fail(e: unknown): CallToolResult {
  return { content: [{ type: "text", text: `Error: ${Resolvers.explain(e)}` }], isError: true };
}

export const QUERY_HELP =
  "Filter query. Write it naturally: field = 'value', !=, >, >=, <, <=, ~ (contains), in (a, b), between a and b, " +
  "combine with and / or / not and parentheses. Reference fields accept names: owner = 'Jane Doe', phase = 'In Progress', " +
  "severity = 'High', release = 'R26.3', parent = 1001. Use @me for yourself, null for empty: sprint = null. " +
  "Dates are ISO: creation_time >= '2026-01-01'. Native Octane OQL (EQ, ^..^, {name EQ ^x^}) is also accepted.";

export const FIELDS_HELP =
  "Fields to return, as an array. Nested fields of references are allowed: ['id','name','release{name,end_date}']. " +
  "Omit for a sensible default per entity type. Use octane_describe to list available fields.";

/** Translate a friendly query for `entity`, using live metadata for reference fields when available. */
export async function buildQuery(ctx: Ctx, resource: string, query: string | undefined, scope?: Scope): Promise<string> {
  if (!query?.trim()) return "";
  const opts: TranslateOptions = {};
  const refs = await ctx.resolvers.referenceFields(entityNameFor(resource), scope);
  if (refs.size) opts.referenceFields = refs;
  if (/@me|\bme\b|current_user/i.test(query)) {
    const me = await ctx.resolvers.currentUser(scope);
    if (me) opts.currentUserId = me.id;
  }
  return translateQuery(query, opts);
}

export interface ToolDef<S extends z.ZodRawShape> {
  name: string;
  title: string;
  description: string;
  schema: S;
  /** The tool changes data in Octane. Hidden in OCTANE_READ_ONLY mode. */
  write?: boolean;
  destructive?: boolean;
  handler: (args: z.infer<z.ZodObject<S>>) => Promise<unknown>;
}

/** Register a tool with consistent annotations and error handling. */
export function defineTool<S extends z.ZodRawShape>(server: McpServer, ctx: Ctx, def: ToolDef<S>): void {
  if (def.write && ctx.cfg.readOnly) return;
  server.registerTool(
    def.name,
    {
      title: def.title,
      description: def.description,
      inputSchema: def.schema,
      annotations: {
        readOnlyHint: !def.write,
        destructiveHint: def.destructive ?? false,
        idempotentHint: !def.write,
        openWorldHint: true,
      },
    },
    (async (args: z.infer<z.ZodObject<S>>) => {
      try {
        return ok(await def.handler(args));
      } catch (e) {
        return fail(e);
      }
    }) as never,
  );
}

export function parseIds(input: string | string[] | number[]): string[] {
  const arr = Array.isArray(input) ? input.map(String) : input.split(/[,\s]+/);
  return arr.map((s) => s.trim()).filter(Boolean);
}
