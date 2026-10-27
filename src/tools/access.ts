
/** Each tool is bound to one workspace instance, not a mutable global lookup. */
export interface CallAccess {
  check(): void;
  signal(signal?: AbortSignal): AbortSignal;
  authorizeFile(path: string, change: unknown, confirm: (value: unknown) => Promise<boolean>, signal: AbortSignal): Promise<void>;
}
