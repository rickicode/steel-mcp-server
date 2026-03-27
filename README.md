# Steel MCP Server

Install Steel Browser MCP in minutes with Docker and connect via an HTTP MCP endpoint.

## Getting Started

### Quick Install Links

[<img src="https://img.shields.io/badge/Compose%20Only-111827?style=flat-square&label=Install%20Server&color=111827" alt="Compose only install">](#install-docker)
[<img src="https://img.shields.io/badge/Codex-000000?style=flat-square&label=Add%20MCP&color=000000" alt="Add to Codex">](#codex)
[<img src="https://img.shields.io/badge/Claude%20Code-ffb000?style=flat-square&label=Add%20MCP&color=ffb000" alt="Add to Claude Code">](#claude-code)
[<img src="https://img.shields.io/badge/Claude%20Desktop-ff6b6b?style=flat-square&label=Add%20MCP&color=ff6b6b" alt="Add to Claude Desktop">](#claude-desktop)
[<img src="https://img.shields.io/badge/OpenCode-3b82f6?style=flat-square&label=Add%20MCP&color=3b82f6" alt="Add to OpenCode">](#opencode)
[<img src="https://img.shields.io/badge/Antigravity-8b5cf6?style=flat-square&label=Add%20MCP&color=8b5cf6" alt="Add to Antigravity">](#antigravity)

<a id="install-docker"></a>
## Install (Docker)

Requires Docker + Compose. No repo clone needed.

Start the bundled Steel Browser stack and MCP server:

```bash
docker compose up -d
```

The compose stack exposes:

- Steel Browser API: `http://localhost:3000`
- Steel Browser UI: `http://localhost:5171`
- MCP server: `http://localhost:8787/mcp`

If you want Docker-only usage without cloning the repo:

```bash
curl -O https://raw.githubusercontent.com/rickicode/steel-browser-mcp/main/compose.yml
MCP_IMAGE=ghcr.io/rickicode/steel-browser-mcp:latest docker compose up -d
```

## Add MCP

MCP HTTP endpoint:

```text
http://localhost:8787/mcp
```

Standard config:

Add it to your client config:

```json
{
  "mcpServers": {
    "steel-browser": {
      "type": "http",
      "url": "http://localhost:8787/mcp"
    }
  }
}
```

Make sure the Steel Browser stack is running before connecting.

## Client Setup

<a id="codex"></a>
<details>
<summary>Codex</summary>

Use `~/.codex/config.toml`:

```toml
[mcp_servers.steel-browser]
url = "http://localhost:8787/mcp"
enabled = true
```

Or add it from the CLI:

```bash
codex mcp add steel-browser http://localhost:8787/mcp
```

</details>

<a id="claude-code"></a>
<details>
<summary>Claude Code</summary>

Use `.mcp.json`:

```json
{
  "mcpServers": {
    "steel-browser": {
      "type": "http",
      "url": "http://localhost:8787/mcp"
    }
  }
}
```

Or add it from the CLI:

```bash
claude mcp add steel-browser http://localhost:8787/mcp --type http
```

</details>

<a id="claude-desktop"></a>
<details>
<summary>Claude Desktop</summary>

Add the standard config above in a connector that supports HTTP MCP. If the server is localhost-only, expose it through a tunnel first.

</details>

<a id="opencode"></a>
<details>
<summary>OpenCode</summary>

Use `~/.config/opencode/opencode.json`:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "mcp": {
    "steel-browser": {
      "type": "remote",
      "url": "http://localhost:8787/mcp",
      "enabled": true
    }
  }
}
```

</details>

<a id="antigravity"></a>
<details>
<summary>Antigravity</summary>

Use the CLI:

```bash
antigravity --add-mcp '{"name":"steel-browser","url":"http://localhost:8787/mcp","type":"http"}'
```

Antigravity also supports file-based configuration under `<repo_root>/.vscode/mcp.json`.

</details>

For technical details, see [docs.md](./docs.md).
