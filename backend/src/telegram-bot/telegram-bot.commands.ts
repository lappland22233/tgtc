/**
 * Bot 命令目录：路由、帮助文本与 Telegram 命令菜单的**唯一事实源**。
 *
 * 为什么集中：此前命令名在 handleCommand 的 switch、handledAdminCommand 的 switch 与
 * renderHelp 的三处数组里各写一遍，加一条命令要改三处，漏一处就是「帮助里写了但路由没有」
 * 或「路由有但用户看不到」。现在三者都从 `BOT_COMMANDS` 派生，结构上不可能漂移。
 *
 * 权限：`scope` 是唯一判据。`admin` 命令在执行前与回调点击时都会重新校验
 * `TELEGRAM_BOT_ADMIN_IDS`（不缓存），帮助文本与命令菜单按同一 scope 过滤。
 */

export type BotCommandScopeKind = 'user' | 'admin';

export interface BotCommandSpec {
  /** 带斜杠的命令名，路由键（如 `/quota_set`） */
  command: string;
  /** 无斜杠命令名，供 `setMyCommands`（≤32 字符，仅 a-z0-9_） */
  name: string;
  /** 帮助文本与命令菜单共用的说明 */
  description: string;
  scope: BotCommandScopeKind;
  /** 参数不合法时的用法回执 */
  usage: string;
  /** dispatch 内的处理键 */
  handler: string;
}

export const BOT_COMMANDS: readonly BotCommandSpec[] = [
  {
    command: '/start',
    name: 'start',
    description: '开始使用',
    scope: 'user',
    usage: '/start',
    handler: 'help',
  },
  {
    command: '/help',
    name: 'help',
    description: '显示本帮助',
    scope: 'user',
    usage: '/help',
    handler: 'help',
  },
  {
    command: '/id',
    name: 'id',
    description: '查看你的 TG 用户 ID',
    scope: 'user',
    usage: '/id',
    handler: 'id',
  },
  {
    command: '/quota',
    name: 'quota',
    description: '查看今日剩余额度',
    scope: 'user',
    usage: '/quota',
    handler: 'quota',
  },
  {
    command: '/admin',
    name: 'admin',
    description: '管理面板',
    scope: 'admin',
    usage: '/admin',
    handler: 'adminPanel',
  },
  {
    command: '/ttl',
    name: 'ttl',
    description: '设置直链有效期（小时）',
    scope: 'admin',
    usage: '/ttl <1-720>',
    handler: 'setTtl',
  },
  {
    command: '/limit',
    name: 'limit',
    description: '设置通用每日额度',
    scope: 'admin',
    usage: '/limit <数量|default>',
    handler: 'setGeneralLimit',
  },
  {
    command: '/quota_set',
    name: 'quota_set',
    description: '设置指定账号的每日额度',
    scope: 'admin',
    usage: '/quota_set <TG用户ID> <数量|default>',
    handler: 'setUserQuota',
  },
  {
    command: '/wl',
    name: 'wl',
    description: '维护白名单',
    scope: 'admin',
    usage: '/wl add <TG用户ID> | /wl remove <TG用户ID> | /wl list',
    handler: 'whitelist',
  },
  {
    command: '/links',
    name: 'links',
    description: '查看有效直链',
    scope: 'admin',
    usage: '/links [TG用户ID] [页码]',
    handler: 'links',
  },
  {
    command: '/revoke',
    name: 'revoke',
    description: '撤销直链',
    scope: 'admin',
    usage: '/revoke <直链URL或Token>',
    handler: 'revoke',
  },
];

export const COMMAND_INDEX: ReadonlyMap<string, BotCommandSpec> = new Map(
  BOT_COMMANDS.map((spec) => [spec.command, spec]),
);

/** 按权限取可用命令；帮助文本与 setMyCommands 共用，保证两处永不漂移。 */
export function commandsFor(scope: BotCommandScopeKind | 'all'): BotCommandSpec[] {
  if (scope === 'all') return [...BOT_COMMANDS];
  if (scope === 'user') return BOT_COMMANDS.filter((spec) => spec.scope === 'user');
  return [...BOT_COMMANDS];
}

/** 该 TG 用户可见的命令（管理员可见全部，普通用户仅 user scope） */
export function commandsForUser(isAdmin: boolean): BotCommandSpec[] {
  return isAdmin ? commandsFor('admin') : commandsFor('user');
}
