/**
 * 前端样式卫生检查门禁。
 *
 * 强制约束 STYLE_GUIDE.md 中的核心规范，防止重构成果回退：
 * 1. 禁止静态内联 style="..." 属性
 * 2. 禁止在样式与组件中硬编码十六进制 / rgb() / rgba() 颜色值（白名单除外）
 * 3. 禁止使用 --td-* 内部变量或引用未定义的 CSS 自定义属性
 * 4. 禁止使用 !important（除 base.css 中的 prefers-reduced-motion 无障碍保护）
 * 5. 禁止在 .vue 中使用未 scoped/module 的全局 <style> 块
 * 6. 禁止使用 max-width 桌面优先媒体查询或未对齐断点（360/500/680/700/720/960px）
 * 7. 禁止重新引入已删除的废弃文件/函数
 */

import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDir = fileURLToPath(new URL('.', import.meta.url));
const frontendRoot = join(scriptDir, '..');
const srcRoot = join(frontendRoot, 'src');

const ALLOWED_HEX_FILES = new Set([
  'src/assets/styles/tokens.css',
  'src/assets/styles/critical.css',
  'src/utils/echarts-theme.ts',
  'src/components/TagManager.vue',
  'src/composables/useTheme.ts',
]);

const DEAD_PATHS = [
  'src/views/user/Upload.vue',
  'src/components/file/FileCard.vue',
  'src/components/file/FolderCard.vue',
  'src/views/admin/admin-content.css',
  'src/views/admin/bot-operations.css',
];

const UNALIGNED_BREAKPOINT_RE = /@media[^{]*(?:\b(?:357|360|500|680|700|720|960)px\b|\bmax-width\s*:\s*\d+px\b)/;

function walk(dir) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(full));
    else out.push(full);
  }
  return out;
}

function collectDefinedVars() {
  const tokensPath = join(srcRoot, 'assets/styles/tokens.css');
  const css = readFileSync(tokensPath, 'utf8');
  return new Set([...css.matchAll(/(--[a-zA-Z0-9_-]+)\s*:/g)].map((m) => m[1]));
}

function collectLocallyBoundVars(allTexts) {
  const vars = new Set();
  for (const text of allTexts) {
    for (const m of text.matchAll(/['"]?(--[a-zA-Z0-9_-]+)['"]?\s*:/g)) {
      vars.add(m[1]);
    }
  }
  return vars;
}

function stripBlockComments(line, state) {
  let out = '';
  let i = 0;
  while (i < line.length) {
    if (state.inComment) {
      const end = line.indexOf('*/', i);
      if (end === -1) return '';
      state.inComment = false;
      i = end + 2;
    } else {
      const start = line.indexOf('/*', i);
      if (start === -1) {
        out += line.slice(i);
        break;
      }
      out += line.slice(i, start);
      state.inComment = true;
      i = start + 2;
    }
  }
  return out;
}

function run() {
  const violations = [];

  for (const deadRel of DEAD_PATHS) {
    if (existsSync(join(frontendRoot, deadRel))) {
      violations.push(`[DEAD_FILE] 已废弃文件不得保留: ${deadRel}`);
    }
  }

  const definedVars = collectDefinedVars();
  const files = walk(srcRoot).filter(
    (f) => /\.(vue|ts|css)$/.test(f) && !f.endsWith('.spec.ts') && !f.endsWith('.test.ts'),
  );
  const fileContents = files.map((full) => ({
    rel: relative(frontendRoot, full).split(sep).join('/'),
    text: readFileSync(full, 'utf8'),
  }));
  const locallyBoundVars = collectLocallyBoundVars(fileContents.map((f) => f.text));

  for (const { rel, text } of fileContents) {
    const lines = text.split(/\r?\n/);

    // 1. 静态 style="..."
    if (rel.endsWith('.vue')) {
      lines.forEach((line, idx) => {
        if (/\sstyle="[^"]+"/.test(line)) {
          violations.push(`[STATIC_STYLE] ${rel}:${idx + 1} 存在静态内联样式: ${line.trim()}`);
        }
      });

      // 2. Unscoped <style>
      if (/<style(?![^>]*\b(?:scoped|module)\b)[^>]*>/.test(text)) {
        violations.push(`[UNSCOPED_STYLE] ${rel} 存在未加 scoped 的 <style> 标签`);
      }
    }

    // 3. Hardcoded hex / rgb() / rgba() & 4. !important
    const hexCommentState = { inComment: false };
    const impCommentState = { inComment: false };

    lines.forEach((line, idx) => {
      const impCode = stripBlockComments(line, impCommentState).trim();
      if (!impCode.startsWith('//') && impCode.includes('!important') && rel !== 'src/assets/styles/base.css') {
        violations.push(`[IMPORTANT] ${rel}:${idx + 1} 禁止使用 !important: ${line.trim()}`);
      }

      if (!ALLOWED_HEX_FILES.has(rel)) {
        const hexCode = stripBlockComments(line, hexCommentState).trim();
        if (!hexCode.startsWith('//') && /(#[0-9a-fA-F]{3,8}\b|rgba?\()/i.test(hexCode) && !/data:image\/svg/.test(hexCode)) {
          violations.push(`[HARDCODED_COLOR] ${rel}:${idx + 1} 请使用语义 CSS 变量替代: ${line.trim()}`);
        }
      }
    });

    // 5. Undefined CSS vars or direct --td-* consumption outside tdesign.css
    lines.forEach((line, idx) => {
      for (const m of line.matchAll(/var\((--[a-zA-Z0-9_-]+)/g)) {
        const name = m[1];
        if (name.startsWith('--td-')) {
          if (rel !== 'src/assets/styles/tdesign.css') {
            violations.push(`[TD_VAR] ${rel}:${idx + 1} 组件/页面禁止直接使用 ${name}，请替换为语义令牌`);
          }
        } else if (!definedVars.has(name) && !locallyBoundVars.has(name)) {
          violations.push(`[UNDEF_VAR] ${rel}:${idx + 1} 引用了未定义的 CSS 变量 ${name}`);
        }
      }
    });

    // 6. Media queries: enforce mobile-first & aligned breakpoints
    lines.forEach((line, idx) => {
      if (UNALIGNED_BREAKPOINT_RE.test(line)) {
        violations.push(`[BREAKPOINT] ${rel}:${idx + 1} 请使用移动优先 min-width 与标准断点: ${line.trim()}`);
      }
    });

    // 7. Deprecated getFileEmoji
    if (rel !== 'src/utils/file-icon-type.ts' && /\bgetFileEmoji\b/.test(text)) {
      violations.push(`[DEAD_SYMBOL] ${rel} 引用了已移除的 getFileEmoji`);
    }
  }

  if (violations.length > 0) {
    console.error(`[check:style] 发现 ${violations.length} 项样式规范违规：\n`);
    for (const v of violations) console.error(`  ${v}`);
    process.exit(1);
  }

  console.log(`[check:style] 已检查 ${files.length} 个源码文件，所有样式卫生规则通过。`);
}

run();
