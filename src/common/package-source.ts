import { prerelease, satisfies, valid } from "semver";

export function npmName(source: string): string | undefined {
  return /^npm:((?:@[a-z0-9._-]+\/)?[a-z0-9._-]+)(?:@[^\s]+)?$/.exec(source)?.[1];
}
export function ordinaryNpm(source: string): boolean {
  const name = npmName(source);
  return name !== undefined && (source === `npm:${name}` || source === `npm:${name}@latest`);
}
export function checkStableVersion(version: string, nodeRange?: string): string {
  if (!valid(version) || prerelease(version)) throw new Error(`latest 不是稳定版本：${version}`);
  if (nodeRange && !satisfies(process.versions.node, nodeRange)) {
    throw new Error(`目标版本要求 Node.js ${nodeRange}，当前为 ${process.versions.node}。请先升级 Node.js。`);
  }
  return version;
}
