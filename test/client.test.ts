import { describe, expect, it } from "vitest";
import { OctaneClient, OctaneError } from "../src/client.js";
import type { OctaneConfig } from "../src/config.js";

const cfg: OctaneConfig = {
  baseUrl: "https://octane.test",
  sharedSpaceId: "1001",
  workspaceId: "1002",
  auth: { kind: "apikey", clientId: "id", clientSecret: "secret" },
  verifySsl: true,
  techPreview: true,
  readOnly: false,
  udfAliases: {},
  timeoutMs: 5000,
};

interface Call { method: string; url: string; headers: Record<string, string>; body?: string }

/** A tiny scripted fetch: each handler receives the call and returns a Response. */
function fakeFetch(handlers: Array<(c: Call) => Response>) {
  const calls: Call[] = [];
  const fn = async (input: URL | string, init: RequestInit & { body?: unknown } = {}) => {
    const call: Call = {
      method: init.method ?? "GET",
      url: String(input),
      headers: (init.headers as Record<string, string>) ?? {},
      body: typeof init.body === "string" ? init.body : undefined,
    };
    calls.push(call);
    const h = handlers.shift();
    if (!h) throw new Error(`Unexpected request ${call.method} ${call.url}`);
    return h(call);
  };
  return { fn: fn as unknown as NonNullable<ConstructorParameters<typeof OctaneClient>[1]>["fetch"], calls };
}

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });

const signInOk = () => json({}, 200, { "set-cookie": "LWSSO_COOKIE_KEY=abc; Path=/; HttpOnly" });

describe("OctaneClient", () => {
  it("signs in once, replays cookies and sends tech-preview header", async () => {
    const { fn, calls } = fakeFetch([
      signInOk,
      () => json({ total_count: 1, data: [{ id: "1", type: "defect" }] }),
      () => json({ total_count: 1, data: [{ id: "1", type: "defect" }] }),
    ]);
    const c = new OctaneClient(cfg, { fetch: fn });
    await c.list("defects", { query: "id EQ 1", fields: ["id", "name"], limit: 10 });
    await c.list("defects");
    expect(calls[0].url).toBe("https://octane.test/authentication/sign_in");
    expect(JSON.parse(calls[0].body!)).toEqual({ client_id: "id", client_secret: "secret" });
    const url = new URL(calls[1].url);
    expect(url.pathname).toBe("/api/shared_spaces/1001/workspaces/1002/defects");
    expect(url.searchParams.get("query")).toBe('"id EQ 1"');
    expect(url.searchParams.get("fields")).toBe("id,name");
    expect(url.searchParams.get("limit")).toBe("10");
    expect(calls[1].headers.Cookie).toBe("LWSSO_COOKIE_KEY=abc");
    expect(calls[1].headers["ALM-OCTANE-TECH-PREVIEW"]).toBe("true");
    expect(calls.length).toBe(3);
  });

  it("re-authenticates once on 401 and retries", async () => {
    const { fn, calls } = fakeFetch([
      signInOk,
      () => json({ error_code: "expired" }, 401),
      () => json({}, 200, { "set-cookie": "LWSSO_COOKIE_KEY=new; Path=/" }),
      () => json({ id: "5", name: "x" }),
    ]);
    const c = new OctaneClient(cfg, { fetch: fn });
    const e = await c.get("defects", "5");
    expect(e).toEqual({ id: "5", name: "x" });
    expect(calls[3].headers.Cookie).toBe("LWSSO_COOKIE_KEY=new");
  });

  it("returns null for a GET 404 but throws for write 404s", async () => {
    const { fn } = fakeFetch([signInOk, () => json({ description: "nope" }, 404), () => json({ description: "nope" }, 404)]);
    const c = new OctaneClient(cfg, { fetch: fn });
    expect(await c.get("defects", "999")).toBeNull();
    await expect(c.update("defects", "999", { name: "x" })).rejects.toThrow(OctaneError);
  });

  it("surfaces per-entity errors returned with HTTP 200", async () => {
    const { fn } = fakeFetch([
      signInOk,
      () => json({ total_count: 0, data: [], errors: [{ description: "Field 'foo' does not exist", error_code: "platform.unknown_field" }] }),
    ]);
    const c = new OctaneClient(cfg, { fetch: fn });
    await expect(c.create("defects", { foo: 1 })).rejects.toThrow(/Field 'foo' does not exist/);
  });

  it("formats Octane error bodies", async () => {
    const { fn } = fakeFetch([signInOk, () => json({ description_translated: "Phase transition not allowed", error_code: "platform.rule" }, 400)]);
    const c = new OctaneClient(cfg, { fetch: fn });
    await expect(c.update("defects", "1", { phase: {} })).rejects.toThrow(/400: Phase transition not allowed \| platform.rule/);
  });

  it("wraps create payloads in data arrays and uses PUT for bulk updates", async () => {
    const { fn, calls } = fakeFetch([signInOk, () => json({ data: [{ id: "1" }] }), () => json({ data: [{ id: "1" }, { id: "2" }] })]);
    const c = new OctaneClient(cfg, { fetch: fn });
    await c.create("defects", { name: "a" });
    await c.bulkUpdate("defects", [{ id: "1", name: "b" }, { id: "2", name: "c" }]);
    expect(JSON.parse(calls[1].body!)).toEqual({ data: [{ name: "a" }] });
    expect(calls[2].method).toBe("PUT");
    expect(new URL(calls[2].url).pathname).toBe("/api/shared_spaces/1001/workspaces/1002/defects");
  });

  it("pages through listAll until total_count", async () => {
    const page = (ids: number[], total: number) => json({ total_count: total, data: ids.map((id) => ({ id: String(id) })) });
    const { fn, calls } = fakeFetch([signInOk, () => page([1, 2], 3), () => page([3], 3)]);
    const c = new OctaneClient(cfg, { fetch: fn });
    const r = await c.listAll("defects", { max: 10 });
    expect(r.data.map((d) => d.id)).toEqual(["1", "2", "3"]);
    expect(new URL(calls[2].url).searchParams.get("offset")).toBe("2");
  });

  it("honours per-call scope overrides", async () => {
    const { fn, calls } = fakeFetch([signInOk, () => json({ total_count: 0, data: [] })]);
    const c = new OctaneClient(cfg, { fetch: fn });
    await c.list("stories", { scope: { sharedSpaceId: "2001", workspaceId: "3001" } });
    expect(new URL(calls[1].url).pathname).toBe("/api/shared_spaces/2001/workspaces/3001/stories");
  });

  it("writes scripts through the tests collection", async () => {
    const { fn, calls } = fakeFetch([signInOk, () => json({})]);
    const c = new OctaneClient(cfg, { fetch: fn });
    await c.putScript("77", { script: "- step" });
    expect(calls[1].method).toBe("PUT");
    expect(new URL(calls[1].url).pathname).toBe("/api/shared_spaces/1001/workspaces/1002/tests/77/script");
    expect(JSON.parse(calls[1].body!)).toEqual({ script: "- step", comment: "", revision_type: "Minor" });
  });

  it("explains failed sign-in", async () => {
    const { fn } = fakeFetch([() => json({ description: "bad credentials" }, 401)]);
    const c = new OctaneClient(cfg, { fetch: fn });
    await expect(c.list("defects")).rejects.toThrow(/sign-in failed.*bad credentials/);
  });
});
