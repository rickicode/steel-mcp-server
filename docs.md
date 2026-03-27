# Steel MCP Server Docs

This document covers API endpoints, environment variables, tool coverage, session management, and troubleshooting.

## Overview

This MCP server wraps Steel Browser with Puppeteer and exposes browser automation over HTTP MCP.

By default, the server is text-first: tool results return text and resources, while inline images are opt-in.

See [README.md](./README.md) for install and client setup.

<a id="verify"></a>
## Verify

Check the health endpoint:

```bash
curl http://localhost:8787/health
```

Then confirm the server responds with the expected tools through your client.

For client setup instructions, see [README.md](./README.md).

## Tools

### Navigation and Session Control

- `navigate`
- `search`
- `reload`
- `go_forward`
- `go_back`
- `stop_loading`
- `wait`
- `session_info`
- `session_reset`

### Scrolling

- `scroll_down`
- `scroll_up`

### Tabs

- `list_tabs`
- `new_tab`
- `switch_tab`
- `close_tab`

New tabs opened by the page are detected automatically and the active tab is switched to the newest page when possible.

### Page State and Extraction

- `get_page_info`
- `get_url`
- `get_title`
- `get_text`
- `get_html`
- `evaluate`

### Label-Based Interaction

- `click`
- `type`
- `save_unmarked_screenshot`

### Steel Quick Actions

- `quick_scrape`
- `quick_screenshot`
- `quick_pdf`

### Selector-Based Interaction

- `click_selector`
- `type_selector`
- `select_option`
- `hover`
- `drag`
- `wait_for_selector`
- `wait_for_url`

### Keyboard and Viewport

- `press_key`
- `set_viewport`

### Storage and Cookies

- `get_cookies`
- `set_cookies`
- `clear_cookies`
- `get_local_storage`
- `set_local_storage`
- `clear_local_storage`

### File and Screenshot Workflows

- `upload_file`
- `screenshot`

## Resources

- `screenshot://RESOURCE_NAME` for stored screenshots
- `pdf://RESOURCE_NAME` for stored PDFs
- `console://logs` for browser console output

Screenshots and PDFs are available after you use `save_unmarked_screenshot`, `screenshot`, `quick_screenshot`, or `quick_pdf` with a `resourceName`.

## Configuration

### Steel Connection

| Variable | Default | Purpose |
| --- | --- | --- |
| `STEEL_API_KEY` | none | Use Steel Cloud when set. |
| `STEEL_BASE_URL` | `https://api.steel.dev` | Use a specific Steel endpoint. If set, local mode is used automatically. |
| `STEEL_SESSION_TIMEOUT_MS` | `900000` | Session timeout in milliseconds. |
| `STEEL_PROFILE_ID` | none | Reuse an existing Steel profile. |
| `STEEL_PERSIST_PROFILE` | `false` | Persist the profile state after the session ends. |
| `STEEL_USE_PROXY` | `false` | Enable Steel-managed proxy routing. |
| `STEEL_PROXY` | none | BYOP proxy config. Accepts a raw proxy URL or a JSON object. |
| `STEEL_SOLVE_CAPTCHA` | none | Ask Steel to enable CAPTCHA solving. |
| `STEEL_USER_AGENT` | none | Set the Puppeteer user agent for pages. |
| `STEEL_AUTO_SCREENSHOT` | `false` | Attach an annotated screenshot after each successful tool call when enabled. |
| `STEEL_INLINE_IMAGES` | `false` | Include inline image data in screenshot tool results when enabled. |

### MCP HTTP Server

| Variable | Default | Purpose |
| --- | --- | --- |
| `MCP_HTTP_HOST` | `127.0.0.1` | HTTP bind host. Use `0.0.0.0` inside Docker. |
| `MCP_HTTP_PORT` | `8787` | HTTP port for the MCP server. |
| `GLOBAL_WAIT_SECONDS` | none | Optional delay after each tool action. |

If both `STEEL_BASE_URL` and `STEEL_API_KEY` are set, `STEEL_BASE_URL` wins.

## Modes

### Local Mode

Use the bundled Steel Browser stack:

```bash
export STEEL_BASE_URL="http://localhost:3000"
```

### Cloud Mode

Use Steel Cloud:

```bash
export STEEL_API_KEY="YOUR_STEEL_API_KEY_HERE"
```

## Session Management

Sessions are created automatically on first tool use and reused until the MCP process exits or the session becomes invalid.

### Session Timeout

Default timeout is 15 minutes. Override it with `STEEL_SESSION_TIMEOUT_MS`.

### Session Tools

Use `session_info` to inspect the current session state:

```text
session_info
```

Use `session_reset` to recreate the browser with the current env-driven settings:

```text
session_reset
```

### Profiles

Use `STEEL_PROFILE_ID` and `STEEL_PERSIST_PROFILE=true` if you want browser state to survive across sessions.

This is useful for:

- auth state
- cookies
- extensions
- browser settings

### Proxy and User Agent

- Set `STEEL_USE_PROXY=true` for Steel-managed proxy routing
- Set `STEEL_PROXY` for a custom proxy
- Set `STEEL_SOLVE_CAPTCHA=true` to request CAPTCHA solving
- Set `STEEL_USER_AGENT` to force a specific browser user agent

## Usage Examples

### Local Stack

```bash
export STEEL_BASE_URL="http://localhost:3000"
export MCP_HTTP_PORT="8787"
```

### Cloud Stack

```bash
export STEEL_API_KEY="YOUR_STEEL_API_KEY_HERE"
export MCP_HTTP_PORT="8787"
```

### Local Stack with Profile

```bash
export STEEL_BASE_URL="http://localhost:3000"
export STEEL_PROFILE_ID="profile_123"
export STEEL_PERSIST_PROFILE="true"
```

### Cloud Stack with Proxy

```bash
export STEEL_API_KEY="YOUR_STEEL_API_KEY_HERE"
export STEEL_USE_PROXY="true"
export STEEL_PROXY="http://user:pass@host:port"
export STEEL_SOLVE_CAPTCHA="true"
```

## Troubleshooting

1. Confirm `docker compose up -d` completed successfully.
2. Check `http://localhost:8787/health` if the MCP server does not respond.
3. Use `session_reset` after changing session-related env vars.
4. Make sure `STEEL_BASE_URL` points to the correct Steel endpoint for local mode.
5. If screenshots or overlays look wrong, check browser viewport size and available memory.
6. Large, image-heavy pages can slow down after many browser actions.

## Notes

- The MCP server is HTTP-based.
- The Steel Browser backend still runs in Docker via the bundled compose file.
- The README intentionally stays short and only covers what the project is and how to add the MCP server.

## Disclaimer

This project is experimental and based on the Web Voyager codebase. Use it in production environments at your own risk.
