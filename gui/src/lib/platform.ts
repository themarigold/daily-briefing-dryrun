/**
 * v0.2.1 §3.5 — which operating system this window is running on, read from the webview's own
 * user agent.
 *
 * ⚠ NO TAURI COMMAND, ON PURPOSE (spec §3.5 r6). Asking Rust would add a command to the pinned
 * capability surface (`build.rs`, `capabilities/default.json`, `EXPECTED_GRANTS` in
 * `tests/capability.rs`, the generated permissions). The webview already knows: macOS's WKWebView
 * says "Macintosh" and Linux's WebKitGTK says "Linux" in `navigator.userAgent`.
 *
 * Pure, so `tests-web/wizard.check.ts` can drive it with real user-agent strings.
 */

export type Os = "macos" | "linux" | "windows" | "other";

/**
 * The OS a user agent names.
 *
 * Checked in this order, because the tokens overlap:
 * 1. "Android" or "CrOS" → `other`. Android user agents also say "Linux", and ChromeOS ones say
 *    "X11; CrOS"; neither runs this app.
 * 2. "iPhone", "iPad" or "iPod" → `other`. Their user agents say "like Mac OS X", not "Macintosh",
 *    so this rule only makes the answer explicit. (An iPad asking for the desktop site says
 *    "Macintosh" and reads as `macos`; this app does not run on iPadOS.)
 * 3. "Macintosh" → `macos` (WKWebView).
 * 4. "Windows" → `windows` (WebView2).
 * 5. "Linux" → `linux` (WebKitGTK).
 * 6. Anything else, including an empty string → `other`.
 */
export function osFromUserAgent(ua: string): Os {
  if (/Android|CrOS/.test(ua)) return "other";
  if (/iPhone|iPad|iPod/.test(ua)) return "other";
  if (ua.includes("Macintosh")) return "macos";
  if (ua.includes("Windows")) return "windows";
  if (ua.includes("Linux")) return "linux";
  return "other";
}
