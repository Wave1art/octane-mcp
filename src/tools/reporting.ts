import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { compactEntity, type Entity } from "../format.js";
import type { Scope } from "../client.js";
import { defineTool, scopeOf, scopeShape, type Ctx } from "./shared.js";

function nameOf(e: Entity, field: string): string {
  const v = e[field] as Entity | null | undefined;
  return v && typeof v === "object" ? String(v.name ?? v.id) : "none";
}

function count(items: Entity[], field: string): Record<string, number> {
  const out: Record<string, number> = {};
  for (const e of items) {
    const k = nameOf(e, field);
    out[k] = (out[k] ?? 0) + 1;
  }
  return out;
}

function matrix(items: Entity[], rowField: string, colField: string): Record<string, Record<string, number>> {
  const out: Record<string, Record<string, number>> = {};
  for (const e of items) {
    const r = nameOf(e, rowField);
    const c = nameOf(e, colField);
    out[r] ??= {};
    out[r][c] = (out[r][c] ?? 0) + 1;
  }
  return out;
}

function sumPoints(items: Entity[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const e of items) {
    const k = nameOf(e, "phase");
    out[k] = (out[k] ?? 0) + (Number(e.story_points) || 0);
  }
  return out;
}

export function registerReportingTools(server: McpServer, ctx: Ctx): void {
  defineTool(server, ctx, {
    name: "release_status",
    title: "Release or sprint status",
    description:
      "Status rollup for a release or a sprint: defects by severity and phase, stories by phase with story points, features by phase, " +
      "and the latest run results. Returns counts, not item lists; use octane_search for the items.",
    schema: {
      release: z.string().optional().describe("Release name or id."),
      sprint: z.string().optional().describe("Sprint name or id (narrower than release)."),
      team: z.string().optional().describe("Restrict to one team (name or id)."),
      include_runs: z.boolean().optional().describe("Include test run summary. Default true."),
      ...scopeShape,
    },
    handler: async (a) => {
      const scope = scopeOf(a);
      if (!a.release && !a.sprint) throw new Error("Provide release or sprint.");
      const clauses: string[] = [];
      const labels: Record<string, string> = {};
      if (a.release) {
        const r = await ctx.resolvers.byName("releases", a.release, scope);
        clauses.push(`release EQ {id EQ ${r.id}}`);
        labels.release = r.name ?? r.id;
      }
      if (a.sprint) {
        const s = await ctx.resolvers.byName("sprints", a.sprint, scope);
        clauses.push(`sprint EQ {id EQ ${s.id}}`);
        labels.sprint = s.name ?? s.id;
      }
      if (a.team) {
        const t = await ctx.resolvers.byName("teams", a.team, scope);
        clauses.push(`team EQ {id EQ ${t.id}}`);
        labels.team = t.name ?? t.id;
      }
      const q = clauses.join(";");
      const fetch = (resource: string, fields: string[], extra?: string) =>
        ctx.client.listAll(resource, { query: extra ? `${q};${extra}` : q, fields, scope, max: 5000 }).then((r) => r.data);

      const [defects, stories, features] = await Promise.all([
        fetch("defects", ["id", "severity", "phase", "owner"]),
        fetch("stories", ["id", "phase", "story_points", "owner"]),
        a.sprint ? Promise.resolve([] as Entity[]) : fetch("features", ["id", "phase", "story_points"]),
      ]);

      let runs: unknown;
      if (a.include_runs !== false && a.release) {
        const data = await fetch("runs", ["id", "native_status", "subtype", "test"]);
        runs = { total: data.length, by_status: count(data, "native_status"), by_type: countStr(data, "subtype") };
      }

      return {
        scope: labels,
        defects: { total: defects.length, by_severity: count(defects, "severity"), by_phase: count(defects, "phase"), severity_by_phase: matrix(defects, "severity", "phase"), open_by_owner: count(defects.filter((d) => !/closed|done|rejected|duplicate/i.test(nameOf(d, "phase"))), "owner") },
        stories: { total: stories.length, by_phase: count(stories, "phase"), points_by_phase: sumPoints(stories), points_total: stories.reduce((s, e) => s + (Number(e.story_points) || 0), 0) },
        features: a.sprint ? undefined : { total: features.length, by_phase: count(features, "phase") },
        runs,
      };
    },
  });

  defineTool(server, ctx, {
    name: "traceability",
    title: "Requirement / story traceability",
    description:
      "Follow the chain from a requirement, story, feature or defect to the tests that cover it and each test's latest run result, " +
      "plus (for requirements) child requirements. Answers 'is this covered and does it pass?'.",
    schema: {
      id: z.string().describe("Requirement or work item id."),
      kind: z.enum(["work_item", "requirement"]).optional().describe("Default: detect (work item first)."),
      ...scopeShape,
    },
    handler: async (a) => {
      const scope = scopeOf(a);
      let item: Entity | null = null;
      let kind = a.kind;
      if (kind !== "requirement") item = await ctx.client.get("work_items", a.id, ["id", "name", "subtype", "phase", "owner", "release"], scope);
      if (item) kind = "work_item";
      else {
        item = await ctx.client.get("requirements", a.id, ["id", "name", "subtype", "phase", "owner", "parent"], scope);
        kind = "requirement";
      }
      if (!item) return null;

      const coverField = kind === "requirement" ? "covered_requirement" : "covered_content";
      const tests = await ctx.client.listAll("tests", {
        query: `${coverField} EQ {id EQ ${a.id}}`,
        fields: ["id", "name", "subtype", "phase", "owner"],
        scope,
        max: 500,
      });

      const latestRuns = await latestRunPerTest(ctx, tests.data.map((t) => String(t.id)), scope);
      const testsOut = tests.data.map((t) => ({
        ...(compactEntity(t) as object),
        last_run: latestRuns.get(String(t.id)) ?? null,
      }));

      let children: unknown;
      if (kind === "requirement") {
        const kids = await ctx.client.listAll("requirements", { query: `parent EQ {id EQ ${a.id}}`, fields: ["id", "name", "subtype", "phase"], scope, max: 500 });
        children = kids.data.map((e) => compactEntity(e));
      }

      const statuses = [...latestRuns.values()].map((r) => String((r as { status?: string }).status ?? "unknown"));
      return {
        item: compactEntity(item),
        coverage: {
          tests: tests.data.length,
          with_runs: statuses.length,
          never_run: tests.data.length - statuses.length,
          latest_results: statuses.reduce<Record<string, number>>((acc, s) => ((acc[s] = (acc[s] ?? 0) + 1), acc), {}),
        },
        tests: testsOut,
        child_requirements: children,
      };
    },
  });
}

function countStr(items: Entity[], field: string): Record<string, number> {
  const out: Record<string, number> = {};
  for (const e of items) {
    const k = String(e[field] ?? "unknown");
    out[k] = (out[k] ?? 0) + 1;
  }
  return out;
}

async function latestRunPerTest(ctx: Ctx, testIds: string[], scope: Scope): Promise<Map<string, unknown>> {
  const out = new Map<string, unknown>();
  if (!testIds.length) return out;
  // One query per batch of tests, newest first; keep the first run seen per test.
  for (let i = 0; i < testIds.length; i += 25) {
    const batch = testIds.slice(i, i + 25);
    const q = `(${batch.map((id) => `test EQ {id EQ ${id}}`).join("||")})`;
    const runs = await ctx.client.listAll("runs", {
      query: q,
      fields: ["id", "name", "native_status", "test", "started", "last_modified", "release"],
      orderBy: "-last_modified",
      scope,
      max: 1000,
    });
    for (const r of runs.data) {
      const tid = String((r.test as Entity | undefined)?.id ?? "");
      if (!tid || out.has(tid)) continue;
      out.set(tid, {
        run_id: r.id,
        status: (r.native_status as Entity | undefined)?.name ?? "unknown",
        when: r.started ?? r.last_modified,
        release: (r.release as Entity | undefined)?.name,
      });
    }
  }
  return out;
}
