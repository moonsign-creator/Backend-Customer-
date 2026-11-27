import { DEFAULT_SETTINGS as S, blockedReason, canReschedule, categoriesForAge, chargeFor, slabFor } from './rules';

describe('billing slabs', () => {
  it('charges the slab reached', () => {
    expect(chargeFor(S, 'astrology', 'chat', 0)).toBe(0);
    expect(chargeFor(S, 'astrology', 'chat', 60)).toBe(299);
    expect(chargeFor(S, 'astrology', 'chat', 600)).toBe(299);
    expect(chargeFor(S, 'astrology', 'chat', 601)).toBe(399);
    expect(chargeFor(S, 'astrology', 'voice', 19 * 60)).toBe(699);
    expect(chargeFor(S, 'tarot', 'chat', 8 * 60)).toBe(199);
    expect(slabFor(S, 30 * 60)).toBe(20);
  });
});

describe('reschedule rules', () => {
  const now = Date.parse('2026-12-01T06:00:00Z');
  const base = { status: 'upcoming', service: 'astrology' as const, rescheduleCount: 0 };
  it('first reschedule needs 30 minutes', () => {
    expect(canReschedule(S, { ...base, slotStart: new Date(now + 31 * 60000) }, now).ok).toBe(true);
    expect(canReschedule(S, { ...base, slotStart: new Date(now + 29 * 60000) }, now).ok).toBe(false);
  });
  it('second reschedule needs 12 hours', () => {
    const b = { ...base, rescheduleCount: 1 };
    expect(canReschedule(S, { ...b, slotStart: new Date(now + 13 * 3600000) }, now).ok).toBe(true);
    expect(canReschedule(S, { ...b, slotStart: new Date(now + 2 * 3600000) }, now).ok).toBe(false);
  });
});

describe('chat moderation', () => {
  it('blocks phones and payment details', () => {
    expect(blockedReason('call me on 98765 43210')).toMatch(/Phone/);
    expect(blockedReason('pay to rahul@okhdfc')).toMatch(/Payment/);
    expect(blockedReason('send via GPay')).toMatch(/Payment/);
    expect(blockedReason('When will I get married?')).toBeNull();
  });
});

describe('categories', () => {
  it('depend on age', () => {
    expect(categoriesForAge(18).def).toBe('Relationship');
    expect(categoriesForAge(35).list).toContain('Children');
  });
});
