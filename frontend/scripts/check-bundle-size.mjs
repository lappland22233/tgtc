/**
 * 前端产物体积门禁（PERF-F-101 机制性防退化配套）。
 *
 * 背景：v1.6.0 首基线审查发现 `main.ts` 全量引入 `tdesign-vue-next/dist/tdesign.css`
 * （518 KB），且 `vite.config.ts` 的 `manualChunks` 把全部 TDesign 模块强制合并成
 * 单块，导致按需样式失效、首屏 CSS 达 500 KB。本脚本把「不许回退」固化为门禁。
 *
 * 零依赖（仅 node: 内置模块），gzip 体积用 zlib 计算。
 *
 * 用法：
 *   node scripts/check-bundle-size.mjs            # 按 bundle-baseline.json 校验
 *   node scripts/check-bundle-size.mjs --write    # 重新生成基线（需人工审阅后再提交）
 *
 * 退出码：0 = 通过；1 = 超限（打印超限项与修复指引）；2 = 用法/环境错误。
 */

import { readFileSync, readdirSync, statSync, existsSync, writeFileSync } from 'node:fs';
import { join, relative, extname, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';

const scriptDir = fileURLToPath(new URL('.', import.meta.url));
const projectRoot = join(scriptDir, '..');
const distDir = join(projectRoot, 'dist');
const baselinePath = join(projectRoot, 'bundle-baseline.json');

/** 允许的相对增长余量：正常重构（如多一个图标）不至于立刻变红，但整包回退必然越界。 */
const TOLERANCE_RATIO = 0.05;
/** 低于该体积的文件不纳入 max* 统计（登录页等 0 KB 桩文件无意义）。 */
const MEANINGFUL_KB = 1;
/** 首屏关键资源：入口 index.html 必须加载的 CSS/JS，回退风险最高，单独设更紧的阈值。 */
const ENTRY_CRITICAL_TOLERANCE_RATIO = 0.02;

function fail(message, code = 2) {
  console.error(`[bundle-size] ${message}`);
  process.exit(code);
}

function collect(dir) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...collect(full));
    else out.push(full);
  }
  return out;
}

function analyze() {
  if (!existsSync(distDir)) {
    fail('未找到 dist/ 目录。请先执行 `npm run build` 再运行本门禁（不要跳过构建）。');
  }
  const files = collect(distDir).filter((f) => ['.js', '.css'].includes(extname(f)));
  if (files.length === 0) {
    fail('dist/ 中没有任何 .js/.css 产物，构建可能已失败。请先检查 `npm run build` 输出。');
  }

  const chunks = files.map((full) => {
    const buffer = readFileSync(full);
    return {
      path: `assets/${relative(join(distDir, 'assets'), full).split(sep).join('/')}`,
      ext: extname(full),
      bytes: buffer.length,
      gzip: gzipSync(buffer).length,
    };
  });

  const byExt = (ext) => chunks.filter((c) => c.ext === ext);
  const sum = (list) => list.reduce((acc, c) => acc + c.bytes, 0);
  const maxOf = (list) => list.reduce((acc, c) => (c.bytes > acc.bytes ? c : acc), { bytes: 0, path: '-' });
  const js = byExt('.js');
  const css = byExt('.css');

  return {
    fileCount: chunks.length,
    jsTotal: sum(js),
    jsGzip: js.reduce((a, c) => a + c.gzip, 0),
    cssTotal: sum(css),
    cssGzip: css.reduce((a, c) => a + c.gzip, 0),
    maxJsChunk: maxOf(js.filter((c) => c.bytes >= MEANINGFUL_KB * 1024)),
    maxCssChunk: maxOf(css.filter((c) => c.bytes >= MEANINGFUL_KB * 1024)),
    chunks: chunks.sort((a, b) => b.bytes - a.bytes),
  };
}

/** 入口 index.html 实际加载的 CSS/JS —— 首屏真实成本，比全量统计更能反映回退。 */
function analyzeEntry() {
  const htmlPath = join(distDir, 'index.html');
  if (!existsSync(htmlPath)) return { critical: [], bytes: 0 };
  const html = readFileSync(htmlPath, 'utf8');
  const refs = [...html.matchAll(/(?:modulepreload|stylesheet)[^>]*href="\/([^"]+\.(?:js|css))"/g)]
    .map((m) => m[1])
    .filter((p) => p.startsWith('assets/'));
  let bytes = 0;
  const critical = refs.map((rel) => {
    const size = statSync(join(distDir, rel)).size;
    bytes += size;
    return { path: rel, bytes: size };
  });
  return { critical, bytes };
}

function formatKb(bytes) {
  return `${(bytes / 1024).toFixed(1)} KB`;
}

function main() {
  const write = process.argv.includes('--write');
  const result = analyze();
  const entry = analyzeEntry();

  const snapshot = {
    $schema: 'internal://frontend-bundle-baseline',
    updatedAt: new Date().toISOString().slice(0, 10),
    note:
      '由 `npm run check:bundle -- --write` 生成。阈值含义：' +
      'jsTotal/cssTotal 为产物总量，maxJsChunk/maxCssChunk 为单文件上限，' +
      'entryCssTotal 为入口 index.html 加载的 CSS 总量（TDesign 按需化后应显著小于 cssTotal）。',
    toleranceRatio: TOLERANCE_RATIO,
    entryToleranceRatio: ENTRY_CRITICAL_TOLERANCE_RATIO,
    thresholds: {
      jsTotal: result.jsTotal,
      jsGzipTotal: result.jsGzip,
      cssTotal: result.cssTotal,
      cssGzipTotal: result.cssGzip,
      maxJsChunk: result.maxJsChunk.bytes,
      maxCssChunk: result.maxCssChunk.bytes,
      entryJsTotal: entry.bytes,
    },
    largest: {
      maxJsChunk: { path: result.maxJsChunk.path, bytes: result.maxJsChunk.bytes },
      maxCssChunk: { path: result.maxCssChunk.path, bytes: result.maxCssChunk.bytes },
    },
    topChunks: result.chunks.slice(0, 12).map((c) => ({ path: c.path, bytes: c.bytes, gzip: c.gzip })),
  };

  if (write) {
    writeFileSync(baselinePath, `${JSON.stringify(snapshot, null, 2)}\n`, 'utf8');
    console.log(`[bundle-size] 基线已更新：${relative(projectRoot, baselinePath)}`);
    printTable(result, entry);
    return;
  }

  if (!existsSync(baselinePath)) {
    fail(
      '未找到 bundle-baseline.json。首次使用时执行 `npm run build && npm run check:bundle -- --write` 生成基线，' +
        '并人工确认数值合理后提交。',
    );
  }

  let baseline;
  try {
    baseline = JSON.parse(readFileSync(baselinePath, 'utf8'));
  } catch (error) {
    fail(`bundle-baseline.json 解析失败：${error.message}`);
  }

  printTable(result, entry);

  const t = baseline.thresholds ?? {};
  const tol = (n) => Math.round(n * (1 + TOLERANCE_RATIO));
  const entryTol = (n) => Math.round(n * (1 + ENTRY_CRITICAL_TOLERANCE_RATIO));

  const checks = [
    { key: 'jsTotal', label: 'JS 总量', actual: result.jsTotal, limit: tol(t.jsTotal ?? Infinity) },
    { key: 'cssTotal', label: 'CSS 总量', actual: result.cssTotal, limit: tol(t.cssTotal ?? Infinity) },
    { key: 'maxJsChunk', label: '最大单个 JS chunk', actual: result.maxJsChunk.bytes, limit: tol(t.maxJsChunk ?? Infinity), extra: result.maxJsChunk.path },
    { key: 'maxCssChunk', label: '最大单个 CSS chunk', actual: result.maxCssChunk.bytes, limit: tol(t.maxCssChunk ?? Infinity), extra: result.maxCssChunk.path },
  ];
  if (Number.isFinite(t.entryJsTotal)) {
    checks.push({ key: 'entryJsTotal', label: '入口 JS+CSS 总量（首屏真实成本）', actual: entry.bytes, limit: entryTol(t.entryJsTotal), extra: `${entry.critical.length} 个资源` });
  }

  const violations = checks.filter((c) => Number.isFinite(c.limit) && c.actual > c.limit);
  if (violations.length === 0) {
    console.log(`[bundle-size] 通过：${checks.length} 项指标均在阈值内（余量 ${Math.round(TOLERANCE_RATIO * 100)}%）。`);
    return;
  }

  console.error('');
  console.error('[bundle-size] 体积超限，疑似发生回退：');
  for (const v of violations) {
    console.error(`  ✗ ${v.label}：${formatKb(v.actual)} > 阈值 ${formatKb(v.limit)}（${v.extra ?? ''}）`);
  }
  console.error('');
  console.error('排查方向：');
  console.error('  1. 是否有人在 main.ts 重新全量引入 tdesign-vue-next/dist/tdesign.css（PERF-F-101 回退）；');
  console.error('  2. 是否从包根 `from \'tdesign-vue-next\'` 导入（es/index.mjs 自带全量 style/css.mjs）；');
  console.error('  3. 是否新增了重型依赖或大范围静态导入（应使用路由级/defineAsyncComponent 懒加载）；');
  console.error('  4. 若确认是有意变更，先本地构建后执行 `npm run check:bundle -- --write` 更新基线，并在 MR 中说明原因。');
  process.exit(1);
}

function printTable(result, entry) {
  console.log(`[bundle-size] 产物文件 ${result.fileCount} 个`);
  console.log(`  JS  总量 ${formatKb(result.jsTotal)}（gzip ${formatKb(result.jsGzip)}），最大单块 ${formatKb(result.maxJsChunk.bytes)} ${result.maxJsChunk.path}`);
  console.log(`  CSS 总量 ${formatKb(result.cssTotal)}（gzip ${formatKb(result.cssGzip)}），最大单块 ${formatKb(result.maxCssChunk.bytes)} ${result.maxCssChunk.path}`);
  console.log(`  入口加载 ${entry.critical.length} 个资源，合计 ${formatKb(entry.bytes)}`);
  for (const c of entry.critical) {
    console.log(`    - ${c.path} ${formatKb(c.bytes)}`);
  }
  console.log('  Top 8 产物：');
  for (const c of result.chunks.slice(0, 8)) {
    console.log(`    ${c.path.padEnd(46)} ${formatKb(c.bytes).padStart(10)}  gzip ${formatKb(c.gzip)}`);
  }
}

main();
