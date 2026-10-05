import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { OctaneClient } from "./client.js";
import type { OctaneConfig } from "./config.js";
import { createDispatcher } from "./http.js";
import { Resolvers } from "./resolvers.js";
import { registerResources } from "./resources.js";
import { registerAttachmentTools } from "./tools/attachments.js";
import { registerGenericTools } from "./tools/generic.js";
import { registerHistoryTools } from "./tools/history.js";
import { registerReportingTools } from "./tools/reporting.js";
import type { Ctx } from "./tools/shared.js";
import { registerTestTools } from "./tools/tests.js";
import { registerWorkItemTools } from "./tools/workitems.js";

export const VERSION = "0.1.0";

export const INSTRUCTIONS = `Tools for OpenText ALM Octane / Core Software Delivery Platform.

Start with octane_search (any collection, natural filters) and octane_get. Names work everywhere a reference is needed:
owner 'jane@x.com', phase 'Fixed', severity 'High', release 'R26.3', '@me' for the signed-in user.
Hierarchy: epic > feature > story/defect > task; children point up through 'parent' (tasks through 'story').
Unsure of a field or value? octane_describe lists fields, octane_lookup lists phases/list values/users/releases.
Workflow tools: work_item_triage, backlog_bulk_update, test_create, test_set_script, run_create, run_record_results,
attachment_upload, release_status, traceability, octane_history.
Read the resource octane://guide/query for the filter syntax.`;

export function createServer(cfg: OctaneConfig): { server: McpServer; ctx: Ctx } {
  const dispatcher = createDispatcher({ verifySsl: cfg.verifySsl, caCertPath: cfg.caCertPath, timeoutMs: cfg.timeoutMs });
  const client = new OctaneClient(cfg, { dispatcher });
  const resolvers = new Resolvers(client, cfg);
  const ctx: Ctx = { client, resolvers, cfg };

  const server = new McpServer(
    { name: "octane-mcp", version: VERSION },
    { instructions: INSTRUCTIONS + (cfg.readOnly ? "\n\nThis server is in READ-ONLY mode: no tool can modify Octane." : "") },
  );

  registerGenericTools(server, ctx);
  registerWorkItemTools(server, ctx);
  registerTestTools(server, ctx);
  registerAttachmentTools(server, ctx);
  registerHistoryTools(server, ctx);
  registerReportingTools(server, ctx);
  registerResources(server, ctx);

  return { server, ctx };
}
