import {
  renderHelp, renderLinkQuery, renderLinkReady, renderNotice, renderQuota, renderQuotaDenied,
  renderQueueNotice, renderWhitelist, escapeHtml,
} from './telegram-bot.message-renderer';

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
    it('/help 含命令列表；管理员额外看到折叠块', () => {
      const user = renderHelp({ admin: false });
      expect(user.text).toContain('可用命令：');
      expect(user.rich!.blocks.some(block => block.type === 'details')).toBe(false);

      const admin = renderHelp({ admin: true });
      expect(admin.text).toContain('/wl_add');
      expect(admin.rich!.blocks.some(block => block.type === 'details')).toBe(true);
    });

    it('/quota 加粗数字并保留时区说明', () => {
      const rendered = renderQuota({ whitelisted: false, used: 2, limit: 5, remaining: 3, timezone: 'Asia/Shanghai' });
      expect(rendered.text).toContain('今日已使用 2 / 5，剩余 3 次。');
      expect(rendered.text).toContain('Asia/Shanghai');
      expect(JSON.stringify(rendered.rich)).toContain('"bold"');
    });

    it('/quota 耗尽与白名单分支', () => {
      expect(renderQuotaDenied(5).text).toContain('今日额度已用完（5 个文件/天）');
      expect(renderQuota({ whitelisted: true }).text).toContain('不限每日文件数');
    });

    it('/link_query 用表格承载，并标注无法回放的链接', () => {
      const rendered = renderLinkQuery('42', [
        { fileName: 'a.zip', expiresAt: '2026-01-01T00:00:00.000Z', url: 'https://x/y' },
        { fileName: 'b.zip', expiresAt: '2026-01-01T00:00:00.000Z', url: null, prefix: 'abc' },
      ], 2);
      expect(rendered.rich!.blocks.some(block => block.type === 'table')).toBe(true);
      expect(rendered.text).toContain('https://x/y');
      expect(rendered.text).toContain('未启用加密存储');
      expect(rendered.text).toContain(`直链（42）`);
    });

    it('/wl_list 空与非空分支', () => {
      expect(renderWhitelist([], 0).text).toBe('白名单为空。');
      const rendered = renderWhitelist(['1', '2'], 5);
      expect(rendered.text).toContain('共 5 个');
      expect(rendered.text).toContain('已截断');
    });

    it('renderNotice 只在指定关键 token 上加粗', () => {
      expect(renderNotice('plain').parseMode).toBeUndefined();
      const rendered = renderNotice('额度 5 已用完', { emphasize: ['5'] });
      expect(rendered.parseMode).toBe('HTML');
      expect(rendered.rich_fallback_html).toContain('<b>5</b>');
      expect(rendered.text).toBe('额度 5 已用完');
    });
  });
});
