import { pickUserAccount, type WeightedUserAccount } from './user-account-picker';

interface Candidate extends WeightedUserAccount {
  session: string;
}

const candidates: Candidate[] = [
  { id: 'account-b', weight: 1, session: 'session-b' },
  { id: 'account-a', weight: 2, session: 'session-a' },
  { id: 'account-c', weight: 1, session: 'session-c' },
];

describe('pickUserAccount', () => {
  it('same seed picks the same account independent of repository row order', () => {
    const expected = pickUserAccount(candidates, null, 'task-123').account.id;
    const reordered = pickUserAccount([...candidates].reverse(), null, 'task-123').account.id;

    expect(reordered).toBe(expected);
  });

  it('prefers an available explicitly selected account', () => {
    expect(pickUserAccount(candidates, 'account-b', 'task-123')).toMatchObject({
      account: candidates[0],
      fallbackFromPreferred: false,
    });
  });

  it('falls back deterministically when the preferred account is unavailable', () => {
    const first = pickUserAccount(candidates, 'account-missing', 'task-123');
    const second = pickUserAccount([...candidates].reverse(), 'account-missing', 'task-123');

    expect(first.fallbackFromPreferred).toBe(true);
    expect(second.account.id).toBe(first.account.id);
  });

  it('does not mutate the repository candidate list while normalizing order', () => {
    const input = [...candidates];

    pickUserAccount(input, null, 'task-123');

    expect(input).toEqual(candidates);
  });
});
