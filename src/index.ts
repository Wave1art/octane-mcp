import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { applyEnvFile, ConfigError, loadConfig } from "./config.js";
import { createServer, VERSION } from "./server.js";

const HELP = `octane-mcp ${VERSION} — MCP server for OpenText ALM Octane / Core SDP

Usage:
  npx octane-mcp [--env-file <path>] [--read-only]

Options:
  --env-file <path>   Load variables from a .env file (does not override existing env).
  --read-only         Register only read tools (same as OCTANE_READ_ONLY=true).
  --check             Sign in, print the current user and workspace, then exit.
  --help, --version

Environment:
  OCTANE_BASE_URL, OCTANE_SHARED_SPACE_ID, OCTANE_WORKSPACE_ID
  OCTANE_CLIENT_ID + OCTANE_CLIENT_SECRET   or   OCTANE_USERNAME + OCTANE_PASSWORD
  OCTANE_VERIFY_SSL=false | OCTANE_CA_CERT=<pem>   TLS for internal networks
  OCTANE_READ_ONLY, OCTANE_TECH_PREVIEW, OCTANE_CURRENT_USER, OCTANE_UDF_ALIASES, OCTANE_TIMEOUT_MS
  HTTPS_PROXY / NO_PROXY are honoured.

Docs: https://github.com/Wave1art/octane-mcp
`;

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  if (argv.includes("--help") || argv.includes("-h")) {
    process.stdout.write(HELP);
    return;
  }
  if (argv.includes("--version") || argv.includes("-v")) {
    process.stdout.write(`${VERSION}\n`);
    return;
  }

  const envIdx = argv.indexOf("--env-file");
  if (envIdx >= 0) {
    const file = argv[envIdx + 1];
    if (!file) throw new ConfigError("--env-file needs a path");
    const path = resolve(file);
    if (!existsSync(path)) throw new ConfigError(`--env-file: ${path} does not exist`);
    applyEnvFile(path, process.env);
  } else if (existsSync(resolve(".env")) && !process.env.OCTANE_BASE_URL) {
    applyEnvFile(resolve(".env"), process.env);
  }
  if (argv.includes("--read-only")) process.env.OCTANE_READ_ONLY = "true";

  const cfg = loadConfig(process.env);
  const { server, ctx } = createServer(cfg);

  if (argv.includes("--check")) {
    const me = await ctx.resolvers.currentUser();
    const ws = await ctx.client.listWorkspaces();
    const current = ws.data.find((w) => String(w.id) === cfg.workspaceId);
    process.stdout.write(
      JSON.stringify(
        {
          base_url: cfg.baseUrl,
          shared_space_id: cfg.sharedSpaceId,
          workspace: current ? { id: current.id, name: current.name } : { id: cfg.workspaceId, warning: "not visible in this shared space" },
          current_user: me,
          verify_ssl: cfg.verifySsl,
          read_only: cfg.readOnly,
        },
        null,
        2,
      ) + "\n",
    );
    await ctx.client.signOut();
    return;
  }

  const transport = new StdioServerTransport();
  await server.connect(transport);

  const shutdown = async () => {
    await ctx.client.signOut().catch(() => undefined);
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
  process.stdin.on("close", shutdown);
}

main().catch((e) => {
  const msg = e instanceof ConfigError ? e.message : e instanceof Error ? `${e.message}` : String(e);
  process.stderr.write(`octane-mcp: ${msg}\n`);
  process.exit(1);
});
