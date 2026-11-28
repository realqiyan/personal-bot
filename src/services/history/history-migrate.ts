import { join } from "node:path";
import { requireThat } from "../../common/validation.js";
import type { HistoryMigrationConflict, HistoryMigrationItem, HistoryMigrationReport } from "../../model/history.js";
import { rawHistoryBucket, summaryArtifactBucket } from "../../storage/history-files.js";
import { workspaceHistoryFiles } from "./workspace-history.js";

export interface MigrateHistoryOptions {
  dryRun?: boolean;
}

/** Read-only check for unmigrated flat history files when running under monthly layout. */
export function checkHistoryMigrationNotice(root: string): string | undefined {
  return workspaceHistoryFiles(root).migrationNotice();
}

/**
 * Explicitly migrate flat .pbot/history/raw/*.json and .pbot/history/summaries/<dim>/*.json
 * into UTC YYYY/MM/ (or unknown/) buckets. Moves files directly without keeping duplicates
 * and never modifies .pbot/config.json or overwrites existing destinations.
 */
export function migrateWorkspaceHistory(root: string, options: MigrateHistoryOptions = {}): HistoryMigrationReport {
  const files = workspaceHistoryFiles(root);
  const { layout } = files;
  requireThat(
    layout === "monthly",
    '当前工作区配置为平铺布局（history.layout: "flat"），无需迁移到年月目录；如需迁移，请先在 .pbot/config.json 中将 history.layout 设为 "monthly" 或移除该配置项。',
  );
  const dryRun = Boolean(options.dryRun);
  const moved: HistoryMigrationItem[] = [];
  const skipped: HistoryMigrationConflict[] = [];
  const errors: { path: string; error: string }[] = [];

  function migrateFile(name: string, dimension?: string) {
    const directory = dimension ? `summaries/${dimension}` : "raw";
    const from = `${directory}/${name}`;
    try {
      const record = dimension ? files.readFlatSummaryFile(dimension, name) : files.readFlatRawFile(name);
      const bucket = "dimension" in record ? summaryArtifactBucket(record) : rawHistoryBucket(record);
      const to = `${directory}/${bucket}/${name}`;
      const source = dimension ? { kind: "summary" as const, dimension } : { kind: "raw" as const };
      if (files.moveHistoryFile(from, to, dryRun) === "conflict") {
        skipped.push({ ...source, from, to, reason: "目标路径已存在同名文件。" });
      } else {
        moved.push({ ...source, id: record.id, from, to });
      }
    } catch (error) {
      errors.push({ path: join(files.directory, from), error: error instanceof Error ? error.message : String(error) });
    }
  }

  const run = () => {
    for (const name of files.listFlatRawFiles()) migrateFile(name);
    for (const dimension of files.listDimensions()) {
      for (const name of files.listFlatSummaryFiles(dimension)) migrateFile(name, dimension);
    }
  };

  if (dryRun) run();
  else files.controlMigration(run);

  return { layout, dryRun, moved, skipped, errors };
}
