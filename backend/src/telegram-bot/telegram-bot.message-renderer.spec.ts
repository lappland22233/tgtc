import {
  renderHelp, renderAdminLinks, renderLinkReady, renderNotice, renderQuota, renderQuotaDenied,
  renderQueueNotice, renderWhitelist, renderWhitelistInput, renderAdminPanel, renderRevokeConfirm,
  renderSettingChanged, escapeHtml, CALLBACK_DATA_MAX,
} from './telegram-bot.message-renderer';
import { commandsFor, commandsForUser } from './telegram-bot.commands';

/** 把目录里的命令行转成 renderHelp 期望的形状 */
function helpRows(isAdmin: boolean) {
  return commandsForUser(isAdmin).map(spec => ({
    usage: spec.usage,
    description: spec.description,
    scope: spec.scope,
  }));
}

/**
 * 渲染层的核心不变量：
 * 1. `text` 恒为可直接发送的纯文本（富文本被拒时的兜底）；
 * 2. 用户可控内容（文件名等）只作为 blocks 的字符串值出现，不参与任何标记解析；
 * 3. 结构化能力（表格/折叠块/按钮）确实被使用。
 */
describe('telegram-bot message renderer', () => {
  describe('注入安全', () => {
    const hostile = '<b>x</b>_*`[a](http://evil)|# & "q"';

    it('文件名原样进入 blocks，不产生标记结构', () => {
      const rendered = renderLinkReady({ fileName: hostile, url: 'https://files.example.com/a', expiresAt: '2026-01-01T00:00:00.000Z', ttlHours: 4 });
      // 结构不变量：块类型与样式全部由渲染层写死，用户内容只出现在字符串值位置。
      // 因此 `<b>` 只是数据，客户端不会把它当标签解析（与 markdown 来源的本质区别）。
      const blockTypes = rendered.rich!.blocks.map(block => block.type);
      expect(blockTypes).toEqual(['heading', 'paragraph', 'paragraph', 'pre', 'blockquote']);

      const filenameParagraph = rendered.rich!.blocks[1] as unknown as { text: unknown[] };
      expect(filenameParagraph.text).toContain(hostile);
      expect(JSON.stringify(rendered.rich)).toContain('_*`[a](http://evil)|#');
    });

    it('纯文本兜底保留原始文件名（不过度转义）', () => {
      const rendered = renderQueueNotice({ status: 'queued', position: 1, fileName: hostile });
      expect(rendered.text).toContain(hostile);
    });

    it('rich_fallback_html 对 HTML 特殊字符做转义', () => {
      const rendered = renderQueueNotice({ status: 'failed', fileName: '<script>' });
      expect(rendered.rich_fallback_html ? rendered.rich_fallback_html.includes('<script>') : false).toBe(false);
      expect(escapeHtml('<script>&"')).toBe('&lt;script&gt;&amp;&quot;');
    });
  });

  describe('直链就绪', () => {
    it('保留既有断言依赖的子串，并生成打开链接按钮', () => {
      const rendered = renderLinkReady({
        fileName: 'a.zip', url: 'https://files.example.com/x', expiresAt: '2026-01-01T00:00:00.000Z', ttlHours: 4,
      });
      expect(rendered.text).toContain('下载直链（4 小时内有效');
      expect(rendered.text).toContain('https://files.example.com/x');
      expect(rendered.replyMarkup?.inline_keyboard[0][0].url).toBe('https://files.example.com/x');
      expect(rendered.rich!.blocks.some(block => block.type === 'pre')).toBe(true);
    });

    it('队列形态保留「文件已就绪！」与到期提醒', () => {
      const rendered = renderQueueNotice({
        status: 'ready', fileName: 'b.zip', url: 'https://x/y', expiresAt: '2026-01-01T00:00:00.000Z',
      });
      expect(rendered.text).toContain('文件已就绪！');
      expect(rendered.text).toContain('下载直链（有效期至');
      expect(rendered.text).toContain('⚠️ 链接到期后文件将自动失效并删除。');
    });

    it('非 http(s) 链接不生成按钮', () => {
      const rendered = renderLinkReady({ fileName: 'c', url: 'javascript:alert(1)', expiresAt: 'x', ttlHours: 1 });
      expect(rendered.replyMarkup).toBeUndefined();
    });
  });

  describe('队列状态', () => {
    it('可取消的态才挂取消按钮，且回调数据带任务 ID', () => {
      const queued = renderQueueNotice({ status: 'queued', position: 3, fileName: 'f', cancelCallbackData: 'bot_cancel:t1' });
      expect(queued.replyMarkup?.inline_keyboard[0][0].callback_data).toBe('bot_cancel:t1');

      const done = renderQueueNotice({ status: 'cancelled', fileName: 'f', cancelCallbackData: 'bot_cancel:t1' });
      expect(done.replyMarkup?.inline_keyboard[0][0].callback_data).toBe('bot_cancel:t1');

      const ready = renderQueueNotice({ status: 'ready', fileName: 'f', url: 'https://x/y', expiresAt: 'e' });
      expect(ready.replyMarkup?.inline_keyboard[0][0].url).toBe('https://x/y');
    });

    it('失败态与历史文案完全一致且不带文件名', () => {
      expect(renderQueueNotice({ status: 'failed', fileName: 'f' }).text).toBe('创建下载链接失败，请稍后重试。');
      expect(renderQueueNotice({ status: 'failed', fileName: 'f', failureReason: 'disk_unavailable' }).text)
        .toBe('服务器临时磁盘空间不足，无法转存文件，请稍后重试。');
      expect(renderQueueNotice({ status: 'maintenance' }).text).toBe('服务正在维护重启中，请稍后重新发送文件。');
    });
  });

  describe('结构化消息', () => {
    it('/help 含命令列表；管理员额外看到折叠块，且普通用户看不到管理命令', () => {
      const user = renderHelp({ admin: false, commands: helpRows(false) });
      expect(user.text).toContain('可用命令：');
      expect(user.rich!.blocks.some(block => block.type === 'details')).toBe(false);
      // 权限边界：普通用户的帮助里绝不出现管理命令
      expect(user.text).not.toContain('/admin');
      expect(user.text).not.toContain('/quota_set');

      const admin = renderHelp({ admin: true, commands: helpRows(true) });
      expect(admin.text).toContain('/admin');
      expect(admin.text).toContain('/quota_set');
      expect(admin.rich!.blocks.some(block => block.type === 'details')).toBe(true);
      // 旧命令已整体替换，不得残留在帮助里
      expect(admin.text).not.toContain('/wl_add');
      expect(admin.text).not.toContain('/link_query');
    });

    it('/help 不会把 /start 与 /help 重复列出', () => {
      const user = renderHelp({ admin: false, commands: helpRows(false) });
      expect(user.text.match(/\/start/g) ?? []).toHaveLength(0);
      expect(user.text.match(/\/help/g) ?? []).toHaveLength(1);
    });

    it('/quota 加粗数字并保留时区说明与额度来源', () => {
      const rendered = renderQuota({
        whitelisted: false, used: 2, limit: 5, remaining: 3, timezone: 'Asia/Shanghai', source: 'user',
      });
      expect(rendered.text).toContain('今日已使用 2 / 5，剩余 3 次。');
      expect(rendered.text).toContain('Asia/Shanghai');
      expect(JSON.stringify(rendered.rich)).toContain('"bold"');
      expect(JSON.stringify(rendered.rich)).toContain('单独额度');
    });

    it('/quota 耗尽按额度来源给出不同指引', () => {
      expect(renderQuotaDenied({ limit: 5, source: 'global' }).text).toContain('今日额度已用完（5 个文件/天）');
      expect(renderQuotaDenied({ limit: 5, source: 'global' }).text).toContain('加入白名单');
      expect(renderQuotaDenied({ limit: 20, source: 'user' }).text).toContain('联系管理员调整额度');
      expect(renderQuota({ whitelisted: true }).text).toContain('不限每日文件数');
    });

    it('/links 用表格承载，分页 footer 与撤销按钮都在', () => {
      const grantId = '11111111-2222-3333-4444-555555555555';
      const rendered = renderAdminLinks({
        scopeLabel: '42',
        page: 1,
        pageSize: 5,
        total: 12,
        rows: [
          { grantId, fileName: 'a.zip', expiresAt: '2026-01-01T00:00:00.000Z', url: 'https://x/y' },
          { grantId, fileName: 'b.zip', expiresAt: '2026-01-01T00:00:00.000Z', url: null, prefix: 'abc' },
        ],
      });
      expect(rendered.rich!.blocks.some(block => block.type === 'table')).toBe(true);
      expect(rendered.text).toContain('https://x/y');
      expect(rendered.text).toContain('未启用加密存储');
      expect(rendered.text).toContain('直链（42）');

      const buttons = rendered.replyMarkup!.inline_keyboard.flat();
      const revoke = buttons.find(button => button.callback_data?.startsWith('ba:rv:'));
      expect(revoke).toBeDefined();
      expect(revoke!.callback_data).toContain(grantId);
      // 硬约束：任何按钮数据都不得超过 Telegram 的 64 字节上限
      for (const button of buttons) {
        expect((button.callback_data ?? '').length).toBeLessThanOrEqual(CALLBACK_DATA_MAX);
      }
    });

    it('/links 空列表给出明确文案而非空表格', () => {
      const rendered = renderAdminLinks({ scopeLabel: '全部用户', page: 1, pageSize: 5, total: 0, rows: [] });
      expect(rendered.text).toContain('当前没有有效的直链');
      expect(rendered.rich!.blocks.some(block => block.type === 'table')).toBe(false);
    });

    it('管理面板展示生效配置与预设档位按钮', () => {
      const rendered = renderAdminPanel({
        ttlHours: 4,
        ttlPresets: [2, 6, 12],
        generalLimit: 5,
        limitPresets: [3, 10],
        whitelistCount: 2,
        overrideCount: 1,
        activeLinkCount: 7,
        usageDate: '2026-11-27',
        quotaTimezone: 'Asia/Shanghai',
        storageMode: 'telegram',
        domainReady: true,
      });
      expect(rendered.text).toContain('直链有效期：4 小时');
      expect(rendered.text).toContain('通用每日额度：5 个/天');
      expect(rendered.rich!.blocks.some(block => block.type === 'table')).toBe(true);

      const data = rendered.replyMarkup!.inline_keyboard.flat().map(button => button.callback_data);
      expect(data).toContain('ba:ttl:6');
      expect(data).toContain('ba:lim:10');
      expect(data).toContain('ba:lk:1');
      expect(data).toContain('ba:wlp:1');
      for (const item of data) expect((item ?? '').length).toBeLessThanOrEqual(CALLBACK_DATA_MAX);
    });

    it('域名未配置时面板显式警示', () => {
      const rendered = renderAdminPanel({
        ttlHours: 4, ttlPresets: [], generalLimit: 5, limitPresets: [],
        whitelistCount: 0, overrideCount: 0, activeLinkCount: 0,
        usageDate: '2026-11-27', quotaTimezone: 'Asia/Shanghai', storageMode: 'telegram', domainReady: false,
      });
      expect(rendered.text).toContain('未配置');
      expect(JSON.stringify(rendered.rich)).toContain('无法签发直链');
    });

    it('撤销确认页带确认/返回按钮且只携带 grantId', () => {
      const grantId = '11111111-2222-3333-4444-555555555555';
      const rendered = renderRevokeConfirm({
        grantId, fileName: 'a.zip', telegramUserId: '42', expiresAt: '2026-01-01T00:00:00.000Z', returnPage: 2,
      });
      const buttons = rendered.replyMarkup!.inline_keyboard.flat();
      expect(buttons[0].callback_data).toBe(`ba:rvy:${grantId}`);
      expect(buttons[1].callback_data).toBe('ba:rvn:2');
      expect(rendered.text).toContain('无法恢复');
    });

    it('设置回执展示前后对比', () => {
      const rendered = renderSettingChanged({ label: '直链有效期', before: '4 小时', after: '6 小时', hint: '立即生效' });
      expect(rendered.text).toContain('原值：4 小时');
      expect(rendered.text).toContain('现值：6 小时');
      expect(rendered.rich!.blocks.some(block => block.type === 'table')).toBe(true);
    });

    it('/wl list 空与非空分支', () => {
      expect(renderWhitelist([], 0).text).toBe('白名单为空。');
      const rendered = renderWhitelist(['1', '2'], 5);
      expect(rendered.text).toContain('共 5 个');
      expect(rendered.text).toContain('已截断');
    });

    it('/wl list 分页形态给出翻页按钮', () => {
      const rendered = renderWhitelistInput({ ids: ['1', '2'], total: 12, page: 1, pageSize: 5 });
      expect(rendered.text).toContain('第 1/3 页');
      const data = rendered.replyMarkup!.inline_keyboard.flat().map(button => button.callback_data);
      expect(data).toContain('ba:wlp:2');
      expect(data).toContain('ba:root');
    });

    it('renderNotice 只在指定关键 token 上加粗', () => {
      expect(renderNotice('plain').parseMode).toBeUndefined();
      const rendered = renderNotice('额度 5 已用完', { emphasize: ['5'] });
      expect(rendered.parseMode).toBe('HTML');
      expect(rendered.rich_fallback_html).toContain('<b>5</b>');
      expect(rendered.text).toBe('额度 5 已用完');
    });
  });

  describe('命令目录', () => {
    it('普通用户命令不含任何 admin scope', () => {
      expect(commandsFor('user').every(spec => spec.scope === 'user')).toBe(true);
      expect(commandsForUser(false).map(spec => spec.command)).toEqual(
        expect.arrayContaining(['/help', '/id', '/quota']),
      );
    });

    it('管理员命令齐全且覆盖旧命令的全部能力', () => {
      const admin = commandsForUser(true).map(spec => spec.command);
      expect(admin).toEqual(expect.arrayContaining([
        '/admin', '/ttl', '/limit', '/quota_set', '/wl', '/links', '/revoke',
      ]));
      expect(admin).not.toContain('/wl_add');
      expect(admin).not.toContain('/link_query');
      expect(admin).not.toContain('/link_revoke');
    });

    it('命令名满足 Telegram 约束（≤32 字符、无斜杠、小写下划线）', () => {
      for (const spec of commandsFor('all')) {
        expect(spec.name).toMatch(/^[a-z0-9_]{1,32}$/);
        expect(spec.description.length).toBeLessThanOrEqual(256);
      }
    });
  });
});
