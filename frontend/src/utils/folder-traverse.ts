import { validateRelativePath } from './folder-name';

/**
 * 文件夹上传采集工具：从 <input webkitdirectory> 或拖拽事件解析出
 * "文件 + 目录段"列表，供 folder-resolver 预创建目录、upload store 入队。
 */

/** 解析后的单个文件 */
export interface ParsedFile {
  file: File;
  /** 目录段数组（不含文件名）。根级文件为空数组 */
  dirSegments: string[];
  /** 目录段 join '/'（不含文件名）；根级文件为空串 */
  relativePath: string;
}

/** 路径校验违规项（调用方据此整批阻止入队） */
export interface PathViolation {
  file: File;
  relativePath: string;
  /** 违规段名称 */
  segment: string;
  /** 违规段在 dirSegments 中的位置 */
  index: number;
  reason: string;
}

/** 拖拽采集结果 */
export interface DropCollectResult {
  parsed: ParsedFile[];
  /** 拖入的顶层平铺文件（不属于任何目录） */
  plainFiles: File[];
  /** 空目录的相对路径清单 */
  emptyDirs: string[];
  /** Entry API 不可用/异常时为 true，此时 parsed/emptyDirs 为空，文件全部平铺在 plainFiles */
  degraded: boolean;
  /** 路径校验违规清单 */
  violations: PathViolation[];
}

/** 系统垃圾文件（跨平台），采集时直接跳过 */
const JUNK_FILE_NAMES = ['.ds_store', 'thumbs.db', 'desktop.ini'];

/** 每处理多少个文件让出一次事件循环，避免大目录树长时间阻塞 UI */
const YIELD_EVERY = 75;

function isJunkFile(fileName: string): boolean {
  return JUNK_FILE_NAMES.includes(fileName.toLowerCase());
}

function yieldToEventLoop(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

/**
 * 对 parsed 逐文件校验相对路径，返回全部违规项。
 * 调用方应在入队前调用；存在违规时整批阻止并提示。
 */
export function validateParsedFiles(parsed: ParsedFile[]): PathViolation[] {
  const violations: PathViolation[] = [];
  for (const p of parsed) {
    const res = validateRelativePath(p.dirSegments);
    if (!res.ok) {
      violations.push({
        file: p.file,
        relativePath: p.relativePath,
        segment: res.segment ?? '',
        index: res.index ?? -1,
        reason: res.reason ?? '目录名不合法',
      });
    }
  }
  return violations;
}

/**
 * 从 <input webkitdirectory> 的 FileList（或 File 数组）采集解析结果。
 *
 * 【首段保留推演结论】webkitRelativePath 形如 "所选文件夹/sub/data.txt"，
 * 产品语义要求"所选文件夹的根名作为一级目录在目标目录下创建"，
 * 因此 dirSegments = webkitRelativePath 去掉文件名后的全部段（保留首段）：
 *   - "根目录/sub/data.txt" → dirSegments = ['根目录', 'sub']
 *   - 平铺选择的文件（无 webkitRelativePath，如 web.config）→ dirSegments = []
 */
export function collectFromInput(files: FileList | File[]): ParsedFile[] {
  const parsed: ParsedFile[] = [];
  const list = Array.from(files);
  for (const file of list) {
    if (isJunkFile(file.name)) continue;
    // webkitRelativePath 为非标准属性，TS lib.dom 已声明；运行时缺失则按根级文件处理
    const rel = (file as File & { webkitRelativePath?: string }).webkitRelativePath || '';
    const allSegments = rel ? rel.split('/').filter((s) => s.length > 0) : [];
    // 去掉最后一段（文件名），剩余为目录段；保留首段（所选文件夹根名）
    const dirSegments = allSegments.slice(0, -1);
    parsed.push({
      file,
      dirSegments,
      relativePath: dirSegments.join('/'),
    });
  }
  return parsed;
}

/**
 * 从拖拽事件采集（webkitGetAsEntry 递归遍历，保留目录结构）。
 *
 * - readEntries 单次回调上限约 100 条，需循环读取直到返回空数组；
 * - 每处理约 75 个文件让出事件循环，避免大目录树阻塞 UI；
 * - Entry API 不可用或遍历异常时降级（degraded=true），仅返回平铺文件。
 */
export async function collectFromDrop(items: DataTransferItemList): Promise<DropCollectResult> {
  const result: DropCollectResult = {
    parsed: [],
    plainFiles: [],
    emptyDirs: [],
    degraded: false,
    violations: [],
  };

  // ---- 降级兜底：平铺收集所有文件 ----
  const degrade = () => {
    result.parsed = [];
    result.emptyDirs = [];
    result.plainFiles = [];
    result.degraded = true;
    for (let i = 0; i < items.length; i++) {
      const f = items[i].getAsFile();
      if (f && !isJunkFile(f.name)) result.plainFiles.push(f);
    }
  };

  // 能力检测：任一 item 不支持 webkitGetAsEntry 即整体降级
  try {
    for (let i = 0; i < items.length; i++) {
      if (typeof items[i].webkitGetAsEntry !== 'function') {
        degrade();
        return result;
      }
    }
  } catch {
    degrade();
    return result;
  }

  let processedCount = 0;

  /** FileSystemFileEntry.file() Promise 化 */
  const entryToFile = (entry: FileSystemFileEntry): Promise<File> =>
    new Promise((resolve, reject) => entry.file(resolve, reject));

  /** readEntries 单次读取 Promise 化（单次最多约 100 条，需循环调用） */
  const readEntriesOnce = (reader: FileSystemDirectoryReader): Promise<FileSystemEntry[]> =>
    new Promise((resolve, reject) => reader.readEntries(resolve, reject));

  /**
   * 递归遍历 Entry。
   * @param segments 当前文件所属目录段（不含文件名）；目录自身名称在递归进入时追加
   */
  const traverse = async (entry: FileSystemEntry, segments: string[]): Promise<void> => {
    if (entry.isFile) {
      const file = await entryToFile(entry as FileSystemFileEntry);
      if (isJunkFile(file.name)) return;
      processedCount++;
      if (processedCount % YIELD_EVERY === 0) await yieldToEventLoop();
      if (segments.length === 0) {
        // 顶层平铺文件
        result.plainFiles.push(file);
      } else {
        result.parsed.push({
          file,
          dirSegments: [...segments],
          relativePath: segments.join('/'),
        });
      }
      return;
    }

    if (entry.isDirectory) {
      const dirSegments = [...segments, entry.name];
      const reader = (entry as FileSystemDirectoryEntry).createReader();
      let childCount = 0;
      // 循环读取直到返回空数组（readEntries 单次上限约 100 条）
      for (;;) {
        const batch = await readEntriesOnce(reader);
        if (batch.length === 0) break;
        childCount += batch.length;
        for (const child of batch) {
          await traverse(child, dirSegments);
        }
      }
      // 空目录：无任何子条目，记录路径供调用方提示/预创建
      if (childCount === 0) {
        result.emptyDirs.push(dirSegments.join('/'));
      }
    }
  };

  try {
    for (let i = 0; i < items.length; i++) {
      const entry = items[i].webkitGetAsEntry();
      if (!entry) continue;
      await traverse(entry, []);
    }
  } catch (err) {
    // 遍历异常（权限/浏览器兼容问题等）：降级为平铺收集
    console.warn('[文件夹上传] 目录遍历失败，降级为平铺上传:', err);
    degrade();
    return result;
  }

  // 采集后逐文件校验相对路径，违规清单随结果返回（调用方据此整批阻止）
  result.violations = validateParsedFiles(result.parsed);
  return result;
}
