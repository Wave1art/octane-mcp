# octane-mcp

An [MCP](https://modelcontextprotocol.io) server for **OpenText ALM Octane** and **OpenText Core Software Delivery Platform** (formerly ValueEdge).
Node only. No Python, no install step: run it with `npx`.

```json
{
  "mcpServers": {
    "octane": {
      "command": "npx",
      "args": ["-y", "octane-mcp"],
      "env": {
        "OCTANE_BASE_URL": "https://octane.example.com:8443",
        "OCTANE_SHARED_SPACE_ID": "1001",
        "OCTANE_WORKSPACE_ID": "1002",
        "OCTANE_CLIENT_ID": "your_api_key_id",
        "OCTANE_CLIENT_SECRET": "your_api_key_secret"
      }
    }
  }
}
```

That block works in Claude Desktop (`claude_desktop_config.json`), Claude Code (`claude mcp add-json octane '<that json>'`),
Cursor, Windsurf and VS Code (`.vscode/mcp.json` uses `"servers"` instead of `"mcpServers"` and `"type": "stdio"`).

## Why another Octane MCP server

Octane's REST API is metadata driven and full of ids: phases, list nodes, workspace users, reference types.
Most of what an assistant gets wrong is guessing those. This server:

- **Accepts names everywhere.** `owner: "jane@x.com"`, `phase: "Fixed"`, `severity: "High"`, `release: "R26.3"`, `@me`.
  Names are resolved to `{type, id}` through live metadata and cached per workspace.
- **Translates natural filters** (`phase = 'New' and owner = @me and creation_time >= '2026-09-01'`) into Octane OQL,
  including `!=`, `>=`, `in`, `between`, `~` contains, `null` and nested references.
- **Covers the testing side**, not just backlog: manual test steps, Gherkin scripts, suites, planned and executed runs,
  run step results, attachments, traceability and release status rollups.
- **Returns compact output.** References shrink to `{id, name}`, HTML memos become text, noise fields are dropped.
  Ask for `raw: true` when you need everything.
- **Fails loudly.** Octane's HTTP 200 "partial error" responses, write 404s and 400s are surfaced with the server's
  own message and a hint about which tool to call next.
- **Is honest about writes.** Every tool carries MCP annotations; `OCTANE_READ_ONLY=true` removes write tools entirely.

## Tools

| Area | Tools |
|---|---|
| Any entity | `octane_search` `octane_get` `octane_create` `octane_update` `octane_bulk_update` `octane_delete` |
| Discovery | `octane_describe` (fields and operations) `octane_lookup` (phases, list values, users, releases, sprints, teams, modules) `octane_scopes` (spaces, workspaces, who am I) |
| Backlog | `work_item_triage` (phase, severity, owner, sprint and a comment in one call) `backlog_bulk_update` `work_item_tree` `octane_comment` |
| Testing | `test_create` `test_get_script` `test_set_script` `test_suite_set_tests` `run_create` `run_record_results` |
| Files | `attachment_upload` `attachment_download` |
| Insight | `release_status` `traceability` `octane_history` |

Resources: `octane://guide/query` (filter syntax) and `octane://schema/{entity}`.

Every tool takes optional `workspace_id` and `shared_space_id` to act on another workspace with the same session.

## Configuration

| Variable | Purpose |
|---|---|
| `OCTANE_BASE_URL` | `https://host:port`, no trailing path. |
| `OCTANE_SHARED_SPACE_ID`, `OCTANE_WORKSPACE_ID` | Default scope. Discover others with `octane_scopes`. |
| `OCTANE_CLIENT_ID` + `OCTANE_CLIENT_SECRET` | API access key (Settings > Spaces > API Access). Preferred; required for SSO/SaaS. |
| `OCTANE_USERNAME` + `OCTANE_PASSWORD` | Alternative to the API key. |
| `OCTANE_CA_CERT` | Path to a PEM bundle for an internal CA. Preferred fix for self-signed certificates. |
| `OCTANE_VERIFY_SSL` | `false` disables certificate verification **for this server's connections only**. Default `true`. |
| `HTTPS_PROXY`, `HTTP_PROXY`, `NO_PROXY` | Honoured (Node's fetch ignores them by default; this server does not). |
| `OCTANE_READ_ONLY` | `true` hides every tool that writes. Also `--read-only`. |
| `OCTANE_TECH_PREVIEW` | Send `ALM-OCTANE-TECH-PREVIEW: true`. Default `true`; needed for `octane_history`. |
| `OCTANE_CURRENT_USER` | Your email or full name, used for `@me` when the server cannot detect the signed-in user. |
| `OCTANE_UDF_ALIASES` | JSON map of friendly names to instance fields, e.g. `{"acceptance_criteria":"acceptance_criteria_udf"}`. |
| `OCTANE_TIMEOUT_MS` | Request timeout. Default 30000. |

You can also keep these in a file and pass `--env-file /path/to/.env`. A `.env` in the current directory is picked up automatically.

### Internal networks and self-signed certificates

Prefer the CA bundle: export the corporate root certificate as PEM and set `OCTANE_CA_CERT`. Verification stays on and
the chain validates. If that is not possible, `OCTANE_VERIFY_SSL=false` turns verification off. This is applied to the
undici dispatcher used by this server, never through `NODE_TLS_REJECT_UNAUTHORIZED`, so other TLS connections in the
same process are unaffected.

### Check the connection

```bash
npx octane-mcp --check --env-file ~/.octane.env
```

Signs in, prints the workspace name and the resolved current user, signs out.

## Writing filters

```
phase = 'New' and severity in ('High', 'Urgent')
owner = @me and sprint = null
creation_time >= '2026-09-01' and not phase = 'Closed'
parent = 1001                       # children of feature 1001
name ~ 'timeout'                    # contains
release = {name ~ '26.3'}           # explicit nested reference
```

Native Octane OQL (`phase EQ {name EQ ^New^};owner EQ {id EQ 1002}`) is accepted unchanged.
The full guide is served as the `octane://guide/query` resource.

## Development

```bash
npm install
npm test            # vitest, no Octane needed
npm run typecheck
npm run build       # single-file bundle in dist/
node dist/index.js --help
```

Tests run against a scripted fake of Octane's HTTP responses; nothing talks to a real server.

## Credits and licence

MIT. See [LICENSE](LICENSE).

The idea and much of the initial tool inventory were inspired by Robin Hermanek's Python server
[rhermanek/mcp_alm_octane](https://github.com/rhermanek/mcp_alm_octane) (GPL-3.0). This project is an independent
implementation in TypeScript and shares no code with it, but it would not have started without that reference.

API behaviour follows the official
[ALM Octane REST API documentation](https://admhelp.microfocus.com/octane/en/latest/Online/Content/API/articles_API2.htm).
