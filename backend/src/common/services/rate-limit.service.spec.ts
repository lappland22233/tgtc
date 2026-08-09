import { RateLimitService } from './rate-limit.service';

describe('RateLimitService', () => {
  const query = jest.fn();
  const repo: any = { manager: { query }, findOne: jest.fn(), delete: jest.fn(), createQueryBuilder: jest.fn() };
  const service = new RateLimitService(repo);
  beforeEach(() => jest.clearAllMocks());

  it.each([0, -1, Infinity, 86400001])('rejects invalid lock duration %s', async (duration) => {
    await expect(service.checkAndIncrement('k', 't', 3, duration, 1000)).rejects.toThrow('lockDurationMs 无效');
  });

  it('allows a non-locked upsert result', async () => {
    query.mockResolvedValue([{ attemptCount: 1, lockedUntil: null }]);
    await expect(service.checkAndIncrement('k', 't', 3, 1000, 1000)).resolves.toEqual({ allowed: true });
    expect(query).toHaveBeenCalledWith(expect.stringContaining('ON CONFLICT'), expect.arrayContaining(['k', 't']));
  });

  it('returns exact wait for newly locked row', async () => {
    query.mockResolvedValue([{ lockedUntil: new Date(Date.now() + 61000) }]);
    await expect(service.checkAndIncrement('k', 't', 3, 61000, 1000)).resolves.toEqual({ allowed: false, waitMinutes: 2 });
  });

  it('looks up exact wait when conflict row is already locked', async () => {
    query.mockResolvedValue([]);
    repo.findOne.mockResolvedValue({ lockedUntil: new Date(Date.now() + 120000) });
    const result = await service.checkAndIncrement('k', 't', 3, 900000, 1000);
    expect(result.allowed).toBe(false);
    expect(result.waitMinutes).toBeGreaterThanOrEqual(2);
  });

  it('falls back to configured wait when locked row disappeared', async () => {
    query.mockResolvedValue([]);
    repo.findOne.mockResolvedValue(null);
    await expect(service.checkAndIncrement('k', 't', 3, 61000, 1000)).resolves.toEqual({ allowed: false, waitMinutes: 2 });
  });

  it.each([[0, 1000], [-1, 1000], [1.5, 1000], [2, 0], [2, 86400001]])('validates counter threshold/window', async (threshold, window) => {
    await expect(service.incrementCounter('k', 't', threshold, window)).rejects.toThrow();
  });

  it('increments atomic counter and reports threshold', async () => {
    query.mockResolvedValue([{ attemptCount: '3' }]);
    await expect(service.incrementCounter('k', 't', 3, 1000)).resolves.toEqual({ count: 3, thresholdReached: true });
    query.mockResolvedValue([]);
    await expect(service.incrementCounter('k', 't', 3, 1000)).resolves.toEqual({ count: 1, thresholdReached: false });
  });

  it('resets safely and reports attempts', async () => {
    repo.delete.mockResolvedValue({ affected: 1 });
    await expect(service.reset('k')).resolves.toBeUndefined();
    repo.delete.mockRejectedValue(new Error('db'));
    await expect(service.reset('k')).resolves.toBeUndefined();
    repo.findOne.mockResolvedValueOnce({ attemptCount: 4 }).mockResolvedValueOnce(null);
    await expect(service.getAttemptCount('k')).resolves.toBe(4);
    await expect(service.getAttemptCount('x')).resolves.toBe(0);
  });

  it('cleans expired records and normalizes affected count', async () => {
    const qb: any = {};
    Object.assign(qb, { delete: jest.fn(() => qb), from: jest.fn(() => qb), where: jest.fn(() => qb), orWhere: jest.fn(() => qb), execute: jest.fn().mockResolvedValue({ affected: 2 }) });
    repo.createQueryBuilder.mockReturnValue(qb);
    await expect(service.cleanupExpired()).resolves.toBe(2);
    expect(qb.where).toHaveBeenCalled();
    qb.execute.mockResolvedValue({});
    await expect(service.cleanupExpired()).resolves.toBe(0);
  });
});
