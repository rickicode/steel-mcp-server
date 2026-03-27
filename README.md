# Steel MCP Server

A Model Context Protocol (MCP) server for browser automation with Steel and Puppeteer.

It exposes browser automation, screenshots, session tools, and Steel quick actions over HTTP.

The MCP image is published to GHCR, so users can run it with Docker Compose without cloning the repo.

## Add MCP

Use this MCP URL:

```text
http://localhost:8787/mcp
```

Add it to your client config:

```json
{
  "mcpServers": {
    "steel-browser": {
      "url": "http://localhost:8787/mcp"
    }
  }
}
```

Make sure the Steel Browser stack is running before connecting.

For full setup and usage, see [docs.md](./docs.md).
