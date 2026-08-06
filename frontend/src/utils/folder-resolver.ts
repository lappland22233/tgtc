import api from '../api/client';
import { useFolderStore, type Folder } from '../stores/folders';
import type { ParsedFile } from './folder-traverse';

/**
 * 文件夹上传目录预创建工具。
 *
 * 入队前把 parsedFiles 中出现的目录（含中间层）在目标位置预先创建/复用，
 * 产出 "相对路径 → folderId" 映射，供 upload store 携带最终 folderId 入队。
 *
 * 设计要点：
 * - 先 fetchTree 一次，把 baseParentId 子树平铺为种子 Map，命中即复用（reusedCount）；
 * - 模块级注册表让同路径只发一次创建请求，并发调用共享 in-flight Promise；
 * - 缺失目录经独立微型限流器（并发 2，手写，不占用上传令牌池）串行按深度创建；
 * - POST 返回 400（同层重名竞态）时不依赖错误文案，改查 contents 按名复用。
 *
 * 注意：目录创建请求绝不 acquire uploadScheduler 令牌，与上传通道完全隔离。
 */

/** prepareDirectories 返回结果 */
export interface PrepareDirectoriesResult {
  /** 目录相对路径（segments join '/'）→ folderId；根级文件（无目录段）由调用方直接使用 baseParentId */
  dirIdMap: Map<string, string>;
  /** 命中既有目录而复用的数量 */
  reusedCount: number;
  /** 本次实际创建的数量 */
  createdCount: number;
}

/** 目录创建请求的独立微型限流并发数（手写，勿与 uploadScheduler 混用） */
const RESOLVER_CONCURRENCY = 2;

/** 最大允许嵌套深度（面包屑深度 + 新增路径深度），与后端约束对齐 */
const MAX_FOLDER_DEPTH = 20;

/**
 * 模块级 in-flight 注册表：绝对路径键（baseParentId + 相对路径）→ 创建中的 Promise。
 * 同批内同路径只发一次请求；即使将来多个 prepareDirectories 并发调用同一目标路径，
 * 也会共享同一个 Promise，避免重复创建触发 400。
 */
const inflightRegistry = new Map<string, Promise<CreateResult>>();

/** 单个目录的解析结果：id 必有；folder 仅本次真正创建时有值（供乐观回写树） */
interface CreateResult {
  id: string;
  folder: Folder | null;
}

/** 共享 in-flight Promise：已有则直接返回；否则登记并在结算后移除 */
function shareInflight(regKey: string, factory: () => Promise<CreateResult>): Promise<CreateResult> {
  const existing = inflightRegistry.get(regKey);
  if (existing) return existing;
  const promise = factory().finally(() => {
    inflightRegistry.delete(regKey);
  });
  inflightRegistry.set(regKey, promise);
  return promise;
}

/**
 * 独立微型限流器：最多 limit 个任务同时在途，保持输入顺序的结果数组。
 * 与 uploadScheduler 完全独立——目录创建是轻量 JSON 请求，不应挤占上传带宽。
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

/** 把子树递归平铺为 "相对路径 → folderId" Map（相对 baseParentId） */
function flattenSubtree(roots: Folder[], out: Map<string, string>): void {
  const stack: Array<{ node: Folder; prefix: string }> = roots.map((node) => ({ node, prefix: '' }));
  while (stack.length > 0) {
    const { node, prefix } = stack.pop()!;
    const key = prefix ? `${prefix}/${node.name}` : node.name;
    out.set(key, node.id);
    for (const child of node.children ?? []) {
      stack.push({ node: child, prefix: key });
    }
  }
}

/**
 * 预创建/复用 parsedFiles 所需的全部目录。
 *
 * @param baseParentId 上传目标文件夹 ID，null 表示根目录
 * @param parsedFiles  采集到的文件清单（仅使用其 dirSegments）
 * @param onProgress   进度回调（当前正在创建的目录路径）
 */
export async function prepareDirectories(
  baseParentId: string | null,
  parsedFiles: ParsedFile[],
  onProgress?: (msg: string) => void,
): Promise<PrepareDirectoriesResult> {
  const dirIdMap = new Map<string, string>();
  let reusedCount = 0;
  let createdCount = 0;

  // 1. 提取所有唯一目录前缀（含中间层），按深度升序排序（父目录必须先于子目录存在）
  const prefixSet = new Set<string>();
  for (const p of parsedFiles) {
    for (let k = 1; k <= p.dirSegments.length; k++) {
      prefixSet.add(p.dirSegments.slice(0, k).join('/'));
    }
  }
  if (prefixSet.size === 0) {
    // 全部为根级文件：无需创建任何目录，也无需拉树
    return { dirIdMap, reusedCount, createdCount };
  }
  const allPaths = [...prefixSet].sort((a, b) => {
    const da = a.split('/').length;
    const db = b.split('/').length;
    return da !== db ? da - db : a.localeCompare(b);
  });

  const folderStore = useFolderStore();

  // 2. 深度预检：当前面包屑深度 + 最深新增路径 > 上限则提前抛错，指出具体路径。
  //    breadcrumb 为空（根目录或未加载）时跳过预检，交后端 400 兜底。
  const maxDepth = allPaths[allPaths.length - 1].split('/').length;
  if (folderStore.breadcrumb.length > 0 && folderStore.breadcrumb.length + maxDepth > MAX_FOLDER_DEPTH) {
    const deepest = allPaths[allPaths.length - 1];
    throw new Error(
      `目录层级过深（"${deepest}" 将超过 ${MAX_FOLDER_DEPTH} 层限制），请调整文件夹结构后重试`,
    );
  }

  // 3. 拉取全量树一次，把 baseParentId 子树平铺为种子 Map
  await folderStore.fetchTree();
  const baseRoots: Folder[] = baseParentId
    ? folderStore.findInTree(folderStore.tree, baseParentId)?.children ?? []
    : folderStore.tree;
  const seedMap = new Map<string, string>(); // 相对路径 → folderId
  flattenSubtree(baseRoots, seedMap);

  // 4. 区分复用与缺失
  const missingPaths: string[] = [];
  for (const path of allPaths) {
    const hit = seedMap.get(path);
    if (hit) {
      dirIdMap.set(path, hit);
      reusedCount++;
    } else {
      missingPaths.push(path);
    }
  }

  if (missingPaths.length === 0) {
    return { dirIdMap, reusedCount, createdCount };
  }

  /**
   * 竞态兜底：POST 400（同层重名）后查 contents 按名匹配复用。
   * 根目录语义：后端 contents 接口将 parentId 缺省/空/'null' 都视为根目录，
   * 与 folders store listContents 一致——根级时不传 parentId 参数。
   */
  const findExistingByName = async (parentId: string | null, name: string): Promise<string | null> => {
    const params = parentId ? { parentId } : {};
    const res = await api.get('/folders/contents', { params });
    const subfolders = (res.data.data?.subfolders ?? []) as Folder[];
    const matched = subfolders.find((f) => f.name === name);
    return matched ? matched.id : null;
  };

  /** 创建单个目录（含 in-flight 共享、400 兜底）；返回 id 与新建 folder 对象（复用时 folder 为 null） */
  const createDirectory = (pathKey: string): Promise<CreateResult> => {
    const regKey = `${baseParentId ?? 'root'}:${pathKey}`;
    return shareInflight(regKey, async () => {
      // 并发调用/竞态后可能已被他人创建：优先查本地最新映射
      const already = dirIdMap.get(pathKey) ?? seedMap.get(pathKey);
      if (already) return { id: already, folder: null };

      const segments = pathKey.split('/');
      const name = segments[segments.length - 1];
      const parentPathKey = segments.slice(0, -1).join('/');
      const parentId = parentPathKey ? dirIdMap.get(parentPathKey) ?? null : baseParentId;
      if (parentPathKey && !parentId) {
        throw new Error(`目录 "${pathKey}" 的父目录 ID 缺失，无法创建`);
      }

      try {
        // 直连 api，绕开 folders store createFolder 的“每建必 fetchTree”
        const res = await api.post('/folders', { name, parentId });
        const folder = res.data.data.folder as Folder;
        createdCount++;
        return { id: folder.id, folder };
      } catch (err: unknown) {
        const status = (err as { response?: { status?: number } })?.response?.status;
        if (status === 400) {
          // 同层重名竞态：查 contents 按名复用（不依赖错误文案匹配）
          const existingId = await findExistingByName(parentId, name);
          if (existingId) {
            reusedCount++;
            return { id: existingId, folder: null };
          }
        }
        throw new Error(`创建目录 "${pathKey}" 失败：${(err as Error)?.message || '未知错误'}`);
      }
    });
  };

  // 5. 按深度分层创建：同层经微型限流器受控并发，父层全部完成后才进入子层
  let depthStart = 0;
  const totalMissing = missingPaths.length;
  let createdSoFar = 0;
  while (depthStart < missingPaths.length) {
    const depth = missingPaths[depthStart].split('/').length;
    let depthEnd = depthStart;
    while (depthEnd < missingPaths.length && missingPaths[depthEnd].split('/').length === depth) {
      depthEnd++;
    }
    const batch = missingPaths.slice(depthStart, depthEnd);

    const tasks = batch.map((pathKey) => async () => {
      onProgress?.(`正在创建目录：${pathKey}（${createdSoFar + 1}/${totalMissing}）`);
      const { id, folder } = await createDirectory(pathKey);
      createdSoFar++;

      // 登记映射 + 更新种子，供后续层级/并发流程复用
      dirIdMap.set(pathKey, id);
      seedMap.set(pathKey, id);
      // 乐观回写树（仅本次真正创建时）：绕过了 fetchTree，树里没有新节点，
      // 直接用 POST 返回的 folder 对象插入父节点 children
      if (folder) {
        const segments = pathKey.split('/');
        const parentPathKey = segments.slice(0, -1).join('/');
        const parentId = parentPathKey ? dirIdMap.get(parentPathKey) ?? null : baseParentId;
        folderStore.insertIntoTree(folder, parentId);
      }
      return id;
    });

    await runLimited(tasks, RESOLVER_CONCURRENCY);
    depthStart = depthEnd;
  }

  return { dirIdMap, reusedCount, createdCount };
}
