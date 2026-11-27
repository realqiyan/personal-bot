import { lstatSync } from "node:fs";
import { join } from "node:path";
import { requireThat } from "../../common/validation.js";
import type { HistoryMigrationConflict, HistoryMigrationItem, HistoryMigrationReport } from "../../model/history.js";
import { HistoryFiles, rawHistoryBucket, summaryArtifactBucket } from "../../storage/history-files.js";
import { readWorkspaceHistoryLayoutSync } from "../workspace/workspace-config.js";

export interface MigrateHistoryOptions {
  dryRun?: boolean;
}

/** Read-only check for unmigrated flat history files when running under monthly layout. */
export function checkHistoryMigrationNotice(root: string): string | undefined {
  const layout = readWorkspaceHistoryLayoutSync(root);
  if (layout !== "monthly") return undefined;
  const files = new HistoryFiles(join(root, ".pbot/history"), "pi", layout);
  return files.detectFlatFiles().message;
}

/**
 * Explicitly migrate flat .pbot/history/raw/*.json and .pbot/history/summaries/<dim>/*.json
 * into UTC YYYY/MM/ (or unknown/) buckets. Moves files directly without keeping duplicates
 * and never modifies .pbot/config.json or overwrites existing destinations.
 */
export function migrateWorkspaceHistory(root: string, options: MigrateHistoryOptions = {}): HistoryMigrationReport {
  const layout = readWorkspaceHistoryLayoutSync(root);
  requireThat(
    layout === "monthly",
    '当前工作区配置为平铺布局（history.layout: "flat"），无需迁移到年月目录；如需迁移，请先在 .pbot/config.json 中将 history.layout 设为 "monthly" 或移除该配置项。',
  );
  const dryRun = Boolean(options.dryRun);
  const files = new HistoryFiles(join(root, ".pbot/history"), "pi", "monthly");
  const moved: HistoryMigrationItem[] = [];
  const skipped: HistoryMigrationConflict[] = [];
  const errors: { path: string; error: string }[] = [];

  const run = () => {
    for (const name of files.listFlatRawFiles()) {
      const from = `raw/${name}`;
      try {
        const raw = files.readFlatRawFile(name);
        const bucket = rawHistoryBucket(raw);
        const to = `raw/${bucket}/${name}`;
        if (dryRun) {
          if (lstatSync(join(files.directory, to), { throwIfNoEntry: false })) {
            skipped.push({ kind: "raw", from, to, reason: "目标路径已存在同名文件。" });
          } else {
            moved.push({ kind: "raw", id: raw.id, from, to });
          }
        } else {
          const outcome = files.moveHistoryFile(from, to);
          if (outcome === "moved") moved.push({ kind: "raw", id: raw.id, from, to });
          else skipped.push({ kind: "raw", from, to, reason: "目标路径已存在同名文件。" });
        }
      } catch (error) {
        errors.push({ path: join(files.directory, from), error: error instanceof Error ? error.message : String(error) });
      }
    }

    for (const dimension of files.listDimensions()) {
      for (const name of files.listFlatSummaryFiles(dimension)) {
        const from = `summaries/${dimension}/${name}`;
        try {
          const artifact = files.readFlatSummaryFile(dimension, name);
          const bucket = summaryArtifactBucket(artifact);
          const to = `summaries/${dimension}/${bucket}/${name}`;
          if (dryRun) {
            if (lstatSync(join(files.directory, to), { throwIfNoEntry: false })) {
              skipped.push({ kind: "summary", dimension, from, to, reason: "目标路径已存在同名文件。" });
            } else {
              moved.push({ kind: "summary", dimension, id: artifact.id, from, to });
            }
          } else {
            const outcome = files.moveHistoryFile(from, to);
            if (outcome === "moved") moved.push({ kind: "summary", dimension, id: artifact.id, from, to });
            else skipped.push({ kind: "summary", dimension, from, to, reason: "目标路径已存在同名文件。" });
          }
        } catch (error) {
          errors.push({ path: join(files.directory, from), error: error instanceof Error ? error.message : String(error) });
        }
      }
    }
  };

  if (dryRun) run();
  else files.controlMigration(run);

  return { layout, dryRun, moved, skipped, errors };
}
