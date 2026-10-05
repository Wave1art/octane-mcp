import { readFileSync } from "node:fs";

export type OctaneAuth =
  | { kind: "apikey"; clientId: string; clientSecret: string }
  | { kind: "password"; username: string; password: string };

export interface OctaneConfig {
  baseUrl: string;
  sharedSpaceId: string;
  workspaceId: string;
  auth: OctaneAuth;
  /** Verify the server certificate. Default true. */
  verifySsl: boolean;
  /** Optional PEM bundle for an internal CA. */
  caCertPath?: string;
  /** Send ALM-OCTANE-TECH-PREVIEW: true on every request. Default true. */
  techPreview: boolean;
  /** Register only tools that never write to Octane. */
  readOnly: boolean;
  /** Email or full name used when the server cannot detect the signed-in user. */
  currentUser?: string;
  /** Friendly name -> instance-specific field name, e.g. acceptance_criteria -> acceptance_criteria_udf. */
  udfAliases: Record<string, string>;
  timeoutMs: number;
}

export class ConfigError extends Error {}

const TRUE = new Set(["1", "true", "yes", "on"]);
const FALSE = new Set(["0", "false", "no", "off"]);

function bool(value: string | undefined, fallback: boolean, name: string): boolean {
  if (value === undefined || value === "") return fallback;
  const v = value.trim().toLowerCase();
  if (TRUE.has(v)) return true;
  if (FALSE.has(v)) return false;
  throw new ConfigError(`${name} must be true or false, got "${value}"`);
}

/** Minimal .env parser: KEY=value, optional quotes, # comments, `export ` prefix. */
export function parseEnvFile(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const m = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!m) continue;
    let value = m[2].trim();
    const quote = value[0] === '"' || value[0] === "'" ? value[0] : undefined;
    const close = quote ? value.indexOf(quote, 1) : -1;
    if (quote && close > 0) {
      value = value.slice(1, close);
    } else {
      const hash = value.indexOf(" #");
      if (hash >= 0) value = value.slice(0, hash).trim();
    }
    out[m[1]] = value;
  }
  return out;
}

/** Load a .env file into `env` without overriding variables that are already set. */
export function applyEnvFile(path: string, env: NodeJS.ProcessEnv): void {
  const parsed = parseEnvFile(readFileSync(path, "utf8"));
  for (const [k, v] of Object.entries(parsed)) {
    if (env[k] === undefined || env[k] === "") env[k] = v;
  }
}

export function loadConfig(env: NodeJS.ProcessEnv): OctaneConfig {
  const missing: string[] = [];
  const need = (name: string): string => {
    const v = env[name];
    if (!v) missing.push(name);
    return v ?? "";
  };

  const baseUrl = need("OCTANE_BASE_URL").replace(/\/+$/, "");
  const sharedSpaceId = need("OCTANE_SHARED_SPACE_ID");
  const workspaceId = need("OCTANE_WORKSPACE_ID");

  let auth: OctaneAuth | undefined;
  if (env.OCTANE_CLIENT_ID && env.OCTANE_CLIENT_SECRET) {
    auth = { kind: "apikey", clientId: env.OCTANE_CLIENT_ID, clientSecret: env.OCTANE_CLIENT_SECRET };
  } else if (env.OCTANE_USERNAME && env.OCTANE_PASSWORD) {
    auth = { kind: "password", username: env.OCTANE_USERNAME, password: env.OCTANE_PASSWORD };
  } else {
    missing.push("OCTANE_CLIENT_ID + OCTANE_CLIENT_SECRET (or OCTANE_USERNAME + OCTANE_PASSWORD)");
  }

  if (missing.length) {
    throw new ConfigError(
      `Missing required configuration: ${missing.join(", ")}.\n` +
        "Set them as environment variables in your MCP client config, or pass --env-file <path>.",
    );
  }

  let udfAliases: Record<string, string> = {};
  if (env.OCTANE_UDF_ALIASES) {
    try {
      const parsed = JSON.parse(env.OCTANE_UDF_ALIASES);
      if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new Error("not an object");
      udfAliases = Object.fromEntries(Object.entries(parsed).map(([k, v]) => [k, String(v)]));
    } catch (e) {
      throw new ConfigError(`OCTANE_UDF_ALIASES must be a JSON object: ${(e as Error).message}`);
    }
  }

  const timeoutMs = env.OCTANE_TIMEOUT_MS ? Number(env.OCTANE_TIMEOUT_MS) : 30_000;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new ConfigError("OCTANE_TIMEOUT_MS must be a positive number");

  return {
    baseUrl,
    sharedSpaceId,
    workspaceId,
    auth: auth!,
    verifySsl: bool(env.OCTANE_VERIFY_SSL, true, "OCTANE_VERIFY_SSL"),
    caCertPath: env.OCTANE_CA_CERT || undefined,
    techPreview: bool(env.OCTANE_TECH_PREVIEW, true, "OCTANE_TECH_PREVIEW"),
    readOnly: bool(env.OCTANE_READ_ONLY, false, "OCTANE_READ_ONLY"),
    currentUser: env.OCTANE_CURRENT_USER || undefined,
    udfAliases,
    timeoutMs,
  };
}
