/**
 * 回归保护：镜像告警评估的**局部失败隔离**与「零备份」兜底。
 *
 * 事故形态（本用例存在的理由）：
 * - 第 8 条判定（镜像已开启但无启用规则）依赖配置服务，若它的异常冒泡出 `evaluate()`，
 *   本轮已收集的连续失败、权限丢失、主群不可用等告警会一起被丢弃——后台表现为全绿；
 * - 反过来，镜像开着却一条规则都没启用时，触发层直接跳过（不建单），
 *   任务事实表里什么都看不到，必须由这条判定兜住。
 */
import { AlertLevel } from '../common/entities/alert.entity';
import { TelegramMirrorAlertService } from './telegram-mirror-alert.service';

describe('TelegramMirrorAlertService（镜像告警评估）', () => {
  function setup(options: {
    tasks?: Array<Record<string, any>>;
    mirrorEnabled?: boolean;
    enabledRules?: Array<{ id: string }>;
    /** 配置服务读取启用规则时抛错（模拟库/配置服务故障） */
    listRulesError?: Error;
    /** 开关服务读取时抛错 */
    featureError?: Error;
  } = {}) {
    const tasks = options.tasks ?? [];
    // 极简 where 求值：支持等值、`Like('prefix%')` 与 `MoreThanOrEqual(date)` 三类条件，
    // 足够覆盖本服务用到的查询形状（不引入真实 DB）。
    const valueOf = (raw: any) => (raw && typeof raw === 'object' && 'value' in raw ? raw.value : raw);
    const matches = (task: Record<string, any>, condition: Record<string, any>): boolean => (
      Object.entries(condition).every(([key, raw]) => {
        const expected = valueOf(raw);
        if (expected === undefined || expected === null) return true;
        if (typeof expected === 'string' && expected.includes('%')) {
          return String(task[key] ?? '').startsWith(expected.replace(/%/g, ''));
        }
        if (expected instanceof Date) {
          return new Date(task[key] ?? 0).getTime() >= expected.getTime();
        }
        return task[key] === expected;
      })
    );
    const repo = {
      find: jest.fn(async (query: any) => {
        // 只区分「按状态过滤」与「最近任务」两类查询：用例只需覆盖前者
        const where = query?.where;
        if (!where) return tasks;
        const conditions = Array.isArray(where) ? where : [where];
        return tasks.filter((task) => conditions.some((condition: any) => matches(task, condition)));
      }),
      count: jest.fn(async (query: any) => {
        const status = query?.where?.status;
        return tasks.filter((task) => task.status === status).length;
      }),
    };
    const engine = { createAlerts: jest.fn(async () => undefined) };
    const config = {
      listEnabledRules: jest.fn(async () => {
        if (options.listRulesError) throw options.listRulesError;
        return options.enabledRules ?? [];
      }),
    };
    const feature = {
      isMirrorEnabled: jest.fn(async () => {
        if (options.featureError) throw options.featureError;
        return options.mirrorEnabled ?? false;
      }),
    };

    const service = new TelegramMirrorAlertService(
      repo as never,
      engine as never,
      config as never,
      feature as never,
    );
    return { service, engine, config, feature };
  }

  it('镜像已开启但没有任何启用规则：CRITICAL 兜底（否则表现为上传成功、实际零备份）', async () => {
    const { service } = setup({ mirrorEnabled: true, enabledRules: [] });

    const evaluations = await service.evaluate();

    expect(evaluations.map((item) => item.ruleId)).toContain('MIRROR_NO_ENABLED_RULES');
    expect(evaluations.find((item) => item.ruleId === 'MIRROR_NO_ENABLED_RULES')?.level)
      .toBe(AlertLevel.CRITICAL);
  });

  it('有启用规则时不报「零规则」，也不误报', async () => {
    const { service } = setup({ mirrorEnabled: true, enabledRules: [{ id: 'rule-1' }] });

    const evaluations = await service.evaluate();

    expect(evaluations.map((item) => item.ruleId)).not.toContain('MIRROR_NO_ENABLED_RULES');
  });

  it('配置服务读规则失败：只跳过本条判定，其余告警照常上报（绝不整体静默）', async () => {
    const { service } = setup({
      mirrorEnabled: true,
      listRulesError: new Error('SQLITE_BUSY: database is locked'),
      tasks: [
        { id: 't1', status: 'failed', lastErrorCode: 'network_error', createdAt: new Date() },
        { id: 't2', status: 'failed', lastErrorCode: 'network_error', createdAt: new Date() },
        { id: 't3', status: 'blocked', lastErrorCode: 'network_error', createdAt: new Date() },
      ],
    });

    const evaluations = await service.evaluate();

    expect(evaluations.map((item) => item.ruleId)).toContain('MIRROR_FAILURE_STREAK');
    expect(evaluations.map((item) => item.ruleId)).not.toContain('MIRROR_NO_ENABLED_RULES');
  });

  it('开关服务失败：同样只跳过本条判定，不丢弃已收集的告警', async () => {
    const { service } = setup({
      featureError: new Error('feature service unavailable'),
      tasks: [
        {
          id: 't1',
          status: 'blocked',
          lastErrorCode: 'main_chat_missing',
          createdAt: new Date(),
          updatedAt: new Date(),
        },
      ],
    });

    const evaluations = await service.evaluate();

    expect(evaluations.map((item) => item.ruleId)).toContain('MIRROR_MAIN_CHAT_UNAVAILABLE');
    expect(evaluations.map((item) => item.ruleId)).not.toContain('MIRROR_NO_ENABLED_RULES');
  });
});
