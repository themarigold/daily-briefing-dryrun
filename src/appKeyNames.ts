// src/appKeyNames.ts — the two names an app-owned API key lives under on macOS, as DATA (provider-fallback
// plan P1-M1-T2).
//
// `src/providerList.ts` (which re-exports them) and `src/keyStore.ts` build every Keychain argv from these
// constants, so the binary is named in exactly one place in src/. This file holds the names and nothing
// else: test/isolation.meta.test.ts R2 grants it a narrow allowance to name the binary, and asserts that it
// holds nothing but `export const X = "<literal>";` statements, so the allowance can never become a spawn. Tests import the
// constants from here, too: the isolation scanners never read src/, so a test that builds its argv from
// these names holds no literal naming the binary (see that file's never-reach scanner).

/** The Keychain service every app-owned key item is stored under. */
export const APP_KEY_SERVICE = "daily-briefing.app-key";

/** The Keychain tool, by absolute path: never resolved through PATH. */
export const SECURITY_BIN = "/usr/bin/security";
