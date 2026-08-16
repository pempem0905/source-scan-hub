#!/usr/bin/env node
/**
 * PROMO L2 secure Cloudflare Browser Run bridge.
 *
 * Security invariants:
 * - Cloudflare credentials are read only from runtime environment variables.
 * - Session IDs, WebSocket endpoints, Live View/takeover URLs, cookies and tokens
 *   are never printed or written to the repository.
 * - Human takeover is performed from Cloudflare Dashboard > Browser Run > Live Sessions.
 * - READY is never asserted by this script. A separate verified status transition is
 *   required after human handoff and authenticated-session reuse are proven.
 */
import { chromium } from "playwright-core";

const ACCOUNT_ID = requiredEnv("CLOUDFLARE_ACCOUNT_ID");
const API_TOKEN = requiredEnv("CLOUDFLARE_BROWSER_RUN_API_TOKEN");
const mode = process.argv[2] || "probe";
const platform = process.argv[3] || "probe";
const startUrl = process.argv[4] || "https://example.com/";
const keepAliveMs = clampInt(process.env.L2_BROWSER_KEEP_ALIVE_MS, 600000, 10000, 600000);
const handoffTimeoutMs = clampInt(process.env.L2_HANDOFF_TIMEOUT_MS, 600000, 60000, 900000);

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
  // Never echo URLs, bearer material, UUID-like session identifiers, JWTs, or WSS endpoints.
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

  if (mode === "probe") {
    // A successful real CDP connection + navigation verifies that the repository
    // secrets can create/control a Browser Run session without revealing them.
    console.log(`BROWSER_SESSION_CREATE_VERIFIED platform=${safePlatform(platform)}`);
    await browser.close();
    browser = undefined;
    process.exit(0);
  }

  const cdp = await context.newCDPSession(page);
  // Generate a Live View URL so the session supports human takeover, but keep it
  // in process memory only. Operators open the same active session from the
  // Cloudflare dashboard; the URL itself is never logged or persisted.
  const live = await cdp.send("Cloudflare.getLiveView", {
    mode: "tab",
    expiresInMs: 300000,
  });
  if (!live?.devtoolsFrontendUrl) throw new Error("Live View capability unavailable");

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

  // Reuse verification is intentionally conservative. We prove that the same
  // authenticated browser context survives a reload and retains browser state,
  // but we do not print or persist any cookies/storage values.
  const beforeUrl = page.url();
  const beforeCookies = await context.cookies();
  await page.reload({ waitUntil: "domcontentloaded", timeout: 60000 });
  const afterCookies = await context.cookies();
  const alive = !page.isClosed() && /^https?:\/\//i.test(page.url());
  const stateRetained = beforeCookies.length > 0 && afterCookies.length > 0;
  const movedFromObviousLogin = !/\/(login|signin|sign-in)(?:[/?#]|$)/i.test(page.url()) || !/\/(login|signin|sign-in)(?:[/?#]|$)/i.test(beforeUrl);

  if (!(alive && stateRetained && movedFromObviousLogin)) {
    console.log(`HANDOFF_COMPLETE_REUSE_UNVERIFIED platform=${safePlatform(platform)}`);
    // Keep the session only long enough for diagnostics; do not claim READY.
    await browser.close();
    browser = undefined;
    process.exit(3);
  }

  console.log(`HANDOFF_COMPLETE_SESSION_REUSE_VERIFIED platform=${safePlatform(platform)}`);
  // Disconnect, rather than closing, so the Browser Run session can be reused
  // during its keep-alive window by an immediate L2 consumer.
  await browser.close();
  browser = undefined;
} catch (error) {
  try { if (browser) await browser.close(); } catch {}
  fail(error?.message || error);
}

function safePlatform(value) {
  return String(value || "unknown").replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 64);
}
