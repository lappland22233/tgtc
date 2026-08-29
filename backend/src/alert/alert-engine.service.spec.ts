import { AlertLevel } from '../common/entities/alert.entity';
import { AlertEngineService } from './alert-engine.service';

const evaluation = {
  ruleId: 'high_qps',
  level: AlertLevel.WARNING,
  title: '请求速率过高',
  message: 'QPS 超过阈值',
  context: { qps: 120 },
};

function createService(transaction: jest.Mock) {
  const repo = {
    manager: { transaction },
    count: jest.fn(),
  } as any;
  const configCache = { get: jest.fn() } as any;
  return new AlertEngineService(repo, configCache);
}

describe('AlertEngineService', () => {
  const originalDbType = process.env.DB_TYPE;

  afterEach(() => {
    if (originalDbType === undefined) delete process.env.DB_TYPE;
    else process.env.DB_TYPE = originalDbType;
    jest.restoreAllMocks();
  });

  it('casts repeated ruleId parameters consistently for PostgreSQL', async () => {
    process.env.DB_TYPE = 'postgres';
    const inserted = { id: 'alert-id', ...evaluation };
    const query = jest.fn()
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([inserted]);
    const transaction = jest.fn(async (callback) => callback({ query }));
    const service = createService(transaction);

    await expect(service.createAlerts([evaluation], [{
      id: evaluation.ruleId,
      name: evaluation.title,
      level: evaluation.level,
      cooldownMinutes: 5,
      evaluate: jest.fn(),
    }])).resolves.toEqual([inserted]);

    expect(query).toHaveBeenNthCalledWith(
      1,
      'SELECT pg_advisory_xact_lock(hashtext($1))',
      [evaluation.ruleId],
    );
    const [sql, parameters] = query.mock.calls[1];
    expect(sql.match(/\$1::varchar/g)).toHaveLength(2);
    expect(sql).toContain('SELECT $7, $1::varchar, $2');
    expect(sql).toContain('"ruleId" = $1::varchar');
    expect(parameters).toEqual([
      evaluation.ruleId,
      evaluation.level,
      evaluation.title,
      evaluation.message,
      JSON.stringify(evaluation.context),
      expect.any(Date),
      expect.any(String),
    ]);
  });

  it('keeps SQLite placeholders cast-free and returns no alert during cooldown', async () => {
    process.env.DB_TYPE = 'sqlite';
    const query = jest.fn().mockResolvedValue([]);
    const transaction = jest.fn(async (callback) => callback({ query }));
    const service = createService(transaction);

    await expect(service.createAlerts([evaluation], [{
      id: evaluation.ruleId,
      name: evaluation.title,
      level: evaluation.level,
      cooldownMinutes: 5,
      evaluate: jest.fn(),
    }])).resolves.toEqual([]);

    expect(query).toHaveBeenCalledTimes(1);
    expect(query.mock.calls[0][0]).toContain('SELECT ?7, ?1, ?2');
    expect(query.mock.calls[0][0]).not.toContain('::varchar');
  });
});
