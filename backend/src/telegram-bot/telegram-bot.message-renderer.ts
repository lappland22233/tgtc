/**
 * 主 Bot 消息渲染层。
 *
 * 只负责把「语义消息」构造成发送载荷，**不发送**。发送与降级由 dispatch 的 reply()/sendQueueNotice() 负责。
 *
 * 为什么用 `blocks` 而不是 markdown：
 * 自建 Bot API 的 `rich_message` 支持 markdown / html / blocks 三种来源，其中只有 `blocks` 的文本是
 * JSON 字符串（`get_rich_text` 对 String 直接构造 richTextPlain），用户可控内容（文件名等）**不会**
 * 被当成标记解析。markdown 需要成套转义规则且任意漏一处就是注入面，blocks 从结构上不存在这个问题。
 *
 * 每条消息都同时带 `text`（纯文本兜底）：富文本被拒时直接降级重发，消息绝不丢失。
 */

/** RichText：字符串即纯文本；数组为拼接；对象为带样式片段 */
export type BotRichText =
  | string
  | BotRichText[]
  | { type: 'bold' | 'italic' | 'underline' | 'strikethrough' | 'code' | 'spoiler'; text: BotRichText }
  | { type: 'url'; text: BotRichText; url: string };

export type BotRichBlock = Record<string, unknown> & { type: string };

/** `rich_message` 载荷（blocks 来源） */
export interface BotRichMessage {
  blocks: BotRichBlock[];
}

export interface BotInlineButton {
  text: string;
  url?: string;
  callback_data?: string;
}

export interface BotReplyMarkup {
  inline_keyboard: BotInlineButton[][];
}

/** 渲染结果：rich 优先，parseMode 次之，text 恒为合法兜底 */
export interface RenderedMessage {
  /** 纯文本形态，永远可直接发送（富文本失败时的降级内容） */
  text: string;
  /** 原生富文本（blocks 来源） */
  rich?: BotRichMessage;
  rich_fallback_html?: string;
  /** 次选：经典 HTML 标注 */
  parseMode?: 'HTML';
  replyMarkup?: BotReplyMarkup;
  /**
   * 消息特效 ID。
   *
   * 特效 ID 由 Telegram 服务端目录下发（非文档常量），不能凭猜写死，
   * 因此只作为可选能力透传；未配置时不下发该字段。
   */
  messageEffectId?: string;
}

/** 折叠块展开/收起的默认状态由服务端决定，这里只声明摘要 */
function heading(text: BotRichText, size = 1): BotRichBlock {
  return { type: 'heading', text, size };
}

function paragraph(text: BotRichText): BotRichBlock {
  return { type: 'paragraph', text };
}

/** 等宽块：直链、命令用法等需要可复制的内容 */
function pre(text: BotRichText, language = ''): BotRichBlock {
  return { type: 'pre', text, language };
}

function quote(blocks: BotRichBlock[], credit: BotRichText = ''): BotRichBlock {
  return { type: 'blockquote', blocks, credit };
}

function details(summary: BotRichText, blocks: BotRichBlock[], isOpen = false): BotRichBlock {
  return { type: 'details', summary, blocks, is_open: isOpen };
}

function list(items: BotRichBlock[][], hasCheckbox = false): BotRichBlock {
  return { type: 'list', items: items.map(blocks => ({ blocks, has_checkbox: hasCheckbox })) };
}

function table(headers: string[], rows: string[][], caption = ''): BotRichBlock {
  const cells = [
    headers.map(text => ({ text, is_header: true })),
    ...rows.map(row => row.map(text => ({ text, is_header: false }))),
  ];
  return { type: 'table', cells, caption, is_bordered: true, is_striped: false, is_compact: false };
}

/** HTML 兜底用的转义（只在 parseMode=HTML 路径使用） */
export function escapeHtml(input: string): string {
  return input.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/** 消息内联的「打开链接」按钮（url 由服务端生成，仍做基本校验避免空按钮） */
function openLinkButton(url: string): BotReplyMarkup | undefined {
  if (!/^https?:\/\//i.test(url)) return undefined;
  return { inline_keyboard: [[{ text: '打开链接', url }]] };
}

export interface LinkReadyInput {
  fileName: string;
  url: string;
  expiresAt: string;
  ttlHours?: number;
  /** 入站直链（源文件在 Telegram）与转存就绪的文案略有差异 */
  variant?: 'inbound' | 'queued';
}

/**
 * 直链就绪（主成功消息）。
 *
 * 纯文本兜底保留既有断言依赖的子串：`下载直链（有效期至`、`⚠️ 链接到期后文件将自动失效并删除。`
 */
export function renderLinkReady(input: LinkReadyInput): RenderedMessage {
  const { fileName, url, expiresAt, ttlHours, variant = 'inbound' } = input;
  const title = variant === 'queued' ? '文件已就绪！' : '文件已收到';
  const warning = '⚠️ 链接到期后文件将自动失效并删除。';

  const text = variant === 'queued'
    ? [
      title,
      `文件名：${fileName}`,
      `下载直链（有效期至 ${expiresAt}）：`,
      url,
      warning,
    ].join('\n')
    : [
      `${title}：${fileName}`,
      `下载直链（${ttlHours ?? '?'} 小时内有效，仅受时间限制）：`,
      url,
    ].join('\n');

  const blocks: BotRichBlock[] = [
    heading([{ type: 'bold', text: title }], 2),
    paragraph([{ type: 'bold', text: '文件名：' }, fileName]),
    paragraph([{ type: 'bold', text: '下载直链（有效期至 ' }, expiresAt, { type: 'bold', text: '）' }]),
    pre(url),
    quote([paragraph(warning)]),
  ];

  return {
    text,
    rich: { blocks },
    rich_fallback_html: `${escapeHtml(text)}`,
    replyMarkup: openLinkButton(url),
  };
}

/** 队列任务状态（有一条 task 生命周期内的 7 个可见态） */
export type QueueNoticeStatus = 'queued' | 'running' | 'cancelled' | 'failed' | 'expired' | 'unrecoverable' | 'ready' | 'banned' | 'maintenance';

export interface QueueNoticeInput {
  status: QueueNoticeStatus;
  fileName?: string | null;
  position?: number;
  url?: string;
  expiresAt?: string;
  /** 磁盘不足与一般失败文案不同 */
  failureReason?: 'disk_unavailable' | null;
  /** 「取消」按钮回调数据；不传则不渲染按钮 */
  cancelCallbackData?: string;
}

/**
 * 队列/收件状态消息。
 *
 * 纯文本兜底保留既有断言依赖的子串：`已加入队列，当前排第 N 位`、`文件已就绪！`。
 */
export function renderQueueNotice(input: QueueNoticeInput): RenderedMessage {
  const { status, fileName, position, url, expiresAt, failureReason, cancelCallbackData } = input;
  const name = fileName || '(未命名)';

  const withName = (headline: string) => `${headline}\n文件名：${name}`;
  const replyMarkup = cancelCallbackData
    ? { inline_keyboard: [[{ text: '取消处理', callback_data: cancelCallbackData }]] }
    : undefined;

  const simple = (headline: string): RenderedMessage => ({
    text: withName(headline),
    rich: {
      blocks: [
        heading([{ type: 'bold', text: headline }], 2),
        paragraph([{ type: 'bold', text: '文件名：' }, name]),
      ],
    },
    replyMarkup,
  });

  /** 无文件名附注的短提示（失败/停用/维护态与历史文案保持一致） */
  const brief = (headline: string): RenderedMessage => ({
    text: headline,
    rich: { blocks: [paragraph([{ type: 'bold', text: headline }])] },
  });

  switch (status) {
    case 'queued':
      return simple(`⏳ 已加入队列，当前排第 ${position ?? '?'} 位。`);
    case 'running':
      return simple('⏳ 正在创建下载链接，请稍候…');
    case 'cancelled':
      return simple('管理员已取消文件处理。');
    // 失败/停用/维护态不展示文件名：与历史文案保持一致，且失败原因与文件无关
    case 'failed':
      return failureReason === 'disk_unavailable'
        ? brief('服务器临时磁盘空间不足，无法转存文件，请稍后重试。')
        : brief('创建下载链接失败，请稍后重试。');
    case 'banned':
      return brief('此 Telegram 账号已被停用，无法创建下载链接。');
    case 'maintenance':
      return brief('服务正在维护重启中，请稍后重新发送文件。');
    case 'expired':
      return simple('文件的下载链接已失效。');
    case 'unrecoverable':
      return simple('无法恢复此文件的下载链接，请重新发送文件。');
    case 'ready':
    default: {
      const text = [
        '文件已就绪！',
        `文件名：${name}`,
        `下载直链（有效期至 ${expiresAt ?? '?'}）：`,
        url ?? '',
        '⚠️ 链接到期后文件将自动失效并删除。',
      ].join('\n');
      return {
        text,
        rich: {
          blocks: [
            heading([{ type: 'bold', text: '文件已就绪！' }], 2),
            paragraph([{ type: 'bold', text: '文件名：' }, name]),
            paragraph([{ type: 'bold', text: '下载直链（有效期至 ' }, expiresAt ?? '?', { type: 'bold', text: '）' }]),
            pre(url ?? ''),
            quote([paragraph('⚠️ 链接到期后文件将自动失效并删除。')]),
          ],
        },
        rich_fallback_html: escapeHtml(text),
        replyMarkup: url ? openLinkButton(url) : undefined,
      };
    }
  }
}

export interface HelpInput {
  admin: boolean;
}

/** /help /start */
export function renderHelp(input: HelpInput = { admin: false }): RenderedMessage {
  const userCommands = [
    ['/help', '显示本帮助'],
    ['/id', '查看你的 TG 用户 ID'],
    ['/quota', '查看今日剩余额度'],
  ];
  const adminCommands = [
    ['/wl_add <TG用户ID>', '加入白名单'],
    ['/wl_remove <TG用户ID>', '移出白名单'],
    ['/wl_list', '列出白名单'],
    ['/link_query <TG用户ID>', '查询有效直链'],
    ['/link_revoke <直链URL或Token>', '撤销直链'],
  ];

  const textLines = [
    '发送「文件」（Telegram 附件 → 文件）即可获得下载直链。',
    '直链仅在有效期内可用，不限下载次数。',
    '',
    '可用命令：',
    ...userCommands.map(([cmd, desc]) => `${cmd} — ${desc}`),
  ];
  if (input.admin) {
    textLines.push('', '管理员命令（仅私聊）：', ...adminCommands.map(([cmd, desc]) => `${cmd} — ${desc}`));
  }

  const blocks: BotRichBlock[] = [
    heading([{ type: 'bold', text: '文件直链 Bot' }], 1),
    paragraph('发送「文件」（Telegram 附件 → 文件）即可获得下载直链。直链仅在有效期内可用，不限下载次数。'),
    heading('可用命令', 3),
    list(userCommands.map(([cmd, desc]) => [
      paragraph([{ type: 'code', text: cmd }, ' — ', desc]),
    ])),
  ];
  if (input.admin) {
    blocks.push(details(
      [{ type: 'bold', text: '管理员命令（仅私聊）' }],
      [list(adminCommands.map(([cmd, desc]) => [paragraph([{ type: 'code', text: cmd }, ' — ', desc])]))],
    ));
  }

  return { text: textLines.join('\n'), rich: { blocks } };
}

export interface QuotaInput {
  whitelisted: boolean;
  used?: number;
  limit?: number;
  remaining?: number;
  timezone?: string;
}

/** /quota */
export function renderQuota(input: QuotaInput): RenderedMessage {
  if (input.whitelisted) {
    const text = '你在白名单中，不限每日文件数。';
    return {
      text,
      rich: { blocks: [paragraph([{ type: 'bold', text: '白名单用户' }, '，不限每日文件数。'])] },
    };
  }
  const { used = 0, limit = 0, remaining = 0, timezone = '' } = input;
  const text = `今日已使用 ${used} / ${limit}，剩余 ${remaining} 次。\n（切日时区：${timezone}）`;
  return {
    text,
    rich: {
      blocks: [
        heading([{ type: 'bold', text: '今日额度' }], 2),
        paragraph([
          '已使用 ', { type: 'bold', text: String(used) }, ' / ', String(limit),
          '，剩余 ', { type: 'bold', text: String(remaining) }, ' 次。',
        ]),
        { type: 'footer', text: [{ type: 'italic', text: `切日时区：${timezone}` }] },
      ],
    },
  };
}

/** /quota 额度耗尽 */
export function renderQuotaDenied(limit: number): RenderedMessage {
  const text = `今日额度已用完（${limit} 个文件/天）。明日将自动重置，或联系管理员加入白名单。`;
  return {
    text,
    rich: {
      blocks: [
        heading([{ type: 'bold', text: '今日额度已用完' }], 2),
        paragraph([`配额上限 `, { type: 'bold', text: `${limit} 个文件/天` }, `。`]),
        quote([paragraph('明日将自动重置，或联系管理员加入白名单。')]),
      ],
    },
  };
}

export interface LinkQueryRow {
  fileName: string;
  expiresAt: string;
  url?: string | null;
  prefix?: string | null;
}

/** /link_query：表格（未启用加密存储时无法回放完整链接，单独标注） */
export function renderLinkQuery(target: string, rows: LinkQueryRow[], total: number): RenderedMessage {
  const shown = rows.length;
  const plainRows = rows.map((row, index) => {
    const name = row.fileName || '(未命名)';
    const expires = new Date(row.expiresAt).toISOString();
    if (row.url) return `${index + 1}. ${name}\n   过期：${expires}\n   ${row.url}`;
    return `${index + 1}. ${name}\n   过期：${expires}\n   前缀：${row.prefix}（未启用加密存储，无法回放完整链接，请重新签发）`;
  });
  const text = `直链（${target}）：\n${plainRows.join('\n')}${total > shown ? `\n……共 ${total} 条（已截断）` : ''}`;

  const tableRows = rows.map((row, index) => {
    const name = row.fileName || '(未命名)';
    return [String(index + 1), name, new Date(row.expiresAt).toISOString(), row.url || `前缀 ${row.prefix}（无法回放）`];
  });

  const blocks: BotRichBlock[] = [
    heading([{ type: 'bold', text: '直链查询' }], 2),
    paragraph([{ type: 'bold', text: '用户：' }, { type: 'code', text: target }]),
    table(['#', '文件名', '过期时间', '直链'], tableRows),
  ];
  if (total > shown) blocks.push({ type: 'footer', text: [{ type: 'italic', text: `共 ${total} 条，仅展示前 ${shown} 条` }] });

  return { text, rich: { blocks } };
}

/** /wl_list */
export function renderWhitelist(ids: string[], total: number): RenderedMessage {
  if (total === 0) {
    return { text: '白名单为空。', rich: { blocks: [paragraph('白名单为空。')] } };
  }
  const suffix = total > ids.length ? `\n……共 ${total} 个（已截断）` : `\n共 ${total} 个`;
  const text = `白名单：\n${ids.map((id, i) => `${i + 1}. ${id}`).join('\n')}${suffix}`;
  return {
    text,
    rich: {
      blocks: [
        heading([{ type: 'bold', text: '白名单' }], 2),
        list(ids.map(id => [paragraph([{ type: 'code', text: id }])])),
        { type: 'footer', text: [{ type: 'italic', text: total > ids.length ? `共 ${total} 个，仅展示前 ${ids.length} 个` : `共 ${total} 个` }] },
      ],
    },
  };
}

/** 单行提示/错误：不加块结构，在 HTML 兜底里加粗关键 token */
export function renderNotice(text: string, options?: { emphasize?: string[] }): RenderedMessage {
  const emphasize = options?.emphasize ?? [];
  if (emphasize.length === 0) return { text };
  let html = escapeHtml(text);
  for (const token of emphasize) {
    if (!token) continue;
    html = html.split(escapeHtml(token)).join(`<b>${escapeHtml(token)}</b>`);
  }
  return { text, rich_fallback_html: html, parseMode: 'HTML' };
}
