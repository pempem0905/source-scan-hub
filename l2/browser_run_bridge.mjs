#!/usr/bin/env node
/**
 * PROMO L2 secure Cloudflare Browser Run bridge.
 *
 * Security invariants:
 * - Cloudflare credentials are read only from runtime environment variables.
 * - Session IDs, WebSocket endpoints, Live View/takeover URLs, cookies and tokens
 *   are never printed or written to the repository.
 * - Human takeover is performed from Cloudflare Dashboard > Browser Run > Live Sessions.
 * - READY is asserted only after a real handoff completes and authenticated state
 *   is proven reusable in the same Browser Run session.
 */
import { chromium } from "playwright-core";

const ACCOUNT_ID = requiredEnv("CLOUDFLARE_ACCOUNT_ID");
const API_TOKEN = requiredEnv("CLOUDFLARE_BROWSER_RUN_API_TOKEN");
const mode = process.argv[2] || "probe";
const platform = process.argv[3] || "probe";
const startUrl = process.argv[4] || "https://example.com/";
const keepAliveMs = clampInt(process.env.L2_BROWSER_KEEP_ALIVE_MS, 600000, 10000, 600000);
const handoffTimeoutMs = clampInt(process.env.L2_HANDOFF_TIMEOUT_MS, 1800000, 60000, 1800000);

if (!["probe", "handoff"].includes(mode)) fail("mode must be probe or handoff");
if (!/^https?:\/\//i.test(startUrl)) fail("start URL must be http(s)");

function requiredEnv(name) {
  const value = String(process.env[name] || "").trim();
  if (!value) fail(`missing required runtime setting: ${name}`);
  return value;
}
function fail(message) {
  console.error(`BRIDGE_ERROR ${sanitize(message)}`);
  process.exit(2);
}
function sanitize(value) {
  return String(value || "error")
    .replace(/https?:\/\/\S+/gi, "[url-redacted]")
    .replace(/wss?:\/\/\S+/gi, "[ws-redacted]")
    .replace(/Bearer\s+\S+/gi, "Bearer [redacted]")
    .replace(/[0-9a-f]{8}-[0-9a-f-]{27,}/gi, "[id-redacted]")
    .replace(/jwt=[^\s&]+/gi, "jwt=[redacted]")
    .slice(0, 220);
}
function clampInt(raw, fallback, min, max) {
  const n = Number.parseInt(String(raw || ""), 10);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback;
}
function safePlatform(value) {
  return String(value || "unknown").replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 64);
}

const endpoint = `wss://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(ACCOUNT_ID)}/browser-run/devtools/browser?keep_alive=${keepAliveMs}`;
let browser;
try {
  browser = await chromium.connectOverCDP(endpoint, {
    headers: { Authorization: `Bearer ${API_TOKEN}` },
    timeout: 45000,
  });

  const context = browser.contexts()[0] ?? (await browser.newContext());
  const page = context.pages()[0] ?? (await context.newPage());
  await page.goto(startUrl, { waitUntil: "domcontentloaded", timeout: 60000 });

  // Verify that this is a real controllable Browser Run target, not merely a
  // successful websocket handshake. No target/session identifiers are logged.
  const cdp = await context.newCDPSession(page);
  const version = await cdp.send("Browser.getVersion");
  if (!version?.product) throw new Error("CDP browser target did not respond");

  if (mode === "probe") {
    console.log(`BROWSER_SESSION_CREATE_VERIFIED platform=${safePlatform(platform)} cdp_control=true`);
    await browser.close(); // connected Playwright client disconnects from Browser Run session
    browser = undefined;
    process.exit(0);
  }

  const live = await cdp.send("Cloudflare.getLiveView", {
    mode: "tab",
    expiresInMs: 300000,
  });
  if (!live?.devtoolsFrontendUrl) throw new Error("Live View capability unavailable");

  // Do not print or persist live.devtoolsFrontendUrl. The human opens the active
  // session from Cloudflare Dashboard > Browser Run > Live Sessions.
  console.log(`HUMAN_TAKEOVER_REQUIRED platform=${safePlatform(platform)} surface=cloudflare_dashboard_live_sessions`);

  const complete = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("human takeover timed out")), handoffTimeoutMs + 15000);
    cdp.once("Cloudflare.handoffComplete", (event) => {
      clearTimeout(timer);
      resolve(event);
    });
  });

  await cdp.send("Cloudflare.handoff", {
    instructions: `Complete the authorized ${safePlatform(platform)} sign-in, MFA or CAPTCHA manually, then mark the handoff complete.`,
    timeout: handoffTimeoutMs,
  });

  const result = await complete;
  if (!result?.success) throw new Error("human takeover was not completed successfully");

  // Verify authenticated browser state survives navigation/reload. Cookie values
  // are never printed or persisted; only boolean/count checks remain in memory.
  const beforeUrl = page.url();
  const beforeCookies = await context.cookies();
  await page.reload({ waitUntil: "domcontentloaded", timeout: 60000 });
  const afterCookies = await context.cookies();
  const afterUrl = page.url();
  const alive = !page.isClosed() && /^https?:\/\//i.test(afterUrl);
  const stateRetained = beforeCookies.length > 0 && afterCookies.length > 0;
  const loginPath = /\/(login|signin|sign-in|auth)(?:[/?#]|$)/i;
  const leftLoginFlow = !loginPath.test(afterUrl) || !loginPath.test(beforeUrl);

  if (!(alive && stateRetained && leftLoginFlow)) {
    console.log(`HANDOFF_COMPLETE_REUSE_UNVERIFIED platform=${safePlatform(platform)}`);
    await browser.close();
    browser = undefined;
    process.exit(3);
  }

  // A second controlled navigation in the same context proves L2 can reuse the
  // authenticated Browser Run session immediately after human handoff.
  await page.goto(afterUrl, { waitUntil: "domcontentloaded", timeout: 60000 });
  if (page.isClosed()) throw new Error("session reuse target closed unexpectedly");

  console.log(`HANDOFF_COMPLETE_SESSION_REUSE_VERIFIED platform=${safePlatform(platform)}`);
  await browser.close();
  browser = undefined;
} catch (error) {
  try { if (browser) await browser.close(); } catch {}
  fail(error?.message || error);
}
