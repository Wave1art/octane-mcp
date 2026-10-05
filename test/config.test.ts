import { describe, expect, it } from "vitest";
import { ConfigError, loadConfig, parseEnvFile } from "../src/config.js";

const base = {
  OCTANE_BASE_URL: "https://octane.example.com:8443/",
  OCTANE_SHARED_SPACE_ID: "1001",
  OCTANE_WORKSPACE_ID: "1002",
  OCTANE_CLIENT_ID: "id",
  OCTANE_CLIENT_SECRET: "secret",
};

describe("loadConfig", () => {
  it("loads api key config with secure defaults", () => {
    const c = loadConfig({ ...base });
    expect(c.baseUrl).toBe("https://octane.example.com:8443");
    expect(c.auth).toEqual({ kind: "apikey", clientId: "id", clientSecret: "secret" });
    expect(c.verifySsl).toBe(true);
    expect(c.techPreview).toBe(true);
    expect(c.readOnly).toBe(false);
    expect(c.timeoutMs).toBe(30_000);
  });

  it("supports username/password", () => {
    const { OCTANE_CLIENT_ID: _a, OCTANE_CLIENT_SECRET: _b, ...rest } = base;
    const c = loadConfig({ ...rest, OCTANE_USERNAME: "u", OCTANE_PASSWORD: "p" });
    expect(c.auth).toEqual({ kind: "password", username: "u", password: "p" });
  });

  it("lists every missing variable", () => {
    expect(() => loadConfig({})).toThrow(ConfigError);
    expect(() => loadConfig({})).toThrow(/OCTANE_BASE_URL, OCTANE_SHARED_SPACE_ID, OCTANE_WORKSPACE_ID, OCTANE_CLIENT_ID/);
  });

  it("parses TLS, read-only and alias options", () => {
    const c = loadConfig({ ...base, OCTANE_VERIFY_SSL: "false", OCTANE_CA_CERT: "/ca.pem", OCTANE_READ_ONLY: "yes", OCTANE_UDF_ALIASES: '{"acceptance_criteria":"ac_udf"}' });
    expect(c.verifySsl).toBe(false);
    expect(c.caCertPath).toBe("/ca.pem");
    expect(c.readOnly).toBe(true);
    expect(c.udfAliases).toEqual({ acceptance_criteria: "ac_udf" });
  });

  it("rejects bad booleans and aliases", () => {
    expect(() => loadConfig({ ...base, OCTANE_VERIFY_SSL: "maybe" })).toThrow(/true or false/);
    expect(() => loadConfig({ ...base, OCTANE_UDF_ALIASES: "[1]" })).toThrow(/JSON object/);
  });
});

describe("parseEnvFile", () => {
  it("parses quotes, comments and export", () => {
    const parsed = parseEnvFile(`
# comment
export A=1
B="two words" # trailing
C='=starts-with-equals'
D=plain # comment
E=
`);
    expect(parsed).toEqual({ A: "1", B: "two words", C: "=starts-with-equals", D: "plain", E: "" });
  });
});
