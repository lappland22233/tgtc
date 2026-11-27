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
    // 必须同时给 parseMode，否则降级链判定 hasHtml=false，HTML 档成为死代码，
    // 富文本一旦被拒就直接跳纯文本并丢掉「打开链接」按钮。
    rich_fallback_html: escapeHtml(text),
    parseMode: 'HTML',
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
        parseMode: 'HTML',
        replyMarkup: url ? openLinkButton(url) : undefined,
      };
    }
  }
}

export interface HelpInput {
  admin: boolean;
  /** 当前用户可见的命令（由 telegram-bot.commands 按权限过滤，帮助与命令菜单共用同一来源） */
  commands: readonly HelpCommandRow[];
}

/** 帮助列表的一行：命令用法 + 说明 + 归属分组 */
export interface HelpCommandRow {
  /** 带参数的完整用法，如 `/ttl <1-720>` */
  usage: string;
  description: string;
  scope: 'user' | 'admin';
}

/** /help /start */
export function renderHelp(input: HelpInput): RenderedMessage {
  // `/start` 与 `/help` 是同一入口，帮助里只列一行，避免重复条目
  const rows = input.commands.filter(row => row.usage !== '/start');
  const userCommands = rows
    .filter(row => row.scope === 'user')
    .map(row => [row.usage, row.description] as const);
  const adminRows = input.admin ? rows.filter(row => row.scope === 'admin') : [];

  const textLines = [
    '发送「文件」（Telegram 附件 → 文件）即可获得下载直链。',
    '直链仅在有效期内可用，不限下载次数。',
    '',
    '可用命令：',
    ...userCommands.map(([cmd, desc]) => `${cmd} — ${desc}`),
  ];
  if (adminRows.length > 0) {
    textLines.push('', '管理员命令（仅私聊）：', ...adminRows.map(row => `${row.usage} — ${row.description}`));
  }

  const blocks: BotRichBlock[] = [
    heading([{ type: 'bold', text: '文件直链 Bot' }], 1),
    paragraph('发送「文件」（Telegram 附件 → 文件）即可获得下载直链。直链仅在有效期内可用，不限下载次数。'),
    heading('可用命令', 3),
    list(userCommands.map(([cmd, desc]) => [
      paragraph([{ type: 'code', text: cmd }, ' — ', desc]),
    ])),
  ];
  if (adminRows.length > 0) {
    blocks.push(details(
      [{ type: 'bold', text: '管理员命令（仅私聊）' }],
      [list(adminRows.map(row => [paragraph([{ type: 'code', text: row.usage }, ' — ', row.description])]))],
    ));
  }

  return { text: textLines.join('\n'), rich: { blocks } };
}

/** 额度来源的展示文案（与 QuotaSource 一一对应） */
const QUOTA_SOURCE_LABEL: Record<'whitelist' | 'user' | 'global', string> = {
  whitelist: '白名单（不限额度）',
  user: '单独额度',
  global: '默认额度',
};

export interface QuotaInput {
  whitelisted: boolean;
  used?: number;
  limit?: number;
  remaining?: number;
  timezone?: string;
  /** 生效额度来源；缺省按默认额度展示（兼容旧调用） */
  source?: 'whitelist' | 'user' | 'global';
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
  const { used = 0, limit = 0, remaining = 0, timezone = '', source = 'global' } = input;
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
        { type: 'footer', text: [{ type: 'italic', text: `额度来源：${QUOTA_SOURCE_LABEL[source]} · 切日时区：${timezone}` }] },
      ],
    },
  };
}

export interface QuotaDeniedInput {
  limit: number;
  /** 覆盖额度用尽时提示联系管理员；默认额度用尽时提示明日重置 */
  source?: 'user' | 'global';
}

/** /quota 额度耗尽 */
export function renderQuotaDenied(input: QuotaDeniedInput | number): RenderedMessage {
  const { limit, source = 'global' } = typeof input === 'number' ? { limit: input, source: 'global' as const } : input;
  const action = source === 'user' ? '明日将自动重置，或联系管理员调整额度。' : '明日将自动重置，或联系管理员加入白名单。';
  const text = `今日额度已用完（${limit} 个文件/天）。${action}`;
  return {
    text,
    rich: {
      blocks: [
        heading([{ type: 'bold', text: '今日额度已用完' }], 2),
        paragraph([`配额上限 `, { type: 'bold', text: `${limit} 个文件/天` }, `。`]),
        quote([paragraph(action)]),
      ],
    },
  };
}

export interface AdminLinkRow {
  grantId: string;
  fileName: string;
  expiresAt: string;
  url?: string | null;
  prefix?: string | null;
  telegramUserId?: string;
}

export interface AdminLinksInput {
  /** 列表范围描述，如「全部用户」或某个 TG 用户 ID */
  scopeLabel: string;
  page: number;
  pageSize: number;
  total: number;
  rows: AdminLinkRow[];
  /** 是否支持回放完整链接（未配置加密密钥时为 false） */
  cryptoAvailable?: boolean;
}

/** 文件名在表格里截断，避免单行撑爆消息长度 */
function clipFileName(name: string, max = 40): string {
  const value = name || '(未命名)';
  return value.length > max ? `${value.slice(0, max)}…` : value;
}

/** 过期时间只展示到分钟，表格里不塞完整 ISO 串 */
function shortExpiry(iso: string): string {
  const parsed = new Date(iso);
  if (Number.isNaN(parsed.getTime())) return iso;
  return parsed.toISOString().slice(0, 16).replace('T', ' ');
}

/**
 * /links 与面板「有效直链」页共用的列表。
 *
 * 与旧 `/link_query` 的区别：分页而非一次 20 条截断；每行带撤销按钮（回调只携带 grantId），
 * 让管理员不需要复制 URL 就能撤销。
 */
/** Telegram 对 callback_data 的硬上限（字节） */
export const CALLBACK_DATA_MAX = 64;

/**
 * 撤销确认的回调数据。
 *
 * 预算：`ba:rv:`(6) + grantId(36) + `:`(1) + page(≤4) = ≤47，留足余量。
 * 用户过滤条件（`:u:<tgId>`）只在总长仍 ≤64 时附加，否则退回全量列表——
 * 宁可返回时少一层过滤，也不能发出超限的按钮（Telegram 会整条消息拒收）。
 */
function revokeCallbackData(grantId: string, page: number, scopeSuffix: string): string {
  const base = `ba:rv:${grantId}:${page}${scopeSuffix}`;
  return base.length <= CALLBACK_DATA_MAX ? base : `ba:rv:${grantId}:1`;
}

export function renderAdminLinks(input: AdminLinksInput): RenderedMessage {
  const { scopeLabel, page, pageSize, total, rows, cryptoAvailable = true } = input;
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const empty = rows.length === 0;

  const plainRows = rows.map((row, index) => {
    const no = (page - 1) * pageSize + index + 1;
    const head = `${no}. ${row.fileName || '(未命名)'}\n   过期：${new Date(row.expiresAt).toISOString()}`;
    if (row.url) return `${head}\n   ${row.url}`;
    return `${head}\n   前缀：${row.prefix ?? '-'}（未启用加密存储，无法回放完整链接）`;
  });

  const textLines = [
    `直链（${scopeLabel}）第 ${page}/${totalPages} 页，共 ${total} 条`,
    ...(empty ? ['当前没有有效的直链。'] : plainRows),
  ];

  const blocks: BotRichBlock[] = [
    heading([{ type: 'bold', text: '有效直链' }], 2),
    paragraph([{ type: 'bold', text: '范围：' }, { type: 'code', text: scopeLabel }]),
  ];
  if (empty) {
    blocks.push(paragraph('当前没有有效的直链。'));
  } else {
    const tableRows = rows.map((row, index) => {
      const no = String((page - 1) * pageSize + index + 1);
      const link = row.url || `前缀 ${row.prefix ?? '-'}（无法回放）`;
      return [no, clipFileName(row.fileName), shortExpiry(row.expiresAt), link];
    });
    blocks.push(table(['#', '文件名', '过期', '直链'], tableRows));
    if (!cryptoAvailable) {
      blocks.push(quote([paragraph('未配置 TELEGRAM_BOT_ENCRYPTION_KEY：无法回放完整链接，只能按前缀核对或重新签发。')]));
    }
  }
  blocks.push({ type: 'footer', text: [{ type: 'italic', text: `第 ${page}/${totalPages} 页 · 共 ${total} 条` }] });

  // 按钮：每行一个撤销（只带 grantId + 返回页码，绝不带 URL/文件名），末行翻页 + 返回面板
  const scopeSuffix = input.scopeLabel && input.scopeLabel !== '全部用户'
    ? `:u:${input.scopeLabel}` : '';
  const keyboard: BotInlineButton[][] = rows.map((row, index) => [{
    text: `撤销 #${(page - 1) * pageSize + index + 1}`,
    callback_data: revokeCallbackData(row.grantId, page, scopeSuffix),
  }]);
  const navRow: BotInlineButton[] = [];
  if (page > 1) navRow.push({ text: '上一页', callback_data: `ba:lk:${page - 1}${scopeSuffix}` });
  if (page < totalPages) navRow.push({ text: '下一页', callback_data: `ba:lk:${page + 1}${scopeSuffix}` });
  navRow.push({ text: '返回面板', callback_data: 'ba:root' });
  keyboard.push(navRow);

  return { text: textLines.join('\n'), rich: { blocks }, replyMarkup: { inline_keyboard: keyboard } };
}

export interface AdminPanelInput {
  ttlHours: number;
  ttlPresets: readonly number[];
  generalLimit: number;
  limitPresets: readonly number[];
  whitelistCount: number;
  overrideCount: number;
  activeLinkCount: number;
  usageDate: string;
  quotaTimezone: string;
  storageMode: 'telegram' | 'gdrive';
  /** 站点域名是否可用（不可用时无法签发直链） */
  domainReady: boolean;
}

/**
 * /admin 主面板。
 *
 * 设计取舍：**只放预设档位与导航**，精确数值留给命令（`/ttl 6`、`/limit 8`、`/quota_set`），
 * 因为 Telegram 内联键盘不能收集自由输入；硬塞 1–720 的档位只会变成几十个按钮。
 */
export function renderAdminPanel(input: AdminPanelInput): RenderedMessage {
  const {
    ttlHours, ttlPresets, generalLimit, limitPresets,
    whitelistCount, overrideCount, activeLinkCount, usageDate, quotaTimezone, storageMode, domainReady,
  } = input;

  const text = [
    '管理面板',
    `直链有效期：${ttlHours} 小时`,
    `通用每日额度：${generalLimit} 个/天`,
    `白名单：${whitelistCount} 人 · 单独额度：${overrideCount} 人`,
    `有效直链：${activeLinkCount} 条`,
    `今日（${usageDate}）· 时区 ${quotaTimezone}`,
    `存储模式：${storageMode === 'gdrive' ? '纯 Google 存储' : '原生 Telegram 存储'}`,
    domainReady ? '站点域名：已配置' : '站点域名：未配置（无法签发直链）',
    '',
    '精确数值请用命令：/ttl 12、/limit 8、/quota_set <TG用户ID> 20',
  ].join('\n');

  const blocks: BotRichBlock[] = [
    heading([{ type: 'bold', text: '管理面板' }], 2),
    table(['项目', '当前值'], [
      ['直链有效期', `${ttlHours} 小时`],
      ['通用每日额度', `${generalLimit} 个/天`],
      ['白名单', `${whitelistCount} 人`],
      ['单独额度', `${overrideCount} 人`],
      ['有效直链', `${activeLinkCount} 条`],
      ['存储模式', storageMode === 'gdrive' ? '纯 Google 存储' : '原生 Telegram 存储'],
      ['站点域名', domainReady ? '已配置' : '未配置（无法签发直链）'],
    ]),
    quote([paragraph(['精确数值请用命令：', { type: 'code', text: '/ttl' }, '、', { type: 'code', text: '/limit' }, '、', { type: 'code', text: '/quota_set' }])]),
    { type: 'footer', text: [{ type: 'italic', text: `今日 ${usageDate} · 切日时区 ${quotaTimezone}` }] },
  ];
  if (!domainReady) {
    blocks.splice(2, 0, quote([paragraph('⚠️ 站点域名未配置，当前无法签发直链，请在后台「Telegram Bot 设置」中配置。')]));
  }

  const keyboard: BotInlineButton[][] = [
    ttlPresets.map(hours => ({ text: `有效期 ${hours}h`, callback_data: `ba:ttl:${hours}` })),
    limitPresets.map(limit => ({ text: `额度 ${limit}`, callback_data: `ba:lim:${limit}` })),
    [
      { text: '有效直链', callback_data: 'ba:lk:1' },
      { text: '白名单', callback_data: 'ba:wlp:1' },
    ],
  ];

  return { text, rich: { blocks }, replyMarkup: { inline_keyboard: keyboard } };
}

export interface RevokeConfirmInput {
  grantId: string;
  fileName: string;
  telegramUserId: string;
  expiresAt: string;
  /** 返回列表时的页码，撤销确认由列表跳转而来 */
  returnPage: number;
  scopeLabel?: string;
}

/** 撤销确认页：撤销不可逆（软撤销立即失效），必须先确认一次 */
export function renderRevokeConfirm(input: RevokeConfirmInput): RenderedMessage {
  const { grantId, fileName, telegramUserId, expiresAt, returnPage } = input;
  const text = [
    '确认撤销直链？',
    `文件名：${fileName || '(未命名)'}`,
    `所属用户：${telegramUserId}`,
    `过期时间：${new Date(expiresAt).toISOString()}`,
    '撤销后链接立即失效，且无法恢复。',
  ].join('\n');

  const scopeSuffix = input.scopeLabel && input.scopeLabel !== '全部用户' ? `:u:${input.scopeLabel}` : '';
  return {
    text,
    rich: {
      blocks: [
        heading([{ type: 'bold', text: '确认撤销直链' }], 2),
        table(['项目', '值'], [
          ['文件名', clipFileName(fileName)],
          ['所属用户', telegramUserId],
          ['过期时间', shortExpiry(expiresAt)],
        ]),
        quote([paragraph('撤销后链接立即失效，且无法恢复。')]),
      ],
    },
    replyMarkup: {
      inline_keyboard: [[
        { text: '确认撤销', callback_data: `ba:rvy:${grantId}` },
        { text: '返回列表', callback_data: `ba:rvn:${returnPage}${scopeSuffix}` },
      ]],
    },
  };
}

export interface WhitelistInput {
  ids: string[];
  total: number;
  page?: number;
  pageSize?: number;
}

/** /wl list 与面板「白名单」页共用 */
export function renderWhitelistInput(input: WhitelistInput): RenderedMessage {
  const { ids, total, page, pageSize } = input;
  if (page === undefined || pageSize === undefined) return renderWhitelist(ids, total);

  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  if (total === 0) {
    return {
      text: '白名单为空。',
      rich: { blocks: [paragraph('白名单为空。')] },
      replyMarkup: { inline_keyboard: [[{ text: '返回面板', callback_data: 'ba:root' }]] },
    };
  }

  const text = `白名单（第 ${page}/${totalPages} 页，共 ${total} 个）：\n${ids.map((id, i) => `${(page - 1) * pageSize + i + 1}. ${id}`).join('\n')}`;
  const keyboard: BotInlineButton[] = [];
  if (page > 1) keyboard.push({ text: '上一页', callback_data: `ba:wlp:${page - 1}` });
  if (page < totalPages) keyboard.push({ text: '下一页', callback_data: `ba:wlp:${page + 1}` });
  keyboard.push({ text: '返回面板', callback_data: 'ba:root' });

  return {
    text,
    rich: {
      blocks: [
        heading([{ type: 'bold', text: '白名单' }], 2),
        list(ids.map(id => [paragraph([{ type: 'code', text: id }])])),
        { type: 'footer', text: [{ type: 'italic', text: `第 ${page}/${totalPages} 页 · 共 ${total} 个` }] },
      ],
    },
    replyMarkup: { inline_keyboard: [keyboard] },
  };
}

export interface SettingChangedInput {
  label: string;
  before: string;
  after: string;
  hint?: string;
}

/** /ttl、/limit、/quota_set 的成收回执：前后对比比「已设置」更有信息量 */
export function renderSettingChanged(input: SettingChangedInput): RenderedMessage {
  const { label, before, after, hint } = input;
  const text = [
    `${label}已更新`,
    `原值：${before}`,
    `现值：${after}`,
    ...(hint ? [hint] : []),
  ].join('\n');

  const blocks: BotRichBlock[] = [
    heading([{ type: 'bold', text: `${label}已更新` }], 2),
    table(['项目', '原值', '现值'], [[label, before, after]]),
  ];
  if (hint) blocks.push({ type: 'footer', text: [{ type: 'italic', text: hint }] });

  return { text, rich: { blocks } };
}

/** 清除单账号额度覆盖的回执 */
export function renderOverrideCleared(telegramUserId: string, fallbackLimit: number): RenderedMessage {
  const text = `已清除 ${telegramUserId} 的单独额度，将使用默认额度（${fallbackLimit} 个/天）。`;
  return {
    text,
    rich: {
      blocks: [
        heading([{ type: 'bold', text: '已清除单独额度' }], 2),
        paragraph([{ type: 'code', text: telegramUserId }, ' 将使用默认额度：', { type: 'bold', text: `${fallbackLimit} 个/天` }, '。']),
      ],
    },
  };
}

/** 白名单列表的非分页形态（`renderWhitelistInput` 在未传分页参数时回退到它） */
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
