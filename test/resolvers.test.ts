import { describe, expect, it } from "vitest";
import { Resolvers, entityNameFor, resourceFor } from "../src/resolvers.js";
import type { OctaneClient } from "../src/client.js";
import type { OctaneConfig } from "../src/config.js";

const cfg: OctaneConfig = {
  baseUrl: "https://octane.test", sharedSpaceId: "1", workspaceId: "2",
  auth: { kind: "apikey", clientId: "a", clientSecret: "b" },
  verifySsl: true, techPreview: true, readOnly: false, timeoutMs: 1000,
  udfAliases: { acceptance_criteria: "acceptance_criteria_udf" },
  currentUser: "jane@x.com",
};

/** Minimal in-memory Octane. */
function fakeClient() {
  const calls: string[] = [];
  const data: Record<string, unknown[]> = {
    "metadata/fields:defect": [
      { name: "name", field_type: "string" },
      { name: "owner", field_type: "reference", field_type_data: { targets: [{ type: "workspace_user" }] } },
      { name: "severity", field_type: "reference", field_type_data: { targets: [{ type: "list_node", logical_name: "list_node.severity" }] } },
      { name: "phase", field_type: "reference", field_type_data: { targets: [{ type: "phase" }] } },
      { name: "release", field_type: "reference", field_type_data: { targets: [{ type: "release" }] } },
      { name: "parent", field_type: "reference", field_type_data: { targets: [{ type: "feature" }, { type: "work_item_root" }] } },
      { name: "product_areas", field_type: "reference", field_type_data: { multiple: true, targets: [{ type: "product_area" }] } },
      { name: "acceptance_criteria_udf", field_type: "memo", is_user_defined: true },
    ],
    workspace_users: [
      { id: "10", name: "jane", full_name: "Jane Doe", email: "jane@x.com" },
      { id: "11", name: "john", full_name: "John Doe", email: "john@x.com" },
    ],
    list_nodes: [
      { id: "100", name: "High", logical_name: "list_node.severity.high" },
      { id: "101", name: "Very High", logical_name: "list_node.severity.very_high" },
    ],
    phases: [
      { id: "200", name: "New", logical_name: "phase.defect.new" },
      { id: "201", name: "Fixed", logical_name: "phase.defect.fixed" },
    ],
    releases: [{ id: "300", name: "R26.3" }, { id: "301", name: "R26.4" }],
    product_areas: [{ id: "400", name: "Checkout" }],
  };
  const client = {
    scope: () => ({ sharedSpaceId: "1", workspaceId: "2" }),
    metadataFields: async (entity: string) => ({ total_count: 0, data: data[`metadata/fields:${entity}`] ?? [] }),
    listAll: async (resource: string, o: { query?: string }) => {
      calls.push(`${resource}?${o.query ?? ""}`);
      let rows = data[resource] ?? [];
      if (resource === "list_nodes" && o.query) {
        const m = /\^list_node\.(\w+)\.\*\^/.exec(o.query);
        if (m) rows = rows.filter((r) => String((r as { logical_name: string }).logical_name).startsWith(`list_node.${m[1]}.`));
      }
      return { total_count: rows.length, data: rows };
    },
    list: async (resource: string, o: { query?: string }) => {
      calls.push(`${resource}?${o.query ?? ""}`);
      return { total_count: 0, data: [] };
    },
    get: async (resource: string, id: string) => {
      calls.push(`${resource}/${id}`);
      if (resource === "work_items" && id === "1001") return { id, name: "Payments", subtype: "feature" };
      return null;
    },
    currentUser: async () => null,
  } as unknown as OctaneClient;
  return { client, calls };
}

describe("Resolvers", () => {
  it("maps resources and entity names", () => {
    expect(entityNameFor("defects")).toBe("defect");
    expect(entityNameFor("stories")).toBe("story");
    expect(entityNameFor("manual_tests")).toBe("test_manual");
    expect(entityNameFor("custom_things")).toBe("custom_thing");
    expect(resourceFor("run_suite")).toBe("suite_run");
    expect(resourceFor("quality_story")).toBe("quality_stories");
  });

  it("resolves users by email, name and 'me'", async () => {
    const { client } = fakeClient();
    const r = new Resolvers(client, cfg);
    expect(await r.user("jane@x.com")).toMatchObject({ type: "workspace_user", id: "10" });
    expect(await r.user("John Doe")).toMatchObject({ id: "11" });
    expect(await r.user("@me")).toMatchObject({ id: "10" });
    expect(await r.user("55")).toEqual({ type: "workspace_user", id: "55" });
    await expect(r.user("Doe")).rejects.toThrow(/ambiguous|several/);
    await expect(r.user("nobody")).rejects.toThrow(/not found/);
  });

  it("resolves phases by name, logical name and suffix", async () => {
    const { client } = fakeClient();
    const r = new Resolvers(client, cfg);
    expect(await r.phase("defect", "Fixed")).toMatchObject({ type: "phase", id: "201" });
    expect(await r.phase("defect", "phase.defect.new")).toMatchObject({ id: "200" });
    expect(await r.phase("defect", "new")).toMatchObject({ id: "200" });
  });

  it("prefers exact matches over partial ones", async () => {
    const { client } = fakeClient();
    const r = new Resolvers(client, cfg);
    expect(await r.listNode("severity", "High")).toMatchObject({ id: "100" });
    expect(await r.listNode("severity", "very high")).toMatchObject({ id: "101" });
  });

  it("normalises a payload using metadata", async () => {
    const { client } = fakeClient();
    const r = new Resolvers(client, cfg);
    const out = await r.normalizePayload("defect", {
      name: "Crash",
      owner: "jane@x.com",
      severity: "High",
      phase: "Fixed",
      release: "R26.4",
      parent: 1001,
      product_areas: "Checkout",
      acceptance_criteria: "Given...",
      already: { type: "x", id: "1" },
      cleared: null,
    });
    expect(out).toEqual({
      name: "Crash",
      owner: { type: "workspace_user", id: "10" },
      severity: { type: "list_node", id: "100" },
      phase: { type: "phase", id: "201" },
      release: { type: "release", id: "301" },
      parent: { type: "feature", id: "1001" },
      product_areas: { data: [{ type: "product_area", id: "400" }] },
      acceptance_criteria_udf: "Given...",
      already: { type: "x", id: "1" },
      cleared: null,
    });
  });

  it("caches lookups per workspace", async () => {
    const { client, calls } = fakeClient();
    const r = new Resolvers(client, cfg);
    await r.user("jane@x.com");
    await r.user("john@x.com");
    expect(calls.filter((c) => c.startsWith("workspace_users")).length).toBe(1);
  });
});
