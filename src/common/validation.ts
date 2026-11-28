export const acpBackendPattern = /^[a-z0-9][a-z0-9-]{0,63}$/;

export function isAcpBackend(value: unknown): value is string {
  return typeof value === "string" && acpBackendPattern.test(value);
}

export function requireThat(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

/** Shared grammar for host and dimension identifiers in history archives and queries. */
export const historyIdentifierPattern = /^[a-z0-9][a-z0-9-]{0,63}$/;
export function isHistoryIdentifier(value: unknown): value is string {
  return typeof value === "string" && historyIdentifierPattern.test(value);
}

export function isOneOf<T extends string>(value: unknown, choices: readonly T[]): value is T {
  return typeof value === "string" && (choices as readonly string[]).includes(value);
}
