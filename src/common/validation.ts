export const acpBackendPattern = /^[a-z0-9][a-z0-9-]{0,63}$/;

export function isAcpBackend(value: unknown): value is string {
  return typeof value === "string" && acpBackendPattern.test(value);
}

export function requireThat(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}
