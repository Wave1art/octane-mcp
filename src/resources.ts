import { McpServer, ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Ctx } from "./tools/shared.js";

export const OQL_GUIDE = `# Octane query guide (as accepted by octane-mcp)

Write filters naturally; the server translates them to Octane OQL.

## Operators
  field = 'value'        equals            field != 'value'      not equal
  field > 5  >= <= <                        field ~ 'text'        contains (wildcard *text*)
  field in ('a','b')     any of            field between '2026-01-01' and '2026-02-01'
  field = null           is empty          not (…)  /  !field = x

## Combining
  a and b      a or b      not a      ( … ) for grouping
  Native Octane forms also work: ; for AND, || for OR, EQ/GT/GE/LT/LE/IN/BTW, ^quoted^ strings.

## Reference fields (owner, phase, severity, sprint, release, parent, team, test, …)
  Give the name: owner = 'Jane Doe'   phase = 'In Progress'   severity = 'High'   release = 'R26.3'
  Or the id:     parent = 1001         owner = 1234
  Logical names: phase = phase.defect.fixed   severity = list_node.severity.high
  Yourself:      owner = @me
  Explicit:      owner = {email = 'jane@x.com'}   release = {name ~ '26'}

## Dates
  ISO 8601, UTC. A bare date means midnight: creation_time >= '2026-09-01'

## Hierarchy
  epic > feature > story/defect > task. Children point UP to their parent:
    stories under feature 1001:   parent = 1001       (there is no 'feature' field on a story)
    tasks under story 2002:       story = 2002
    defects on a feature:         parent = 1001

## Common fields
  Work items: id name subtype phase owner severity priority story_points release sprint team parent
              detected_by creation_time last_modified description
  Tests:      id name subtype phase owner covered_content test_type
  Runs:       id name subtype native_status test release run_by started duration
  Comments:   owner_work_item owner_test owner_run text author

## Gotchas
  - Memo fields (description) cannot be filtered.
  - Field names are instance-specific for UDFs (usually *_udf): check octane_describe.
  - A 400 "unknown field" almost always means a wrong field name, not a bad value.
`;

export function registerResources(server: McpServer, ctx: Ctx): void {
  server.registerResource(
    "oql-guide",
    "octane://guide/query",
    { title: "Octane query guide", description: "How to write filters for octane_search and friends.", mimeType: "text/markdown" },
    async (uri) => ({ contents: [{ uri: uri.href, mimeType: "text/markdown", text: OQL_GUIDE }] }),
  );

  server.registerResource(
    "schema",
    new ResourceTemplate("octane://schema/{entity}", { list: undefined }),
    { title: "Entity schema", description: "Field list for an entity type, e.g. octane://schema/defect", mimeType: "application/json" },
    async (uri, vars) => {
      const entity = String(vars.entity);
      const fields = await ctx.resolvers.fields(entity);
      const text = JSON.stringify(
        fields.map((f) => ({ name: f.name, type: f.field_type, required: f.required || undefined, targets: f.field_type_data?.targets?.map((t) => t.logical_name ?? t.type) })),
        null,
        1,
      );
      return { contents: [{ uri: uri.href, mimeType: "application/json", text }] };
    },
  );
}
