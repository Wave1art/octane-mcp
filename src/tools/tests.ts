import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { compactEntity, compactList, type Entity } from "../format.js";
import { defineTool, scopeOf, scopeShape, type Ctx } from "./shared.js";

const stepSchema = z.object({
  text: z.string().describe("Step text. For a call step, the id of the test to call."),
  type: z.enum(["step", "validation", "call"]).optional().describe("Default 'step'. 'validation' renders as '- ?text'; 'call' as '- @<test id>'."),
});

/** Octane's manual-test script DSL: one step per line, '-' prefix, '?' for validation, '@' for calls. */
export function stepsToScript(steps: Array<z.infer<typeof stepSchema>>): string {
  return steps
    .map((s) => {
      const text = s.text.replace(/\r?\n/g, " ").trim();
      if (s.type === "validation") return `- ?${text}`;
      if (s.type === "call") return `- @${text}`;
      return `- ${text}`;
    })
    .join("\n");
}

export function scriptToSteps(script: string): Array<{ type: string; text: string }> {
  return script
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.startsWith("-"))
    .map((l) => {
      const body = l.replace(/^-\s*/, "");
      if (body.startsWith("?")) return { type: "validation", text: body.slice(1).trim() };
      if (body.startsWith("@")) return { type: "call", text: body.slice(1).trim() };
      return { type: "step", text: body };
    });
}

export function registerTestTools(server: McpServer, ctx: Ctx): void {
  defineTool(server, ctx, {
    name: "test_get_script",
    title: "Get manual test steps",
    description: "Read the steps of a manual test (or the Gherkin script of a BDD test) as structured steps plus the raw script.",
    schema: {
      test_id: z.string().describe("Test id."),
      ...scopeShape,
    },
    handler: async (a) => {
      const scope = scopeOf(a);
      const [test, script] = await Promise.all([
        ctx.client.get("tests", a.test_id, ["id", "name", "subtype", "phase", "owner", "description", "covered_content"], scope),
        ctx.client.getScript(a.test_id, scope),
      ]);
      if (!test) return null;
      const raw = script?.script ?? "";
      const gherkin = String(test.subtype) === "test_gherkin";
      return {
        test: compactEntity(test),
        steps: gherkin ? undefined : scriptToSteps(raw),
        script: raw,
        last_modified: script?.last_modified,
      };
    },
  });

  defineTool(server, ctx, {
    name: "test_set_script",
    title: "Replace manual test steps",
    description:
      "Replace ALL steps of a manual test. Pass structured steps (step / validation / call) or a raw script in Octane's DSL " +
      "('- step', '- ?validation', '- @<test id>' call, '![file.png]' attachment reference). Existing steps are overwritten, so include the ones to keep.",
    schema: {
      test_id: z.string().describe("Manual test id."),
      steps: z.array(stepSchema).optional().describe("Structured steps, in order."),
      script: z.string().optional().describe("Raw script instead of steps."),
      comment: z.string().optional().describe("Revision comment."),
      revision: z.enum(["Major", "Minor"]).optional().describe("Revision type. Default Minor."),
      ...scopeShape,
    },
    write: true,
    handler: async (a) => {
      if (!a.steps && a.script === undefined) throw new Error("Provide steps or script.");
      const script = a.script ?? stepsToScript(a.steps ?? []);
      await ctx.client.putScript(a.test_id, { script, comment: a.comment, revision_type: a.revision }, scopeOf(a));
      return { test_id: a.test_id, steps: scriptToSteps(script).length, script };
    },
  });

  defineTool(server, ctx, {
    name: "test_create",
    title: "Create a test",
    description:
      "Create a manual, Gherkin or suite test in one call: name, description, steps or Gherkin script, owner, and the stories/requirements it covers. " +
      "Manual steps are written through the script endpoint after creation.",
    schema: {
      name: z.string().describe("Test name."),
      type: z.enum(["manual", "gherkin", "suite"]).optional().describe("Default manual."),
      description: z.string().optional(),
      steps: z.array(stepSchema).optional().describe("Manual tests: steps in order."),
      script: z.string().optional().describe("Gherkin tests: the feature file text. Manual tests: raw step script instead of steps."),
      owner: z.string().optional().describe("Owner by email, name, id or '@me'."),
      covers: z.array(z.string()).optional().describe("Ids of stories, features, defects or requirements this test covers."),
      application_modules: z.array(z.string()).optional().describe("Application module names or ids to tag."),
      phase: z.string().optional().describe("Initial phase by name, e.g. 'Ready'. Default is the type's first phase."),
      fields: z.record(z.string(), z.unknown()).optional().describe("Any other fields (UDFs...)."),
      ...scopeShape,
    },
    write: true,
    handler: async (a) => {
      const scope = scopeOf(a);
      const type = a.type ?? "manual";
      const resource = type === "manual" ? "manual_tests" : type === "gherkin" ? "gherkin_tests" : "test_suites";
      const subtype = type === "manual" ? "test_manual" : type === "gherkin" ? "test_gherkin" : "test_suite";
      const data: Record<string, unknown> = { name: a.name };
      if (a.description) data.description = a.description;
      if (a.owner) data.owner = refOf(await ctx.resolvers.user(a.owner, scope));
      if (a.phase) data.phase = refOf(await ctx.resolvers.phase(subtype, a.phase, scope));
      if (type === "gherkin" && a.script) data.script = a.script;
      if (a.covers?.length) {
        const refs = [];
        for (const id of a.covers) {
          const wi = await ctx.client.get("work_items", id, ["id", "subtype"], scope);
          if (wi) refs.push({ type: String(wi.subtype ?? "work_item"), id });
          else {
            const req = await ctx.client.get("requirements", id, ["id", "subtype"], scope);
            if (!req) throw new Error(`covers: ${id} is neither a work item nor a requirement in this workspace.`);
            refs.push({ type: String(req.subtype ?? "requirement"), id });
          }
        }
        const workItems = refs.filter((r) => !String(r.type).startsWith("requirement"));
        const requirements = refs.filter((r) => String(r.type).startsWith("requirement"));
        if (workItems.length) data.covered_content = { data: workItems };
        if (requirements.length) data.covered_requirement = { data: requirements };
      }
      if (a.application_modules?.length) {
        const mods = [];
        for (const m of a.application_modules) mods.push(refOf(await ctx.resolvers.byName("application_modules", m, scope)));
        data.product_areas = { data: mods };
      }
      if (a.fields) Object.assign(data, await ctx.resolvers.normalizePayload(subtype, a.fields, scope));

      const [created] = await ctx.client.create(resource, data, scope);
      const id = String(created.id);
      let steps: number | undefined;
      if (type === "manual" && (a.steps?.length || a.script)) {
        const script = a.script ?? stepsToScript(a.steps ?? []);
        await ctx.client.putScript(id, { script, comment: "Created via octane-mcp", revision_type: "Major" }, scope);
        steps = scriptToSteps(script).length;
      }
      return { created: compactEntity(created), steps };
    },
  });

  defineTool(server, ctx, {
    name: "test_suite_set_tests",
    title: "Set the tests in a suite",
    description:
      "Add tests to a test suite, or replace its full list. Octane replaces the suite's links on every write, so 'add' mode reads the " +
      "current tests first and re-sends them plus the new ones. Also lists the suite's current tests when called with no changes.",
    schema: {
      suite_id: z.string().describe("Test suite id."),
      add: z.array(z.string()).optional().describe("Test ids to add."),
      remove: z.array(z.string()).optional().describe("Test ids to remove."),
      replace_with: z.array(z.string()).optional().describe("Exact list of test ids the suite should contain (overrides add/remove)."),
      ...scopeShape,
    },
    write: true,
    handler: async (a) => {
      const scope = scopeOf(a);
      const current = await ctx.client.listAll("test_suite_link_to_tests", {
        query: `test_suite EQ {id EQ ${a.suite_id}}`,
        fields: ["id", "test", "order"],
        scope,
        max: 2000,
      });
      const currentIds = current.data.map((l) => String((l.test as Entity).id));
      let target: string[] | undefined;
      if (a.replace_with) target = a.replace_with;
      else if (a.add?.length || a.remove?.length) {
        const removeSet = new Set(a.remove ?? []);
        target = [...currentIds.filter((id) => !removeSet.has(id)), ...(a.add ?? []).filter((id) => !currentIds.includes(id))];
      }
      if (!target) return { suite_id: a.suite_id, tests: currentIds };
      // Octane: posting links replaces the suite's existing links.
      const links = target.map((id) => ({ test_suite: { type: "test", id: a.suite_id }, test: { type: "test", id } }));
      if (links.length) await ctx.client.create("test_suite_link_to_tests", links, scope);
      else for (const l of current.data) await ctx.client.delete("test_suite_link_to_tests", String(l.id), scope);
      return { suite_id: a.suite_id, before: currentIds, after: target };
    },
  });

  defineTool(server, ctx, {
    name: "run_create",
    title: "Create a test run",
    description:
      "Plan or record a run of a manual test or a test suite against a release (and optionally sprint, environment tags, owner). " +
      "Status by name: 'Planned', 'Passed', 'Failed', 'Blocked', 'Skipped', 'In Progress'. For manual runs the steps are generated so " +
      "run_record_results can fill them in.",
    schema: {
      test_id: z.string().describe("Manual test or test suite id."),
      release: z.string().describe("Release by name or id."),
      name: z.string().optional().describe("Run name. Default: the test name."),
      status: z.string().optional().describe("Run status by name. Default Planned."),
      sprint: z.string().optional().describe("Sprint by name or id."),
      owner: z.string().optional().describe("Run owner / tester by email, name, id or '@me'."),
      fields: z.record(z.string(), z.unknown()).optional().describe("Other run fields (environment taxonomies, UDFs...)."),
      ...scopeShape,
    },
    write: true,
    handler: async (a) => {
      const scope = scopeOf(a);
      const test = await ctx.resolvers.test(a.test_id, scope);
      const isSuite = test.type === "test_suite";
      const resource = isSuite ? "suite_run" : "manual_runs";
      const subtype = isSuite ? "run_suite" : "run_manual";
      const data: Record<string, unknown> = {
        name: a.name ?? test.name ?? `Run of ${a.test_id}`,
        test: { type: test.type, id: test.id },
        release: refOf(await ctx.resolvers.byName("releases", a.release, scope)),
        native_status: refOf(await ctx.resolvers.listValueForField(subtype, "native_status", a.status ?? "Planned", scope)),
      };
      if (a.sprint) data.sprint = refOf(await ctx.resolvers.byName("sprints", a.sprint, scope));
      if (a.owner) data.run_by = refOf(await ctx.resolvers.user(a.owner, scope));
      if (a.fields) Object.assign(data, await ctx.resolvers.normalizePayload(subtype, a.fields, scope));
      const [run] = await ctx.client.create(resource, data, scope);
      let steps: unknown;
      if (!isSuite) {
        try {
          await ctx.client.generateRunSteps(String(run.id), scope);
          const rs = await ctx.client.list("run_steps", { query: `run EQ {id EQ ${run.id}}`, fields: ["id", "name", "description", "status"], orderBy: "id", limit: 500, scope });
          steps = compactList(rs);
        } catch (e) {
          steps = { warning: `Run created but steps could not be generated: ${(e as Error).message}` };
        }
      }
      return { run: compactEntity(run), steps };
    },
  });

  defineTool(server, ctx, {
    name: "run_record_results",
    title: "Record run results",
    description:
      "Set the result of a run and optionally each of its steps. Step results are matched by step id or 1-based position. " +
      "Statuses by name: Passed, Failed, Blocked, Skipped, Not Completed. Optionally attach a defect to the run.",
    schema: {
      run_id: z.string().describe("Run id."),
      status: z.string().optional().describe("Overall run status by name."),
      steps: z.array(z.object({
        step: z.union([z.string(), z.number()]).describe("Run step id, or 1-based position."),
        status: z.string().describe("Step status by name."),
        actual: z.string().optional().describe("Actual result text."),
      })).optional(),
      link_defect: z.string().optional().describe("Defect id to link to this run."),
      ...scopeShape,
    },
    write: true,
    handler: async (a) => {
      const scope = scopeOf(a);
      const run = await ctx.client.get("runs", a.run_id, ["id", "name", "subtype", "native_status", "test"], scope);
      if (!run) throw new Error(`Run ${a.run_id} not found.`);
      const subtype = String(run.subtype ?? "run_manual");
      const out: Record<string, unknown> = {};

      if (a.steps?.length) {
        const existing = await ctx.client.list("run_steps", { query: `run EQ {id EQ ${a.run_id}}`, fields: ["id", "name", "status"], orderBy: "id", limit: 500, scope });
        const updates = [];
        for (const s of a.steps) {
          const id = typeof s.step === "number" || /^\d{1,3}$/.test(String(s.step))
            ? String(existing.data[Number(s.step) - 1]?.id ?? s.step)
            : String(s.step);
          const status = await ctx.resolvers.listValueForField("run_step", "status", s.status, scope);
          const u: Record<string, unknown> & { id: string } = { id, status: refOf(status) };
          if (s.actual !== undefined) u.actual_result = s.actual;
          updates.push(u);
        }
        const updated = await ctx.client.bulkUpdate("run_steps", updates, scope);
        out.steps_updated = updated.length;
      }

      if (a.status) {
        const st = await ctx.resolvers.listValueForField(subtype, "native_status", a.status, scope);
        const updated = await ctx.client.update("runs", a.run_id, { native_status: refOf(st) }, scope);
        out.run = compactEntity(updated);
      }

      if (a.link_defect) {
        // Defects link to runs through the run's `defects`-style relation; the exact
        // field varies by version, so fall back to a comment if the relation is rejected.
        try {
          await ctx.client.update("defects", a.link_defect, { run: { type: "run", id: a.run_id } }, scope);
          out.linked_defect = a.link_defect;
        } catch {
          await ctx.client.create("comments", { text: `Related to defect #${a.link_defect}`, owner_run: { type: "run", id: a.run_id } }, scope);
          out.linked_defect = `${a.link_defect} (recorded as a comment; direct link field not available)`;
        }
      }
      return out;
    },
  });
}

function refOf(r: { type: string; id: string }): { type: string; id: string } {
  return { type: r.type, id: r.id };
}
