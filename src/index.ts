#!/usr/bin/env node

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { createMcpExpressApp } from "@modelcontextprotocol/sdk/server/express.js";
import {
  CallToolRequestSchema,
  ListResourcesRequestSchema,
  ListToolsRequestSchema,
  ReadResourceRequestSchema,
  isInitializeRequest,
  CallToolResult,
  TextContent,
  ImageContent,
  Tool,
} from "@modelcontextprotocol/sdk/types.js";
import puppeteer, { Browser, Page } from "puppeteer";
import dotenv from "dotenv";
import { randomUUID } from "node:crypto";
import { resolveSteelMode } from "./steelMode.js";

dotenv.config();

// -----------------------------------------------------------------------------
// Environment Variables
// -----------------------------------------------------------------------------
const steelKey = process.env.STEEL_API_KEY?.trim() || undefined;
const steelBaseUrlEnv = process.env.STEEL_BASE_URL?.trim() || undefined;
const globalWaitSeconds = Number(process.env.GLOBAL_WAIT_SECONDS) || 0;
const steelSessionTimeoutMsEnv = Number(process.env.STEEL_SESSION_TIMEOUT_MS);
const steelSessionTimeoutMs =
  Number.isFinite(steelSessionTimeoutMsEnv) && steelSessionTimeoutMsEnv > 0
    ? steelSessionTimeoutMsEnv
    : 900000;
const steelProfileId = process.env.STEEL_PROFILE_ID?.trim() || undefined;
const steelPersistProfile = process.env.STEEL_PERSIST_PROFILE?.trim() === "true";
const steelUseProxy = process.env.STEEL_USE_PROXY?.trim() === "true";
const steelProxy = process.env.STEEL_PROXY?.trim() || undefined;
const steelUserAgent = process.env.STEEL_USER_AGENT?.trim() || undefined;
const autoScreenshotEnabled = process.env.STEEL_AUTO_SCREENSHOT?.trim() === "true";
const inlineImageEnabled = process.env.STEEL_INLINE_IMAGES?.trim() === "true";
const steelSolveCaptchaEnv = process.env.STEEL_SOLVE_CAPTCHA?.trim();
const steelSolveCaptcha =
  steelSolveCaptchaEnv !== undefined
    ? steelSolveCaptchaEnv.toLowerCase() === "true"
    : undefined;

/**
 * STEEL_BASE_URL is for self-hosted or custom Steel endpoints.
 * If STEEL_BASE_URL is provided, local mode is assumed automatically.
 * If STEEL_API_KEY is provided (and no base URL), cloud mode is assumed automatically.
 * If neither is provided, the default local Steel Browser stack in this repo is used.
 */
const { steelLocal, steelBaseURL } = resolveSteelMode(steelBaseUrlEnv, steelKey);

function buildSteelHeaders(): Record<string, string> {
  return {
    "Content-Type": "application/json",
    ...(steelKey ? { "steel-api-key": steelKey } : {}),
  };
}

async function retrieveSteelSession(sessionId: string): Promise<{
  status: "live" | "released" | "failed" | string;
}> {
  const response = await fetch(`${steelBaseURL}/v1/sessions/${sessionId}`, {
    method: "GET",
    headers: buildSteelHeaders(),
  });

  if (!response.ok) {
    throw new Error(`Failed to retrieve session: ${response.statusText}`);
  }

  return response.json();
}

async function releaseSteelSession(sessionId: string): Promise<void> {
  const response = await fetch(`${steelBaseURL}/v1/sessions/${sessionId}/release`, {
    method: "POST",
    headers: buildSteelHeaders(),
  });

  if (!response.ok) {
    throw new Error(`Failed to release session: ${response.statusText}`);
  }
}

// -----------------------------------------------------------------------------
// Logging / Debug Info
// -----------------------------------------------------------------------------
console.error(
  JSON.stringify({
    message: "Initializing MCP server",
    config: {
      steelLocal,
      hasSteelKey: !!steelKey,
      hasSteelBaseURL: !!steelBaseUrlEnv,
      steelSessionTimeoutMs,
      hasSteelProfileId: !!steelProfileId,
      steelPersistProfile,
      steelUseProxy,
      hasSteelProxy: !!steelProxy,
      hasSteelUserAgent: !!steelUserAgent,
      steelSolveCaptcha,
      globalWaitSeconds,
      nodeVersion: process.version,
      platform: process.platform,
      steelBaseURL,
    },
  })
);

// -----------------------------------------------------------------------------
// Globals and Utilities
// -----------------------------------------------------------------------------
const screenshots = new Map<string, Buffer>();
const pdfs = new Map<string, Buffer>();
const consoleLogs: string[] = [];

function buildProxyConfig(): boolean | Record<string, unknown> | undefined {
  if (!steelUseProxy && !steelProxy) {
    return undefined;
  }

  if (steelProxy) {
    try {
      return JSON.parse(steelProxy) as Record<string, unknown>;
    } catch {
      return { server: steelProxy };
    }
  }

  return true;
}

type SerializedResult =
  | string
  | number
  | boolean
  | null
  | SerializedResult[]
  | { [key: string]: SerializedResult };

type CookieInput = {
  name: string;
  value: string;
  domain?: string;
  path?: string;
  expires?: number;
  httpOnly?: boolean;
  secure?: boolean;
  sameSite?: "Strict" | "Lax" | "None";
};

type TabSummary = {
  index: number;
  active: boolean;
  title: string;
  url: string;
  isClosed: boolean;
};

type TabState = {
  count: number;
  activeIndex: number;
};

type SessionInfo = {
  sessionId: string | null;
  steelLocal: boolean;
  steelBaseURL: string;
  timeoutMs: number;
  profileId: string | undefined;
  persistProfile: boolean;
  useProxy: boolean;
  proxyConfigured: boolean;
  userAgentConfigured: boolean;
  isInitialized: boolean;
  hasBrowser: boolean;
  hasPage: boolean;
};

function serializeValue(value: unknown): SerializedResult {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  ) {
    return value;
  }

  if (Array.isArray(value)) {
    return value.map((item) => serializeValue(item));
  }

  if (typeof value === "object") {
    const output: Record<string, SerializedResult> = {};
    for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
      output[key] = serializeValue(nested);
    }
    return output;
  }

  return String(value);
}

function renderValue(value: unknown): string {
  const serialized = serializeValue(value);
  if (typeof serialized === "string") {
    return serialized;
  }
  return JSON.stringify(serialized, null, 2);
}


// Define the marking script (truncated for brevity here)
const markPageScript = `
  if (typeof window.labels === 'undefined') {
    window.labels = [];
  }

  function unmarkPage() {
    for (const label of window.labels) {
      document.body.removeChild(label);
    }
    window.labels = [];

    const labeledElements = document.querySelectorAll('[data-label]');
    labeledElements.forEach(el => el.removeAttribute('data-label'));
  }

  function markPage() {
    unmarkPage();
    var items = Array.from(document.querySelectorAll("a, button, input, select, textarea, [role='button'], [role='link']"))
      .map(function (element) {
        var vw = Math.max(document.documentElement.clientWidth || 0, window.innerWidth || 0);
        var vh = Math.max(document.documentElement.clientHeight || 0, window.innerHeight || 0);
        var textualContent = element.textContent?.trim().replace(/\\s{2,}/g, " ") || "";
        var elementType = element.tagName.toLowerCase();
        var ariaLabel = element.getAttribute("aria-label") || "";

        var rect = element.getBoundingClientRect();
        var bbox = {
          left: Math.max(0, rect.left),
          top: Math.max(0, rect.top),
          right: Math.min(vw, rect.right),
          bottom: Math.min(vh, rect.bottom),
          width: Math.min(vw, rect.right) - Math.max(0, rect.left),
          height: Math.min(vh, rect.bottom) - Math.max(0, rect.top)
        };

        return {
          element,
          include:
            element.tagName === "INPUT" ||
            element.tagName === "TEXTAREA" ||
            element.tagName === "SELECT" ||
            element.tagName === "BUTTON" ||
            element.tagName === "A" ||
            element.onclick != null ||
            window.getComputedStyle(element).cursor == "pointer" ||
            element.tagName === "IFRAME" ||
            element.tagName === "VIDEO",
          bbox,
          rects: [bbox],
          text: textualContent,
          type: elementType,
          ariaLabel
        };
      })
      .filter(item => item.include && item.bbox.width * item.bbox.height >= 20);

    items = items.filter(
      (x) => !items.some((y) => x.element.contains(y.element) && x !== y)
    );

    items.forEach((item, index) => {
      item.element.setAttribute("data-label", index.toString());

      item.rects.forEach((bbox) => {
        const newElement = document.createElement("div");
        const borderColor = '#' + Math.floor(Math.random()*16777215).toString(16);
        newElement.style.outline = \`2px dashed \${borderColor}\`;
        newElement.style.position = "fixed";
        newElement.style.left = bbox.left + "px";
        newElement.style.top = bbox.top + "px";
        newElement.style.width = bbox.width + "px";
        newElement.style.height = bbox.height + "px";
        newElement.style.pointerEvents = "none";
        newElement.style.boxSizing = "border-box";
        newElement.style.zIndex = "2147483647";

        const label = document.createElement("span");
        label.textContent = index.toString();
        label.style.position = "absolute";
        const hasSpaceAbove = bbox.top >= 20;
        if (hasSpaceAbove) {
            label.style.top = "-19px";
            label.style.left = "0px";
        } else {
            label.style.top = "0px";
            label.style.left = "0px";
        }
        label.style.background = borderColor;
        label.style.color = "white";
        label.style.padding = "2px 4px";
        label.style.fontSize = "12px";
        label.style.borderRadius = "2px";
        label.style.zIndex = "2147483647";
        newElement.appendChild(label);

        document.body.appendChild(newElement);
        window.labels.push(newElement);
      });
    });

    return items.map((item) => ({
      x: item.bbox.left + item.bbox.width / 2,
      y: item.bbox.top + item.bbox.height / 2,
      type: item.type,
      text: item.text,
      ariaLabel: item.ariaLabel,
    }));
  }
`;

/**
 * Sleep for the specified number of milliseconds
 */
function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// -----------------------------------------------------------------------------
// SteelSessionManager Class
// -----------------------------------------------------------------------------
class SteelSessionManager {
  private sessionId: string | null = null;
  private browser: Browser | null = null;
  private page: Page | null = null;
  private isInitialized = false;
  private configuredPages = new WeakSet<Page>();

  constructor(
    private readonly steelLocal: boolean,
    private readonly steelKey: string | undefined,
    private readonly globalWaitSeconds: number
  ) {
    // If in cloud mode, ensure we have a Steel API key.
    if (!this.steelLocal && !this.steelKey) {
      throw new Error("STEEL_API_KEY must be set when cloud mode is used.");
    }
  }

  /**
   * Creates or recreates a Steel session. Called from createNewSession().
   */
  private async createSteelSession(timeoutMs: number = steelSessionTimeoutMs): Promise<{
    id: string;
    websocketUrl: string;
    status: "live" | "released" | "failed";
  }> {
    const payload: Record<string, unknown> = {
      timeout: timeoutMs,
    };

    const proxy = buildProxyConfig();
    if (proxy !== undefined) {
      payload.useProxy = proxy;
    }
    if (steelSolveCaptcha !== undefined) {
      payload.solveCaptcha = steelSolveCaptcha;
    }
    if (steelUserAgent) {
      payload.userAgent = steelUserAgent;
    }
    if (steelProfileId) {
      payload.profileId = steelProfileId;
    }
    if (steelPersistProfile) {
      if (!steelProfileId) {
        console.error(
          JSON.stringify({
            message: "STEEL_PERSIST_PROFILE is set but STEEL_PROFILE_ID is empty. Skipping persistProfile.",
          })
        );
      } else {
        payload.persistProfile = true;
      }
    }

    try {
      const response = await fetch(`${steelBaseURL}/v1/sessions`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          // Only include the steel-api-key header if we actually have one
          ...(this.steelKey ? { "steel-api-key": this.steelKey } : {}),
        },
        body: JSON.stringify(payload),
      });

      if (!response.ok) {
        throw new Error(`Failed to create session: ${response.statusText}`);
      }

      const data = await response.json();
      return {
        id: data.id,
        websocketUrl: data.websocketUrl,
        status: data.status,
      };
    } catch (error) {
      console.error(
        JSON.stringify({
          message: "Error creating Steel session",
          error: (error as Error).message,
        })
      );
      throw error;
    }
  }

  /**
   * Public method to initialize the session and return a Puppeteer Page.
   */
  async initialize(): Promise<Page> {
    if (this.isInitialized) {
      return this.page!;
    }
    try {
      await this.createNewSession(steelSessionTimeoutMs);
      this.isInitialized = true;
      return this.page!;
    } catch (error) {
      console.error(
        JSON.stringify({
          message: "Failed to initialize session",
          error: (error as Error).message,
          stack: (error as Error).stack,
        })
      );
      throw error;
    }
  }

  /**
   * Ensures that we have a valid session. If we don't, initialize one.
   */
  async ensureSession(): Promise<void> {
    if (!this.sessionId) {
      await this.initialize();
    }
  }

  /**
   * Returns the active browser instance or throws if the session is not ready.
   */
  async ensureBrowser(): Promise<Browser> {
    await this.ensureSession();
    if (!this.browser) {
      throw new Error("Browser is not initialized");
    }
    return this.browser;
  }

  /**
   * Returns the active page, refreshing it if the current page was closed.
   */
  async ensureActivePage(): Promise<Page> {
    await this.ensureSession();

    if (!this.browser) {
      throw new Error("Browser is not initialized");
    }

    if (!this.page || this.page.isClosed()) {
      const pages = await this.browser.pages();
      this.page = pages[0] ?? null;
      if (!this.page) {
        throw new Error("No active page is available");
      }
      await this.configurePage(this.page);
    }

    return this.page;
  }

  /**
   * Returns a lightweight snapshot of the current session configuration/state.
   */
  getSessionInfo(): SessionInfo {
    return {
      sessionId: this.sessionId,
      steelLocal,
      steelBaseURL,
      timeoutMs: steelSessionTimeoutMs,
      profileId: steelProfileId,
      persistProfile: steelPersistProfile,
      useProxy: steelUseProxy,
      proxyConfigured: !!steelProxy,
      userAgentConfigured: !!steelUserAgent,
      isInitialized: this.isInitialized,
      hasBrowser: !!this.browser,
      hasPage: !!this.page && !this.page.isClosed(),
    };
  }

  /**
   * Recreates the current session using the current env-driven configuration.
   */
  async resetSession(): Promise<Page> {
    await this.cleanup();
    return this.initialize();
  }

  /**
   * Configures a page once with viewport, console logging, and label overlays.
   */
  private async configurePage(page: Page): Promise<void> {
    if (this.configuredPages.has(page)) {
      return;
    }

    await page.setViewport({ width: 1280, height: 720 });
    if (steelUserAgent) {
      await page.setUserAgent(steelUserAgent);
    }
    await page.evaluateOnNewDocument(markPageScript);
    await page.evaluate(`${markPageScript}; markPage();`);

    page.on("console", (msg) => {
      const message = msg.text();
      console.error(`Browser console: ${message}`);
      consoleLogs.push(message);
      if (consoleLogs.length > 1000) {
        consoleLogs.shift();
      }
    });

    this.configuredPages.add(page);
  }

  /**
   * Updates the active page reference and ensures it is configured.
   */
  async setActivePage(page: Page): Promise<Page> {
    this.page = page;
    await this.configurePage(page);
    return page;
  }

  /**
   * Attaches browser lifecycle listeners for newly created tabs.
   */
  private attachBrowserListeners(browser: Browser): void {
    browser.on("targetcreated", async (target) => {
      if (target.type() !== "page") {
        return;
      }

      try {
        const page = await target.page();
        if (!page || page.isClosed()) {
          return;
        }

        await this.setActivePage(page);
        console.error(
          JSON.stringify({
            message: "New browser tab detected",
            url: page.url(),
          })
        );
      } catch (error) {
        console.error(
          JSON.stringify({
            message: "Failed to attach new browser tab",
            error: (error as Error).message,
          })
        );
      }
    });
  }

  /**
   * Returns summaries for all known tabs.
   */
  async listTabs(): Promise<TabSummary[]> {
    const browser = await this.ensureBrowser();
    const pages = await browser.pages();
    const activePage = this.page;

    const summaries: TabSummary[] = [];
    for (const [index, page] of pages.entries()) {
      const [title, url] = await Promise.all([
        page.title().catch(() => ""),
        Promise.resolve(page.url()),
      ]);
      summaries.push({
        index,
        active: page === activePage,
        title,
        url,
        isClosed: page.isClosed(),
      });
    }

    return summaries;
  }

  /**
   * Returns a lightweight snapshot of the current tab state.
   */
  async getTabState(): Promise<TabState> {
    const browser = await this.ensureBrowser();
    const pages = await browser.pages();
    return {
      count: pages.length,
      activeIndex: this.page ? pages.findIndex((page) => page === this.page) : -1,
    };
  }

  /**
   * Switches the active page by tab index.
   */
  async switchToTab(index: number): Promise<Page> {
    const browser = await this.ensureBrowser();
    const pages = await browser.pages();
    const page = pages[index];
    if (!page) {
      throw new Error(`Tab index ${index} does not exist`);
    }
    return this.setActivePage(page);
  }

  /**
   * Opens a new tab and optionally navigates to a URL.
   */
  async openNewTab(url?: string): Promise<Page> {
    const browser = await this.ensureBrowser();
    const page = await browser.newPage();
    if (url) {
      await page.goto(url);
    }
    return this.setActivePage(page);
  }

  /**
   * Closes a tab by index or the active tab if no index is provided.
   */
  async closeTab(index?: number): Promise<Page> {
    const browser = await this.ensureBrowser();
    const pages = await browser.pages();
    const pageToClose =
      index === undefined ? this.page : pages[index] ?? null;

    if (!pageToClose) {
      throw new Error(index === undefined ? "No active tab to close" : `Tab index ${index} does not exist`);
    }

    const wasActive = pageToClose === this.page;
    await pageToClose.close();

    const remainingPages = await browser.pages();
    const nextPage = remainingPages[0] ?? (await browser.newPage());
    await this.setActivePage(nextPage);

    if (wasActive) {
      return nextPage;
    }

    return this.page!;
  }

  /**
   * Creates a new session, connecting Puppeteer to the correct endpoint
   * (local or cloud).
   */
  private async createNewSession(timeoutMs: number = steelSessionTimeoutMs): Promise<void> {
    // If there's already a browser, clean up first
    if (this.browser) {
      await this.cleanup();
    }

    console.error(
      JSON.stringify({
        message: this.steelLocal
          ? "Local mode. Creating a local session..."
          : "Cloud mode. Creating a remote session...",
      })
    );

    // Create a Steel session in both local and cloud modes
    const session = await this.createSteelSession(timeoutMs);
    this.sessionId = session.id;

    console.error(
      JSON.stringify({
        message: "New session created with 15 minute timeout",
        sessionId: this.sessionId,
      })
    );

    // Connect Puppeteer to the appropriate WebSocket
    if (this.steelLocal) {
      // Local WebSocket endpoint
      const lowercaseBaseURL = steelBaseURL.toLowerCase();
      let browserWSEndpoint;
      if (lowercaseBaseURL.startsWith("http://")) {
        browserWSEndpoint = `${steelBaseURL.replace("http://", "ws://")}/?sessionId=${this.sessionId}`;
      }
      else if (lowercaseBaseURL.startsWith("https://")) {
        browserWSEndpoint = `${steelBaseURL.replace("https://", "wss://")}/?sessionId=${this.sessionId}`;
      }
      else {
        throw new Error("Invalid Steel base URL");
      }
      console.error(JSON.stringify({
        message: "Connecting to Steel session",
        browserWSEndpoint,
      }));
      this.browser = await puppeteer.connect({ browserWSEndpoint });
    } else {
      // Cloud WebSocket endpoint
      const browserWSEndpoint = `wss://connect.steel.dev?sessionId=${
        this.sessionId
      }${this.steelKey ? `&apiKey=${this.steelKey}` : ""}`;
      this.browser = await puppeteer.connect({ browserWSEndpoint });
    }

    this.attachBrowserListeners(this.browser);

    // Grab the initial page and set it up
    const pages = await this.browser.pages();
    const initialPage = pages[0];
    if (!initialPage) {
      throw new Error("Steel session did not provide an initial page");
    }
    await this.setActivePage(initialPage);
  }

  /**
   * Injects the marking script into the current page and applies it.
   */
  async injectMarkPageScript(page?: Page): Promise<void> {
    const targetPage = page ?? this.page;
    if (!targetPage) return;
    await this.configurePage(targetPage);
  }

  /**
   * Attempts to handle session errors, e.g. if a session is not live anymore.
   * Returns true if it recreates the session.
   */
  async handleError(error: Error): Promise<boolean> {
    try {
      if (!this.sessionId) {
        // If there's no session at all, let the caller handle it
        return false;
      }
      const session = await retrieveSteelSession(this.sessionId);
      if (session.status !== "live") {
        await this.createNewSession();
        return true;
      }
      return false;
    } catch (e) {
      // If we can't retrieve the session, try to create a new one
      await this.createNewSession();
      return true;
    }
  }

  /**
   * Cleans up resources including the session on steel.dev if in cloud mode,
   * and closes the Puppeteer browser.
   */
  async cleanup(): Promise<void> {
    try {
      if (this.sessionId) {
        // Release the Steel session so local and cloud backends do not keep stale sessions around.
        await releaseSteelSession(this.sessionId);
      }
    } catch (error) {
      console.error(
        JSON.stringify({
          message: "Error releasing session",
          error: (error as Error).message,
        })
      );
    }

    if (this.browser) {
      await this.browser.close().catch(console.error);
    }
    this.sessionId = null;
    this.browser = null;
    this.page = null;
    this.isInitialized = false;
    this.configuredPages = new WeakSet<Page>();
  }
}

// -----------------------------------------------------------------------------
// Create a SessionManager instance
// -----------------------------------------------------------------------------
const sessionManager = new SteelSessionManager(
  steelLocal,
  steelKey,
  globalWaitSeconds
);

// -----------------------------------------------------------------------------
// Define Tools
// -----------------------------------------------------------------------------
const TOOLS: Tool[] = [
  {
    name: "navigate",
    description: "Navigate to a specified URL",
    inputSchema: {
      type: "object",
      properties: {
        url: { type: "string", description: "The URL to navigate to" },
      },
      required: ["url"],
    },
  },
  {
    name: "session_info",
    description:
      "Return current Steel session metadata (session id, mode, base URL, and config flags).",
    inputSchema: {
      type: "object",
      properties: {},
      required: [],
    },
  },
  {
    name: "session_reset",
    description:
      "Recreate the current Steel session using existing configuration.",
    inputSchema: {
      type: "object",
      properties: {},
      required: [],
    },
  },
  {
    name: "search",
    description:
      "Perform a Google search by navigating to https://www.google.com/search?q=encodedQuery using the provided query text.",
    inputSchema: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "The text to search for on Google",
        },
      },
      required: ["query"],
    },
  },
  {
    name: "click",
    description:
      "Click an element on the page specified by its numbered label from the annotated screenshot",
    inputSchema: {
      type: "object",
      properties: {
        label: {
          type: "number",
          description:
            "The label of the element to click, as shown in the annotated screenshot",
        },
      },
      required: ["label"],
    },
  },
  {
    name: "type",
    description:
      "Type text into an input field specified by its numbered label from the annotated screenshot. Optionally replace existing text first.",
    inputSchema: {
      type: "object",
      properties: {
        label: {
          type: "number",
          description: "The label of the input field",
        },
        text: {
          type: "string",
          description: "The text to type into the input field",
        },
        replaceText: {
          type: "boolean",
          description:
            "If true, clears any existing text in the input field before typing the new text.",
        },
      },
      required: ["label", "text"],
    },
  },
  {
    name: "scroll_down",
    description:
      "Scroll down the page by a pixel amount - if no pixels are specified, scrolls down one page",
    inputSchema: {
      type: "object",
      properties: {
        pixels: {
          type: "integer",
          description:
            "The number of pixels to scroll down. If not specified, scrolls down one page.",
        },
      },
      required: [],
    },
  },
  {
    name: "scroll_up",
    description:
      "Scroll up the page by a pixel amount - if no pixels are specified, scrolls up one page",
    inputSchema: {
      type: "object",
      properties: {
        pixels: {
          type: "integer",
          description:
            "The number of pixels to scroll up. If not specified, scrolls up one page.",
        },
      },
      required: [],
    },
  },
  {
    name: "go_back",
    description: "Go back to the previous page in the browser history",
    inputSchema: {
      type: "object",
      properties: {},
      required: [],
    },
  },
  {
    name: "wait",
    description:
      "Use this tool when a page appears to be loading or not fully rendered. Common scenarios include: when elements are missing from a screenshot that should be there, when a page looks incomplete or broken, when dynamic content is still loading, or when a previous action (like clicking a button) hasn't fully processed yet. Waits for a specified number of seconds (up to 10) to allow the page to finish loading or rendering.",
    inputSchema: {
      type: "object",
      properties: {
        seconds: {
          type: "number",
          description:
            "Number of seconds to wait (max 10). Start with a smaller value (2-3 seconds) and increase if needed.",
          minimum: 0,
          maximum: 10,
        },
      },
      required: ["seconds"],
    },
  },
  {
    name: "save_unmarked_screenshot",
    description:
      "Capture a screenshot without bounding boxes and store it as a resource. Provide a resourceName to identify the screenshot. It's useful for when you want to view a page unobstructed by annotations or the user asks for a screenshot of the page.",
    inputSchema: {
      type: "object",
      properties: {
        resourceName: {
          type: "string",
          description:
            "The name under which the unmarked screenshot will be saved as a resource (e.g. 'before_login'). If not provided, one will be generated.",
        },
      },
      required: [],
    },
  },
  {
    name: "list_tabs",
    description: "List open browser tabs with their index, title, URL, and active state.",
    inputSchema: {
      type: "object",
      properties: {},
      required: [],
    },
  },
  {
    name: "new_tab",
    description: "Open a new tab and optionally navigate to a URL.",
    inputSchema: {
      type: "object",
      properties: {
        url: {
          type: "string",
          description: "Optional URL to open in the new tab.",
        },
      },
      required: [],
    },
  },
  {
    name: "switch_tab",
    description: "Switch the active browser tab by index.",
    inputSchema: {
      type: "object",
      properties: {
        index: {
          type: "integer",
          description: "The zero-based tab index to activate.",
        },
      },
      required: ["index"],
    },
  },
  {
    name: "close_tab",
    description: "Close the active browser tab or a specific tab by index.",
    inputSchema: {
      type: "object",
      properties: {
        index: {
          type: "integer",
          description: "Optional zero-based tab index to close. If omitted, the active tab is closed.",
        },
      },
      required: [],
    },
  },
  {
    name: "reload",
    description: "Reload the current page.",
    inputSchema: {
      type: "object",
      properties: {},
      required: [],
    },
  },
  {
    name: "go_forward",
    description: "Go forward in browser history.",
    inputSchema: {
      type: "object",
      properties: {},
      required: [],
    },
  },
  {
    name: "stop_loading",
    description: "Stop loading the current page.",
    inputSchema: {
      type: "object",
      properties: {},
      required: [],
    },
  },
  {
    name: "set_viewport",
    description: "Set the current page viewport size and optional device settings.",
    inputSchema: {
      type: "object",
      properties: {
        width: { type: "integer", minimum: 1 },
        height: { type: "integer", minimum: 1 },
        deviceScaleFactor: { type: "number", minimum: 0.1 },
        isMobile: { type: "boolean" },
        hasTouch: { type: "boolean" },
      },
      required: ["width", "height"],
    },
  },
  {
    name: "get_page_info",
    description: "Get the current page title, URL, and viewport information.",
    inputSchema: {
      type: "object",
      properties: {},
      required: [],
    },
  },
  {
    name: "get_url",
    description: "Get the current page URL.",
    inputSchema: {
      type: "object",
      properties: {},
      required: [],
    },
  },
  {
    name: "get_title",
    description: "Get the current page title.",
    inputSchema: {
      type: "object",
      properties: {},
      required: [],
    },
  },
  {
    name: "get_text",
    description: "Extract visible text from the page or a specific selector.",
    inputSchema: {
      type: "object",
      properties: {
        selector: {
          type: "string",
          description: "Optional CSS selector to target.",
        },
      },
      required: [],
    },
  },
  {
    name: "get_html",
    description: "Extract HTML from the page or a specific selector.",
    inputSchema: {
      type: "object",
      properties: {
        selector: {
          type: "string",
          description: "Optional CSS selector to target.",
        },
      },
      required: [],
    },
  },
  {
    name: "evaluate",
    description: "Evaluate JavaScript in the page context and return the result.",
    inputSchema: {
      type: "object",
      properties: {
        expression: {
          type: "string",
          description: "JavaScript expression or snippet to evaluate in the page context.",
        },
      },
      required: ["expression"],
    },
  },
  {
    name: "click_selector",
    description: "Click an element using a CSS selector.",
    inputSchema: {
      type: "object",
      properties: {
        selector: {
          type: "string",
          description: "CSS selector for the clickable element.",
        },
        button: {
          type: "string",
          enum: ["left", "middle", "right"],
        },
        clickCount: {
          type: "integer",
          minimum: 1,
          maximum: 3,
        },
      },
      required: ["selector"],
    },
  },
  {
    name: "type_selector",
    description: "Type text into an element selected by CSS selector.",
    inputSchema: {
      type: "object",
      properties: {
        selector: {
          type: "string",
          description: "CSS selector for the input element.",
        },
        text: {
          type: "string",
          description: "Text to type into the element.",
        },
        replaceText: {
          type: "boolean",
          description: "If true, clear existing text before typing.",
        },
        pressEnter: {
          type: "boolean",
          description: "If true, press Enter after typing.",
        },
      },
      required: ["selector", "text"],
    },
  },
  {
    name: "select_option",
    description: "Select one or more options from a select element.",
    inputSchema: {
      type: "object",
      properties: {
        selector: {
          type: "string",
          description: "CSS selector for the select element.",
        },
        values: {
          type: "array",
          items: { type: "string" },
          description: "Option values to select.",
        },
      },
      required: ["selector", "values"],
    },
  },
  {
    name: "press_key",
    description: "Press a keyboard key, optionally scoped to a selector.",
    inputSchema: {
      type: "object",
      properties: {
        selector: {
          type: "string",
          description: "Optional CSS selector to scope the key press.",
        },
        key: {
          type: "string",
          description: "Keyboard key name such as Enter, Tab, ArrowDown, or a printable character.",
        },
      },
      required: ["key"],
    },
  },
  {
    name: "hover",
    description: "Hover over an element selected by CSS selector.",
    inputSchema: {
      type: "object",
      properties: {
        selector: {
          type: "string",
          description: "CSS selector for the element to hover.",
        },
      },
      required: ["selector"],
    },
  },
  {
    name: "drag",
    description: "Drag an element from one selector to another.",
    inputSchema: {
      type: "object",
      properties: {
        sourceSelector: {
          type: "string",
          description: "CSS selector for the draggable source element.",
        },
        targetSelector: {
          type: "string",
          description: "CSS selector for the drop target element.",
        },
      },
      required: ["sourceSelector", "targetSelector"],
    },
  },
  {
    name: "wait_for_selector",
    description: "Wait for a selector to appear or become visible.",
    inputSchema: {
      type: "object",
      properties: {
        selector: {
          type: "string",
          description: "CSS selector to wait for.",
        },
        visible: {
          type: "boolean",
          description: "If true, wait until the element is visible.",
        },
        timeoutMs: {
          type: "integer",
          minimum: 0,
          description: "Maximum time to wait in milliseconds.",
        },
      },
      required: ["selector"],
    },
  },
  {
    name: "wait_for_url",
    description:
      "Wait until the current page URL matches a string. Use this for SPA route changes or page transitions.",
    inputSchema: {
      type: "object",
      properties: {
        match: {
          type: "string",
          description: "URL substring or exact URL to wait for.",
        },
        exact: {
          type: "boolean",
          description: "If true, require an exact URL match.",
        },
        stableMs: {
          type: "integer",
          minimum: 0,
          description:
            "Optional time in milliseconds that the URL must remain matched before returning.",
        },
        timeoutMs: {
          type: "integer",
          minimum: 0,
          description: "Maximum time to wait in milliseconds.",
        },
      },
      required: ["match"],
    },
  },
  {
    name: "get_cookies",
    description: "Get cookies for the current page.",
    inputSchema: {
      type: "object",
      properties: {},
      required: [],
    },
  },
  {
    name: "set_cookies",
    description: "Set cookies for the current browser context.",
    inputSchema: {
      type: "object",
      properties: {
        cookies: {
          type: "array",
          items: {
            type: "object",
            properties: {
              name: { type: "string" },
              value: { type: "string" },
              domain: { type: "string" },
              path: { type: "string" },
              expires: { type: "number" },
              httpOnly: { type: "boolean" },
              secure: { type: "boolean" },
              sameSite: { type: "string", enum: ["Strict", "Lax", "None"] },
            },
            required: ["name", "value"],
          },
        },
      },
      required: ["cookies"],
    },
  },
  {
    name: "clear_cookies",
    description: "Clear all cookies for the current browser context.",
    inputSchema: {
      type: "object",
      properties: {},
      required: [],
    },
  },
  {
    name: "get_local_storage",
    description: "Read the current origin's localStorage values.",
    inputSchema: {
      type: "object",
      properties: {},
      required: [],
    },
  },
  {
    name: "set_local_storage",
    description: "Set one or more localStorage values on the current origin.",
    inputSchema: {
      type: "object",
      properties: {
        data: {
          type: "object",
          additionalProperties: { type: "string" },
          description: "Key/value pairs to store in localStorage.",
        },
      },
      required: ["data"],
    },
  },
  {
    name: "clear_local_storage",
    description: "Clear localStorage for the current origin.",
    inputSchema: {
      type: "object",
      properties: {},
      required: [],
    },
  },
  {
    name: "upload_file",
    description: "Upload one or more files into a file input element.",
    inputSchema: {
      type: "object",
      properties: {
        selector: {
          type: "string",
          description: "CSS selector for the file input element.",
        },
        paths: {
          type: "array",
          items: { type: "string" },
          description: "Absolute paths to the files to upload.",
        },
      },
      required: ["selector", "paths"],
    },
  },
  {
    name: "screenshot",
    description:
      "Capture a screenshot of the full page, current viewport, or a specific selector. Optionally save it as a resource.",
    inputSchema: {
      type: "object",
      properties: {
        selector: {
          type: "string",
          description: "Optional CSS selector to screenshot.",
        },
        fullPage: {
          type: "boolean",
          description: "If true, capture the entire page.",
        },
        resourceName: {
          type: "string",
          description: "Optional resource name to store the screenshot under.",
        },
        omitAnnotations: {
          type: "boolean",
          description: "If true, temporarily remove label overlays before capturing.",
        },
      },
      required: [],
    },
  },
  {
    name: "quick_scrape",
    description:
      "Use Steel Browser Quick Actions to scrape a page via /v1/scrape. Returns the scraped HTML/text payload.",
    inputSchema: {
      type: "object",
      properties: {
        url: { type: "string", description: "The URL to scrape." },
        delay: {
          type: "integer",
          description: "Optional delay in milliseconds before scraping.",
          minimum: 0,
        },
      },
      required: ["url"],
    },
  },
  {
    name: "quick_screenshot",
    description:
      "Use Steel Browser Quick Actions to take a screenshot via /v1/screenshot.",
    inputSchema: {
      type: "object",
      properties: {
        url: { type: "string", description: "The URL to screenshot." },
        fullPage: {
          type: "boolean",
          description: "If true, capture the full page.",
        },
        delay: {
          type: "integer",
          description: "Optional delay in milliseconds before capturing.",
          minimum: 0,
        },
        resourceName: {
          type: "string",
          description: "Optional resource name to store the screenshot under.",
        },
      },
      required: ["url"],
    },
  },
  {
    name: "quick_pdf",
    description:
      "Use Steel Browser Quick Actions to generate a PDF via /v1/pdf. Returns a pdf:// resource.",
    inputSchema: {
      type: "object",
      properties: {
        url: { type: "string", description: "The URL to render as PDF." },
        resourceName: {
          type: "string",
          description: "Optional resource name to store the PDF under.",
        },
      },
      required: ["url"],
    },
  },
];

// -----------------------------------------------------------------------------
// Tool Handlers (Examples)
// -----------------------------------------------------------------------------

/**
 * Handle "search" tool call
 */
async function handleNavigate(page: Page, args: any): Promise<CallToolResult> {
  let { url } = args;
  if (!url) {
    return {
      isError: true,
      content: [
        { type: "text", text: "URL parameter is required for navigation" },
      ],
    };
  }
  if (!/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(url)) {
    url = "https://" + url;
  }
  await page.goto(url);
  return {
    isError: false,
    content: [{ type: "text", text: `Navigated to ${url}` }],
  };
}

async function handleSessionInfo(): Promise<CallToolResult> {
  const info = sessionManager.getSessionInfo();
  return {
    isError: false,
    content: [{ type: "text", text: JSON.stringify(info, null, 2) }],
  };
}

async function handleSessionReset(): Promise<CallToolResult> {
  await sessionManager.resetSession();
  const info = sessionManager.getSessionInfo();
  return {
    isError: false,
    content: [
      { type: "text", text: "Session reset completed." },
      { type: "text", text: JSON.stringify(info, null, 2) },
    ],
  };
}

/**
 * Handle "search" tool call
 */
async function handleSearch(page: Page, args: any): Promise<CallToolResult> {
  const { query } = args;
  if (!query) {
    return {
      isError: true,
      content: [
        { type: "text", text: "Query parameter is required for search" },
      ],
    };
  }
  const encodedQuery = encodeURIComponent(query);
  const url = `https://www.google.com/search?q=${encodedQuery}`;
  await page.goto(url);
  return {
    isError: false,
    content: [{ type: "text", text: `Searched Google for "${query}"` }],
  };
}

/**
 * Handle "click" tool call
 */
async function handleClick(page: Page, args: any): Promise<CallToolResult> {
  const { label } = args;
  if (label === undefined || label === null) {
    return {
      isError: true,
      content: [
        {
          type: "text",
          text: "Label parameter is required for clicking elements",
        },
      ],
    };
  }

  const selector = `[data-label="${label}"]`;
  try {
    // Wait for the element to be visible
    await page.waitForSelector(selector, { visible: true });

    // Evaluate if the element has a target="_blank" anchor
    type ClickResult =
      | { hasTargetBlank: true; href: string }
      | { hasTargetBlank: false };

    const result = await page.$eval(selector, (element): ClickResult => {
      const anchor = element.closest("a");
      if (anchor && anchor.target === "_blank" && anchor.href) {
        return { hasTargetBlank: true, href: anchor.href };
      }
      return { hasTargetBlank: false };
    });

    // If the element navigates to a new tab, go to that href instead
    if (result.hasTargetBlank) {
      await page.goto(result.href);
    } else {
      await page.click(selector);
    }

    // Success - no error content
    return {
      isError: false,
      content: [{ type: "text", text: `Clicked element with label ${label}.` }],
    };
  } catch (e) {
    return {
      isError: true,
      content: [
        {
          type: "text",
          text: `Could not find clickable element with label ${label}. Error: ${
            (e as Error).message
          }`,
        },
      ],
    };
  }
}

/**
 * Handle "type" tool call
 */
async function handleType(page: Page, args: any): Promise<CallToolResult> {
  const { label, text, replaceText = false } = args;
  if (label === undefined || label === null || !text) {
    return {
      isError: true,
      content: [
        {
          type: "text",
          text: "Both label and text parameters are required for typing",
        },
      ],
    };
  }

  const selector = `[data-label="${label}"]`;
  try {
    await page.waitForSelector(selector, { visible: true });
  } catch {
    return {
      isError: true,
      content: [
        {
          type: "text",
          text: `Could not find input element with label ${label}.`,
        },
      ],
    };
  }

  // Option A: Directly set the value & dispatch events
  if (replaceText) {
    await page.$eval(
      selector,
      (el: Element, value: string) => {
        const input = el as HTMLInputElement;
        input.value = value;
        input.dispatchEvent(new Event("input", { bubbles: true }));
        input.dispatchEvent(new Event("change", { bubbles: true }));
      },
      text
    );
  } else {
    await page.$eval(
      selector,
      (el: Element, value: string) => {
        const input = el as HTMLInputElement;
        input.value = (input.value ?? "") + value;
        input.dispatchEvent(new Event("input", { bubbles: true }));
        input.dispatchEvent(new Event("change", { bubbles: true }));
      },
      text
    );
  }

  // Option B (Alternative): Use page.type() to simulate typing
  // An example if you want to more accurately emulate user typing:
  //   if (replaceText) {
  //     await page.click(selector, { clickCount: 3 }); // highlights existing text
  //     await page.type(selector, text);
  //   } else {
  //     await page.type(selector, text);
  //   }

  return {
    isError: false,
    content: [{ type: "text", text: `Typed '${text}' into label ${label}.` }],
  };
}

/**
 * Handle "scroll_down" tool call
 */
async function handleScrollDown(
  page: Page,
  args: any
): Promise<CallToolResult> {
  const { pixels } = args;
  if (pixels !== undefined) {
    await page.evaluate((scrollAmount) => {
      window.scrollBy(0, scrollAmount);
    }, pixels);
  } else {
    await page.keyboard.press("PageDown");
  }

  return {
    isError: false,
    content: [
      { type: "text", text: `Scrolled down by ${pixels ?? "one page"}` },
    ],
  };
}

/**
 * Handle "scroll_up" tool call
 */
async function handleScrollUp(page: Page, args: any): Promise<CallToolResult> {
  const { pixels } = args;
  if (pixels !== undefined) {
    await page.evaluate((scrollAmount) => {
      window.scrollBy(0, -scrollAmount);
    }, pixels);
  } else {
    await page.keyboard.press("PageUp");
  }

  return {
    isError: false,
    content: [{ type: "text", text: `Scrolled up by ${pixels ?? "one page"}` }],
  };
}

/**
 * Handle "go_back" tool call
 */
async function handleGoBack(page: Page): Promise<CallToolResult> {
  const response = await page.goBack({ waitUntil: "domcontentloaded" });
  if (!response) {
    return {
      isError: true,
      content: [
        {
          type: "text",
          text: "Cannot go back. No previous page in the browser history.",
        },
      ],
    };
  }

  return {
    isError: false,
    content: [{ type: "text", text: "Went back to the previous page." }],
  };
}

/**
 * Handle "wait" tool call
 */
async function handleWait(_page: Page, args: any): Promise<CallToolResult> {
  const { seconds } = args;
  if (typeof seconds !== "number" || seconds < 0 || seconds > 10) {
    return {
      isError: true,
      content: [
        {
          type: "text",
          text: "Wait time must be a number between 0 and 10 seconds",
        },
      ],
    };
  }

  await sleep(seconds * 1000); // Reusing your sleep utility
  return {
    isError: false,
    content: [{ type: "text", text: `Waited ${seconds} second(s).` }],
  };
}

/**
 * Handle "save_unmarked_screenshot" tool call
 */
async function handleSaveUnmarkedScreenshot(
  page: Page,
  args: any
): Promise<CallToolResult> {
  let { resourceName } = args;
  if (!resourceName) {
    resourceName = `unmarked_screenshot_${Date.now()}`;
  }

  // Unmark the page to remove bounding boxes
  await page.evaluate(() => {
    if (typeof (window as any).unmarkPage === "function") {
      (window as any).unmarkPage();
    }
  });

  const buffer = await page.screenshot();
  screenshots.set(resourceName, Buffer.from(buffer));

  return {
    isError: false,
    content: [
      {
        type: "text",
        text: `Unmarked screenshot saved as resource screenshot://${resourceName}`,
      },
    ],
  };
}
async function handleListTabs(): Promise<CallToolResult> {
  const tabs = await sessionManager.listTabs();
  return {
    isError: false,
    content: [{ type: "text", text: JSON.stringify(tabs, null, 2) }],
  };
}

async function handleNewTab(args: any): Promise<CallToolResult> {
  const { url } = args;
  const page = await sessionManager.openNewTab(url);
  return {
    isError: false,
    content: [
      { type: "text", text: `Opened new tab${url ? ` at ${url}` : ""}.` },
      {
        type: "text",
        text: JSON.stringify({
          title: await page.title().catch(() => ""),
          url: page.url(),
        }, null, 2),
      },
    ],
  };
}

async function handleSwitchTab(args: any): Promise<CallToolResult> {
  const { index } = args;
  if (typeof index !== "number") {
    return {
      isError: true,
      content: [{ type: "text", text: "Tab index is required." }],
    };
  }

  const page = await sessionManager.switchToTab(index);
  return {
    isError: false,
    content: [
      {
        type: "text",
        text: `Switched to tab ${index}: ${await page.title().catch(() => "")}`,
      },
    ],
  };
}

async function handleCloseTab(args: any): Promise<CallToolResult> {
  const { index } = args;
  const page = await sessionManager.closeTab(
    typeof index === "number" ? index : undefined
  );
  return {
    isError: false,
    content: [
      {
        type: "text",
        text: `Closed tab${typeof index === "number" ? ` ${index}` : ""}. Active tab is now ${await page.title().catch(() => "")}.`,
      },
    ],
  };
}

async function handleReload(page: Page): Promise<CallToolResult> {
  await page.reload({ waitUntil: "domcontentloaded" });
  return {
    isError: false,
    content: [{ type: "text", text: "Reloaded the current page." }],
  };
}

async function handleGoForward(page: Page): Promise<CallToolResult> {
  const response = await page.goForward({ waitUntil: "domcontentloaded" });
  if (!response) {
    return {
      isError: true,
      content: [{ type: "text", text: "Cannot go forward. No next page in history." }],
    };
  }
  return {
    isError: false,
    content: [{ type: "text", text: "Went forward in browser history." }],
  };
}

async function handleStopLoading(page: Page): Promise<CallToolResult> {
  await page.evaluate(() => window.stop());
  return {
    isError: false,
    content: [{ type: "text", text: "Stopped page loading." }],
  };
}

async function handleSetViewport(page: Page, args: any): Promise<CallToolResult> {
  const { width, height, deviceScaleFactor, isMobile, hasTouch } = args;
  if (typeof width !== "number" || typeof height !== "number") {
    return {
      isError: true,
      content: [{ type: "text", text: "Width and height are required." }],
    };
  }
  await page.setViewport({
    width,
    height,
    ...(typeof deviceScaleFactor === "number" ? { deviceScaleFactor } : {}),
    ...(typeof isMobile === "boolean" ? { isMobile } : {}),
    ...(typeof hasTouch === "boolean" ? { hasTouch } : {}),
  });
  return {
    isError: false,
    content: [
      {
        type: "text",
        text: `Viewport set to ${width}x${height}.`,
      },
    ],
  };
}

async function handleGetPageInfo(page: Page): Promise<CallToolResult> {
  const viewport = page.viewport();
  return {
    isError: false,
    content: [
      {
        type: "text",
        text: JSON.stringify(
          {
            title: await page.title().catch(() => ""),
            url: page.url(),
            viewport,
          },
          null,
          2
        ),
      },
    ],
  };
}

async function handleGetUrl(page: Page): Promise<CallToolResult> {
  return {
    isError: false,
    content: [{ type: "text", text: page.url() }],
  };
}

async function handleGetTitle(page: Page): Promise<CallToolResult> {
  return {
    isError: false,
    content: [{ type: "text", text: await page.title().catch(() => "") }],
  };
}

async function handleGetText(page: Page, args: any): Promise<CallToolResult> {
  const { selector } = args;
  const text = selector
    ? await page.$eval(selector, (el) => (el as HTMLElement).innerText || el.textContent || "")
    : await page.evaluate(() => document.body.innerText);
  return {
    isError: false,
    content: [{ type: "text", text }],
  };
}

async function handleGetHtml(page: Page, args: any): Promise<CallToolResult> {
  const { selector } = args;
  const html = selector
    ? await page.$eval(selector, (el) => (el as HTMLElement).outerHTML)
    : await page.evaluate(() => document.documentElement.outerHTML);
  return {
    isError: false,
    content: [{ type: "text", text: html }],
  };
}

async function handleEvaluate(page: Page, args: any): Promise<CallToolResult> {
  const { expression } = args;
  if (typeof expression !== "string" || !expression.trim()) {
    return {
      isError: true,
      content: [{ type: "text", text: "Expression is required." }],
    };
  }
  const result = await page.evaluate((expr) => {
    // eslint-disable-next-line no-eval
    return eval(expr);
  }, expression);
  return {
    isError: false,
    content: [{ type: "text", text: renderValue(result) }],
  };
}

async function handleClickSelector(page: Page, args: any): Promise<CallToolResult> {
  const { selector, button = "left", clickCount = 1 } = args;
  if (typeof selector !== "string") {
    return {
      isError: true,
      content: [{ type: "text", text: "Selector is required." }],
    };
  }
  await page.waitForSelector(selector, { visible: true });
  await page.click(selector, { button, clickCount });
  return {
    isError: false,
    content: [{ type: "text", text: `Clicked ${selector}.` }],
  };
}

async function handleTypeSelector(page: Page, args: any): Promise<CallToolResult> {
  const { selector, text, replaceText = false, pressEnter = false } = args;
  if (typeof selector !== "string" || typeof text !== "string") {
    return {
      isError: true,
      content: [{ type: "text", text: "Selector and text are required." }],
    };
  }
  await page.waitForSelector(selector, { visible: true });
  if (replaceText) {
    await page.$eval(selector, (el) => {
      const input = el as HTMLInputElement | HTMLTextAreaElement;
      input.value = "";
      input.dispatchEvent(new Event("input", { bubbles: true }));
      input.dispatchEvent(new Event("change", { bubbles: true }));
    });
  }
  await page.type(selector, text);
  if (pressEnter) {
    await page.keyboard.press("Enter");
  }
  return {
    isError: false,
    content: [{ type: "text", text: `Typed text into ${selector}.` }],
  };
}

async function handleSelectOption(page: Page, args: any): Promise<CallToolResult> {
  const { selector, values } = args;
  if (typeof selector !== "string" || !Array.isArray(values)) {
    return {
      isError: true,
      content: [{ type: "text", text: "Selector and values are required." }],
    };
  }
  await page.waitForSelector(selector, { visible: true });
  await page.select(selector, ...values.map(String));
  return {
    isError: false,
    content: [{ type: "text", text: `Selected ${values.join(", ")} on ${selector}.` }],
  };
}

async function handlePressKey(page: Page, args: any): Promise<CallToolResult> {
  const { key } = args;
  if (typeof key !== "string" || !key.trim()) {
    return {
      isError: true,
      content: [{ type: "text", text: "Key is required." }],
    };
  }
  await page.keyboard.press(key as any);
  return {
    isError: false,
    content: [{ type: "text", text: `Pressed ${key}.` }],
  };
}

async function handleHover(page: Page, args: any): Promise<CallToolResult> {
  const { selector } = args;
  if (typeof selector !== "string") {
    return {
      isError: true,
      content: [{ type: "text", text: "Selector is required." }],
    };
  }
  await page.waitForSelector(selector, { visible: true });
  await page.hover(selector);
  return {
    isError: false,
    content: [{ type: "text", text: `Hovered ${selector}.` }],
  };
}

async function handleDrag(page: Page, args: any): Promise<CallToolResult> {
  const { sourceSelector, targetSelector } = args;
  if (typeof sourceSelector !== "string" || typeof targetSelector !== "string") {
    return {
      isError: true,
      content: [{ type: "text", text: "Source and target selectors are required." }],
    };
  }

  const source = await page.$(sourceSelector);
  const target = await page.$(targetSelector);
  if (!source || !target) {
    return {
      isError: true,
      content: [{ type: "text", text: "Source or target element not found." }],
    };
  }

  const sourceBox = await source.boundingBox();
  const targetBox = await target.boundingBox();
  if (!sourceBox || !targetBox) {
    return {
      isError: true,
      content: [{ type: "text", text: "Unable to determine element geometry." }],
    };
  }

  await page.mouse.move(
    sourceBox.x + sourceBox.width / 2,
    sourceBox.y + sourceBox.height / 2
  );
  await page.mouse.down();
  await page.mouse.move(
    targetBox.x + targetBox.width / 2,
    targetBox.y + targetBox.height / 2,
    { steps: 10 }
  );
  await page.mouse.up();

  return {
    isError: false,
    content: [{ type: "text", text: `Dragged ${sourceSelector} to ${targetSelector}.` }],
  };
}

async function handleWaitForSelector(page: Page, args: any): Promise<CallToolResult> {
  const { selector, visible = false, timeoutMs = 30000 } = args;
  if (typeof selector !== "string") {
    return {
      isError: true,
      content: [{ type: "text", text: "Selector is required." }],
    };
  }
  await page.waitForSelector(selector, {
    visible: !!visible,
    timeout: typeof timeoutMs === "number" ? timeoutMs : 30000,
  });
  return {
    isError: false,
    content: [{ type: "text", text: `Selector ${selector} is ready.` }],
  };
}

async function handleWaitForUrl(page: Page, args: any): Promise<CallToolResult> {
  const { match, exact = false, stableMs = 0, timeoutMs = 30000 } = args;
  if (typeof match !== "string" || !match.trim()) {
    return {
      isError: true,
      content: [{ type: "text", text: "match is required." }],
    };
  }

  const deadline = Date.now() + (typeof timeoutMs === "number" ? timeoutMs : 30000);
  let matchedAt: number | null = null;
  let currentUrl = page.url();

  while (Date.now() < deadline) {
    currentUrl = page.url();
    const isMatch = exact ? currentUrl === match : currentUrl.includes(match);

    if (isMatch) {
      if (matchedAt === null) {
        matchedAt = Date.now();
      }

      if (typeof stableMs !== "number" || stableMs <= 0 || Date.now() - matchedAt >= stableMs) {
        return {
          isError: false,
          content: [
            {
              type: "text",
              text: `URL matched: ${currentUrl}`,
            },
          ],
        };
      }
    } else {
      matchedAt = null;
    }

    await sleep(100);
  }

  return {
    isError: true,
    content: [
      {
        type: "text",
        text: `Timed out waiting for URL match: ${match}. Current URL: ${currentUrl}`,
      },
    ],
  };
}

async function handleGetCookies(page: Page): Promise<CallToolResult> {
  const cookies = await page.cookies();
  return {
    isError: false,
    content: [{ type: "text", text: JSON.stringify(cookies, null, 2) }],
  };
}

async function handleSetCookies(page: Page, args: any): Promise<CallToolResult> {
  const { cookies } = args;
  if (!Array.isArray(cookies)) {
    return {
      isError: true,
      content: [{ type: "text", text: "cookies must be an array." }],
    };
  }
  await page.setCookie(...(cookies as CookieInput[]));
  return {
    isError: false,
    content: [{ type: "text", text: `Set ${cookies.length} cookie(s).` }],
  };
}

async function handleClearCookies(page: Page): Promise<CallToolResult> {
  const cookies = await page.cookies();
  if (cookies.length === 0) {
    return {
      isError: false,
      content: [{ type: "text", text: "No cookies to clear." }],
    };
  }

  await page.deleteCookie(
    ...cookies.map((cookie) => ({
      name: cookie.name,
      value: cookie.value,
      domain: cookie.domain,
      path: cookie.path,
    }))
  );

  return {
    isError: false,
    content: [{ type: "text", text: `Cleared ${cookies.length} cookie(s).` }],
  };
}

async function handleGetLocalStorage(page: Page): Promise<CallToolResult> {
  const data = await page.evaluate(() => {
    const output: Record<string, string> = {};
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (key !== null) {
        output[key] = localStorage.getItem(key) ?? "";
      }
    }
    return output;
  });
  return {
    isError: false,
    content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
  };
}

async function handleSetLocalStorage(page: Page, args: any): Promise<CallToolResult> {
  const { data } = args;
  if (!data || typeof data !== "object") {
    return {
      isError: true,
      content: [{ type: "text", text: "data object is required." }],
    };
  }
  await page.evaluate((entries) => {
    for (const [key, value] of Object.entries(entries)) {
      localStorage.setItem(key, String(value));
    }
  }, data);
  return {
    isError: false,
    content: [{ type: "text", text: "Updated localStorage." }],
  };
}

async function handleClearLocalStorage(page: Page): Promise<CallToolResult> {
  await page.evaluate(() => localStorage.clear());
  return {
    isError: false,
    content: [{ type: "text", text: "Cleared localStorage." }],
  };
}

async function handleUploadFile(page: Page, args: any): Promise<CallToolResult> {
  const { selector, paths } = args;
  if (typeof selector !== "string" || !Array.isArray(paths) || paths.length === 0) {
    return {
      isError: true,
      content: [{ type: "text", text: "Selector and paths are required." }],
    };
  }
  const element = await page.$(selector);
  if (!element) {
    return {
      isError: true,
      content: [{ type: "text", text: `File input ${selector} not found.` }],
    };
  }
  await (element as any).uploadFile(...paths.map(String));
  return {
    isError: false,
    content: [{ type: "text", text: `Uploaded ${paths.length} file(s) into ${selector}.` }],
  };
}

async function handleScreenshot(page: Page, args: any): Promise<CallToolResult> {
  const { selector, fullPage = false, resourceName, omitAnnotations = false } = args;
  let targetPage = page;
  if (omitAnnotations) {
    await page.evaluate(() => {
      if (typeof (window as any).unmarkPage === "function") {
        (window as any).unmarkPage();
      }
    });
  }

  let buffer: Buffer;
  if (typeof selector === "string" && selector.trim()) {
    const element = await page.$(selector);
    if (!element) {
      return {
        isError: true,
        content: [{ type: "text", text: `Element ${selector} not found.` }],
      };
    }
    const screenshot = await element.screenshot();
    buffer = Buffer.from(screenshot);
  } else {
    const screenshot = await targetPage.screenshot({ fullPage: !!fullPage });
    buffer = Buffer.from(screenshot);
  }

  const name = resourceName || `screenshot_${Date.now()}`;
  if (resourceName) {
    screenshots.set(name, buffer);
  }

  const content: Array<TextContent | ImageContent> = [
    {
      type: "text",
      text: resourceName
        ? `Screenshot saved as resource screenshot://${name}`
        : "Screenshot captured.",
    },
  ];

  if (inlineImageEnabled) {
    content.push({
      type: "image",
      data: buffer.toString("base64"),
      mimeType: "image/png",
    });
  }

  return {
    isError: false,
    content,
  };
}

async function handleQuickScrape(args: any): Promise<CallToolResult> {
  const { url, delay } = args;
  if (typeof url !== "string" || !url.trim()) {
    return {
      isError: true,
      content: [{ type: "text", text: "URL is required." }],
    };
  }

  const response = await fetch(`${steelBaseURL}/v1/scrape`, {
    method: "POST",
    headers: buildSteelHeaders(),
    body: JSON.stringify({
      url,
      ...(typeof delay === "number" ? { delay } : {}),
    }),
  });

  if (!response.ok) {
    return {
      isError: true,
      content: [
        {
          type: "text",
          text: `Scrape failed: ${response.status} ${response.statusText}`,
        },
      ],
    };
  }

  const contentType = response.headers.get("content-type") || "";
  if (contentType.includes("application/json")) {
    const data = await response.json();
    return {
      isError: false,
      content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
    };
  }

  const text = await response.text();
  return {
    isError: false,
    content: [{ type: "text", text }],
  };
}

async function handleQuickScreenshot(args: any): Promise<CallToolResult> {
  const { url, fullPage, delay, resourceName } = args;
  if (typeof url !== "string" || !url.trim()) {
    return {
      isError: true,
      content: [{ type: "text", text: "URL is required." }],
    };
  }

  const response = await fetch(`${steelBaseURL}/v1/screenshot`, {
    method: "POST",
    headers: buildSteelHeaders(),
    body: JSON.stringify({
      url,
      ...(typeof fullPage === "boolean" ? { fullPage } : {}),
      ...(typeof delay === "number" ? { delay } : {}),
    }),
  });

  if (!response.ok) {
    try {
      const browser = await sessionManager.ensureBrowser();
      const tempPage = await browser.newPage();
      try {
        await tempPage.goto(url, { waitUntil: "domcontentloaded" });
        const buffer = Buffer.from(
          await tempPage.screenshot({ fullPage: !!fullPage })
        );
        const name = resourceName || `quick_screenshot_${Date.now()}`;
        screenshots.set(name, buffer);
        return {
          isError: false,
          content: [
            {
              type: "text",
              text: `Quick screenshot saved as resource screenshot://${name} (browser fallback)`,
            },
          ],
        };
      } finally {
        await tempPage.close().catch(() => undefined);
      }
    } catch {
      return {
        isError: true,
        content: [
          {
            type: "text",
            text: `Screenshot failed: ${response.status} ${response.statusText}`,
          },
        ],
      };
    }
  }

  const buffer = Buffer.from(await response.arrayBuffer());
  const name = resourceName || `quick_screenshot_${Date.now()}`;
  screenshots.set(name, buffer);

  return {
    isError: false,
    content: [
      {
        type: "text",
        text: `Quick screenshot saved as resource screenshot://${name}`,
      },
    ],
  };
}

async function handleQuickPdf(args: any): Promise<CallToolResult> {
  const { url, resourceName } = args;
  if (typeof url !== "string" || !url.trim()) {
    return {
      isError: true,
      content: [{ type: "text", text: "URL is required." }],
    };
  }

  const response = await fetch(`${steelBaseURL}/v1/pdf`, {
    method: "POST",
    headers: buildSteelHeaders(),
    body: JSON.stringify({ url }),
  });

  if (!response.ok) {
    try {
      const browser = await sessionManager.ensureBrowser();
      const tempPage = await browser.newPage();
      try {
        await tempPage.goto(url, { waitUntil: "domcontentloaded" });
        const buffer = Buffer.from(
          await tempPage.pdf({ format: "A4", printBackground: true })
        );
        const name = resourceName || `pdf_${Date.now()}`;
        pdfs.set(name, buffer);
        return {
          isError: false,
          content: [
            {
              type: "text",
              text: `PDF saved as resource pdf://${name} (browser fallback)`,
            },
          ],
        };
      } finally {
        await tempPage.close().catch(() => undefined);
      }
    } catch {
      return {
        isError: true,
        content: [
          {
            type: "text",
            text: `PDF generation failed: ${response.status} ${response.statusText}`,
          },
        ],
      };
    }
  }

  const buffer = Buffer.from(await response.arrayBuffer());
  const name = resourceName || `pdf_${Date.now()}`;
  pdfs.set(name, buffer);

  return {
    isError: false,
    content: [
      {
        type: "text",
        text: `PDF saved as resource pdf://${name}`,
      },
    ],
  };
}
/**
 * Main dispatcher for handling tool calls
 */
async function handleToolCall(
  name: string,
  args: any
): Promise<CallToolResult> {
  const startTime = Date.now();

  try {
    if (name === "session_info") {
      return await handleSessionInfo();
    }
    if (name === "session_reset") {
      return await handleSessionReset();
    }
    // Ensure a valid session
    let page = await sessionManager.ensureActivePage();
    const initialTabState = await sessionManager.getTabState();
    let result: CallToolResult;

    switch (name) {
      case "navigate":
        result = await handleNavigate(page, args);
        break;
      case "search":
        result = await handleSearch(page, args);
        break;
      case "click":
        result = await handleClick(page, args);
        break;
      case "type":
        result = await handleType(page, args);
        break;
      case "scroll_down":
        result = await handleScrollDown(page, args);
        break;
      case "scroll_up":
        result = await handleScrollUp(page, args);
        break;
      case "go_back":
        result = await handleGoBack(page);
        break;
      case "wait":
        result = await handleWait(page, args);
        break;
      case "session_info":
        result = await handleSessionInfo();
        break;
      case "session_reset":
        result = await handleSessionReset();
        break;
      case "save_unmarked_screenshot":
        result = await handleSaveUnmarkedScreenshot(page, args);
        break;
      case "quick_scrape":
        result = await handleQuickScrape(args);
        break;
      case "quick_screenshot":
        result = await handleQuickScreenshot(args);
        break;
      case "quick_pdf":
        result = await handleQuickPdf(args);
        break;
      case "list_tabs":
        result = await handleListTabs();
        break;
      case "new_tab":
        result = await handleNewTab(args);
        break;
      case "switch_tab":
        result = await handleSwitchTab(args);
        break;
      case "close_tab":
        result = await handleCloseTab(args);
        break;
      case "reload":
        result = await handleReload(page);
        break;
      case "go_forward":
        result = await handleGoForward(page);
        break;
      case "stop_loading":
        result = await handleStopLoading(page);
        break;
      case "set_viewport":
        result = await handleSetViewport(page, args);
        break;
      case "get_page_info":
        result = await handleGetPageInfo(page);
        break;
      case "get_url":
        result = await handleGetUrl(page);
        break;
      case "get_title":
        result = await handleGetTitle(page);
        break;
      case "get_text":
        result = await handleGetText(page, args);
        break;
      case "get_html":
        result = await handleGetHtml(page, args);
        break;
      case "evaluate":
        result = await handleEvaluate(page, args);
        break;
      case "click_selector":
        result = await handleClickSelector(page, args);
        break;
      case "type_selector":
        result = await handleTypeSelector(page, args);
        break;
      case "select_option":
        result = await handleSelectOption(page, args);
        break;
      case "press_key":
        result = await handlePressKey(page, args);
        break;
      case "hover":
        result = await handleHover(page, args);
        break;
      case "drag":
        result = await handleDrag(page, args);
        break;
      case "wait_for_selector":
        result = await handleWaitForSelector(page, args);
        break;
      case "wait_for_url":
        result = await handleWaitForUrl(page, args);
        break;
      case "get_cookies":
        result = await handleGetCookies(page);
        break;
      case "set_cookies":
        result = await handleSetCookies(page, args);
        break;
      case "clear_cookies":
        result = await handleClearCookies(page);
        break;
      case "get_local_storage":
        result = await handleGetLocalStorage(page);
        break;
      case "set_local_storage":
        result = await handleSetLocalStorage(page, args);
        break;
      case "clear_local_storage":
        result = await handleClearLocalStorage(page);
        break;
      case "upload_file":
        result = await handleUploadFile(page, args);
        break;
      case "screenshot":
        result = await handleScreenshot(page, args);
        break;
      default:
        result = {
          isError: true,
          content: [
            {
              type: "text",
              text: `Unknown tool: ${name}. Available tools are: ${TOOLS.map(
                (t) => t.name
              ).join(", ")}.`,
            },
          ],
        };
        break;
    }

    // If tool resulted in an error, just return it
    if (result.isError) {
      return result;
    }

    const updatedTabState = await sessionManager.getTabState();
    if (updatedTabState.count > initialTabState.count) {
      const newestIndex = updatedTabState.count - 1;
      if (updatedTabState.activeIndex !== newestIndex) {
        page = await sessionManager.switchToTab(newestIndex);
      } else {
        page = await sessionManager.ensureActivePage();
      }

      result.content.unshift({
        type: "text",
        text: `New tab detected. Active tab is now index ${newestIndex}.`,
      });
    }

    // Optionally wait a global number of seconds for slow pages
    if (globalWaitSeconds > 0) {
      await sleep(globalWaitSeconds * 1000);
    }

    // Re-inject marking script so bounding boxes are updated
    await sessionManager.injectMarkPageScript(page);

    if (autoScreenshotEnabled) {
      // Capture updated annotated screenshot only when explicitly enabled.
      const screenshotBuffer = await page.screenshot();
      result.content.push({
        type: "image",
        data: Buffer.from(screenshotBuffer).toString("base64"),
        mimeType: "image/png",
      });
    }

    console.error(
      JSON.stringify({
        message: `Action completed in ${Date.now() - startTime}ms`,
      })
    );

    return result;
  } catch (error) {
    // Attempt to recover if the session is no longer valid
    const wasSessionError = await sessionManager.handleError(error as Error);
    if (wasSessionError) {
      // We recreated the session, let the user try again
      return {
        isError: true,
        content: [
          {
            type: "text",
            text:
              "Browser session ended unexpectedly. A new session has been created. " +
              "Please retry your request.",
          },
        ],
      };
    }

    // Return the original error if we didn't recover
    return {
      isError: true,
      content: [
        {
          type: "text",
          text: `Tool ${name} failed: ${
            (error as Error).message
          }\nStack trace: ${(error as Error).stack}`,
        },
      ],
    };
  }
}

// -----------------------------------------------------------------------------
// Create and Configure MCP Server
// -----------------------------------------------------------------------------
function createConfiguredServer() {
  const server = new Server(
    {
      name: "steel-mcp-server",
      version: "0.1.0",
    },
    {
      capabilities: {
        resources: {},
        tools: {},
      },
    }
  );

  // -----------------------------------------------------------------------------
  // Server Request Handlers
  // -----------------------------------------------------------------------------
  server.setRequestHandler(ListResourcesRequestSchema, async () => ({
    resources: [
      ...Array.from(screenshots.keys()).map((name) => ({
        uri: `screenshot://${name}`,
        mimeType: "image/png",
        name: `Screenshot: ${name}`,
      })),
      ...Array.from(pdfs.keys()).map((name) => ({
        uri: `pdf://${name}`,
        mimeType: "application/pdf",
        name: `PDF: ${name}`,
      })),
      {
        uri: "console://logs",
        mimeType: "text/plain",
        name: "Console Logs",
      },
    ],
  }));

  server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
    const uri = request.params.uri;
    if (uri.startsWith("screenshot://")) {
      const name = uri.split("://")[1];
      const screenshot = screenshots.get(name);
      if (screenshot) {
        return {
          contents: [
            {
              uri,
              mimeType: "image/png",
              blob: screenshot.toString("base64"),
            },
          ],
        };
      }
    }
    if (uri.startsWith("pdf://")) {
      const name = uri.split("://")[1];
      const pdf = pdfs.get(name);
      if (pdf) {
        return {
          contents: [
            {
              uri,
              mimeType: "application/pdf",
              blob: pdf.toString("base64"),
            },
          ],
        };
      }
    }
    if (uri === "console://logs") {
      return {
        contents: [
          {
            uri,
            mimeType: "text/plain",
            text: consoleLogs.join("\n"),
          },
        ],
      };
    }
    throw new Error(`Resource not found: ${uri}`);
  });

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: TOOLS,
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) =>
    handleToolCall(request.params.name, request.params.arguments ?? {})
  );

  return server;
}

// -----------------------------------------------------------------------------
// Start the Server
// -----------------------------------------------------------------------------
type HttpSession = {
  server: Server;
  transport: StreamableHTTPServerTransport;
};

const activeHttpSessions = new Map<string, HttpSession>();

const mcpHttpHost = process.env.MCP_HTTP_HOST || "127.0.0.1";
const mcpHttpPort = Number(process.env.MCP_HTTP_PORT) || 8787;

async function runServer() {
  console.error(
    JSON.stringify({
      message: "Starting Web Voyager MCP HTTP server...",
      host: mcpHttpHost,
      port: mcpHttpPort,
      path: "/mcp",
    })
  );

  const app = createMcpExpressApp({ host: mcpHttpHost });

  app.get("/health", (_req: any, res: any) => {
    res.json({ status: "ok" });
  });

  app.post("/mcp", async (req: any, res: any) => {
    const sessionId = req.headers["mcp-session-id"];
    const existingSession =
      typeof sessionId === "string"
        ? activeHttpSessions.get(sessionId)
        : undefined;

    try {
      if (existingSession) {
        await existingSession.transport.handleRequest(req, res, req.body);
        return;
      }

      if (!sessionId && isInitializeRequest(req.body)) {
        const server = createConfiguredServer();
        const transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => randomUUID(),
          onsessioninitialized: (initializedSessionId) => {
            activeHttpSessions.set(initializedSessionId, {
              server,
              transport,
            });
          },
        });

        transport.onclose = async () => {
          const transportSessionId = transport.sessionId;
          if (transportSessionId) {
            activeHttpSessions.delete(transportSessionId);
          }
        };

        await server.connect(transport);
        await transport.handleRequest(req, res, req.body);
        return;
      }

      res.status(400).json({
        jsonrpc: "2.0",
        error: {
          code: -32000,
          message: "Bad Request: No valid session ID provided",
        },
        id: null,
      });
    } catch (error) {
      console.error(
        JSON.stringify({
          message: "HTTP MCP request error",
          error: (error as Error).message,
          stack: (error as Error).stack,
        })
      );
      if (!res.headersSent) {
        res.status(500).json({
          jsonrpc: "2.0",
          error: {
            code: -32603,
            message: "Internal server error",
          },
          id: null,
        });
      }
    }
  });

  app.get("/mcp", async (req: any, res: any) => {
    const sessionId = req.headers["mcp-session-id"];
    const transport =
      typeof sessionId === "string"
        ? activeHttpSessions.get(sessionId)?.transport
        : undefined;

    if (!sessionId || !transport) {
      res.status(400).send("Invalid or missing session ID");
      return;
    }

    await transport.handleRequest(req, res);
  });

  app.delete("/mcp", async (req: any, res: any) => {
    const sessionId = req.headers["mcp-session-id"];
    const transport =
      typeof sessionId === "string"
        ? activeHttpSessions.get(sessionId)?.transport
        : undefined;

    if (!sessionId || !transport) {
      res.status(400).send("Invalid or missing session ID");
      return;
    }

    await transport.handleRequest(req, res);
  });

  await new Promise<void>((resolve, reject) => {
    const server = app.listen(mcpHttpPort, mcpHttpHost, (error?: Error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });

    server.on("error", reject);
  });

  console.error(
    JSON.stringify({
      message: "Web Voyager MCP HTTP server ready",
      endpoint: `http://${mcpHttpHost}:${mcpHttpPort}/mcp`,
    })
  );
}

// -----------------------------------------------------------------------------
// Graceful Shutdown
// -----------------------------------------------------------------------------
process.on("SIGINT", async () => {
  console.error(JSON.stringify({ message: "Received SIGINT, cleaning up..." }));
  for (const session of activeHttpSessions.values()) {
    await session.transport.close().catch(() => undefined);
  }
  activeHttpSessions.clear();
  await sessionManager.cleanup();
  process.exit(0);
});

process.on("SIGTERM", async () => {
  console.error(
    JSON.stringify({ message: "Received SIGTERM, cleaning up..." })
  );
  for (const session of activeHttpSessions.values()) {
    await session.transport.close().catch(() => undefined);
  }
  activeHttpSessions.clear();
  await sessionManager.cleanup();
  process.exit(0);
});

// -----------------------------------------------------------------------------
// Execute
// -----------------------------------------------------------------------------
runServer().catch((error) => {
  console.error("Unhandled error in server:", error);
  process.exit(1);
});
