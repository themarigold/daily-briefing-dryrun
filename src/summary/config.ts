// The only reader of Config.aiSummary. Pure and silent: diagnostics belong only
// to summary status, never the morning warning lists, page, envelope or streams.
export type AiSummaryConfigWarning = "summary-config-invalid";

export type ResolvedAiSummary = {
  enabled: boolean;
  warnings: AiSummaryConfigWarning[];
};

function invalid(): ResolvedAiSummary {
  return { enabled: false, warnings: ["summary-config-invalid"] };
}

/** Absent, {} and enabled: false are off without a warning. Malformations
 *  disable the whole block with one fixed code, never a configured value. */
export function resolveAiSummary(raw: unknown): ResolvedAiSummary {
  if (raw === undefined) return { enabled: false, warnings: [] };
  try {
    if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return invalid();
    if (Reflect.ownKeys(raw).some((key) => key !== "enabled")) return invalid();
    // Like the calendar resolver, inspect only an own data property. Never
    // invoke an accessor or inherit enabled from a caller's prototype.
    const descriptor = Object.getOwnPropertyDescriptor(raw, "enabled");
    if (descriptor && !("value" in descriptor)) return invalid();
    const enabled: unknown = descriptor?.value;
    if (enabled !== undefined && typeof enabled !== "boolean") return invalid();
    return { enabled: enabled === true, warnings: [] };
  } catch {
    // Non-JSON callers can supply a Proxy that throws during inspection.
    return invalid();
  }
}
