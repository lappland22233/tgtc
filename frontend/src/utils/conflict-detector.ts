import { useFolderStore } from '../stores/folders';

/**
 * 文件夹上传重复检测工具。
 *
 * 在入队前按目标目录查询既有文件，按 originalName 区分大小写精确匹配，
 * 产出冲突项（供决策弹窗）与无冲突项（直接入队）。
 *
 * 设计要点：
 * - 按唯一 folderId 去重后查询 contents，独立微型限流器（并发 2，不占上传令牌池）；
 * - 既有文件 status === 'processing' 的命中项不可覆盖，标记 overwriteBlocked
 *   并归入 clean（按新文件上传），不进入决策弹窗；
 * - 单个目录 contents 查询失败时记 console.warn，该目录文件按无冲突处理，不阻塞上传。
 */

/** 文件夹链路入队候选项（与 UploadModal 组装的 items 结构一致） */
export interface UploadCandidateItem {
  file: File;
  folderId: string | null;
  relativePath?: string;
}

/** 检测到与既有文件重名的冲突项 */
export interface ConflictItem {
  item: UploadCandidateItem;
  existingId: string;
  existingSize: number;
  /** 既有文件处理中（status==='processing'）不可覆盖：本次应按新文件上传 */
  overwriteBlocked?: boolean;
}

export interface DetectConflictsResult {
  conflicts: ConflictItem[];
  clean: UploadCandidateItem[];
  /** 既有文件处理中而不可覆盖、已按新文件上传归入 clean 的数量（供 UI 提示） */
  blockedCount: number;
}

/** 单个冲突项的用户决策 */
export type ConflictDecision = 'overwrite' | 'skip';

/** 决策弹窗确认时回传的决策结果项 */
export interface ConflictDecisionEntry {
  conflict: ConflictItem;
  decision: ConflictDecision;
}

/** contents 查询的独立微型限流并发数（不占上传令牌池） */
const DETECT_CONCURRENCY = 2;

/**
 * 独立微型限流器：最多 limit 个任务同时在途，保持输入顺序的结果数组。
 * 与 uploadScheduler 完全独立——查重是轻量 JSON 请求，不应挤占上传带宽。
 */
async function runLimited<T>(tasks: Array<() => Promise<T>>, limit: number): Promise<T[]> {
  const results: T[] = new Array(tasks.length);
  let nextIndex = 0;
  const workerCount = Math.min(limit, tasks.length);
  const workers: Promise<void>[] = [];
  for (let w = 0; w < workerCount; w++) {
    workers.push(
      (async () => {
        for (;;) {
          const i = nextIndex++;
          if (i >= tasks.length) return;
          results[i] = await tasks[i]();
        }
      })(),
    );
  }
  await Promise.all(workers);
  return results;
}

/** 目录内既有文件索引条目 */
interface ExistingFile {
  id: string;
  size: number;
  status?: 'processing' | 'ready' | 'error';
}

/**
 * 检测候选 items 与目标目录既有文件的重名冲突。
 *
 * @param items 已组装好的 {file, folderId, relativePath} 候选项
 * @returns conflicts: 需用户决策的重名项；clean: 无冲突/不可覆盖（按新文件上传）项
 */
export async function detectConflicts(
  items: UploadCandidateItem[],
): Promise<DetectConflictsResult> {
  if (items.length === 0) return { conflicts: [], clean: [], blockedCount: 0 };

  const folderStore = useFolderStore();

  // 1. 唯一 folderId 去重（null 即根目录），键用 'root' 占位
  const uniqueFolderIds: Array<string | null> = [];
  const seen = new Set<string>();
  for (const item of items) {
    const key = item.folderId ?? 'root';
    if (!seen.has(key)) {
      seen.add(key);
      uniqueFolderIds.push(item.folderId);
    }
  }

  // 2. 并发受限地拉取各目录 contents，构建 folderId → Map<originalName, 既有文件> 索引。
  //    单个目录查询失败时记 warn 并置 null：该目录文件按无冲突处理，不阻塞上传。
  const index = new Map<string | null, Map<string, ExistingFile> | null>();
  await runLimited(
    uniqueFolderIds.map((folderId) => async () => {
      try {
        const contents = await folderStore.listContents(folderId);
        const byName = new Map<string, ExistingFile>();
        for (const f of contents.files ?? []) {
          if (!byName.has(f.originalName)) {
            byName.set(f.originalName, { id: f.id, size: f.size, status: f.status });
          }
        }
        index.set(folderId, byName);
      } catch (err) {
        console.warn('[重复检测] 目录 contents 查询失败，该目录按无冲突处理:', err);
        index.set(folderId, null);
      }
    }),
    DETECT_CONCURRENCY,
  );

  // 3. 逐项精确匹配（区分大小写，禁止 toLowerCase）
  const conflicts: ConflictItem[] = [];
  const clean: UploadCandidateItem[] = [];
  let blockedCount = 0;
  for (const item of items) {
    const byName = index.get(item.folderId) ?? null;
    const existing = byName?.get(item.file.name);
    if (!existing) {
      clean.push(item);
      continue;
    }
    if (existing.status === 'processing') {
      // 既有文件处理中不可覆盖：归入 clean 走新建上传
      blockedCount++;
      clean.push(item);
      continue;
    }
    conflicts.push({
      item,
      existingId: existing.id,
      existingSize: existing.size,
      overwriteBlocked: false,
    });
  }

  return { conflicts, clean, blockedCount };
}
