import { describe, expect, it } from 'vitest';
import { computeSchedule } from './scheduler.js';

const lock = new Date('2025-01-01T12:00:00.000Z');

describe('computeSchedule', () => {
  it('returns empty schedule for no items', () => {
    const r = computeSchedule([], lock);
    expect(r.vendorSchedules).toHaveLength(0);
    expect(r.targetReadyAt).toEqual(lock);
  });

  it('fires the slowest vendor immediately', () => {
    const r = computeSchedule(
      [
        { vendorId: 'burger', prepSeconds: 600 },
        { vendorId: 'drinks', prepSeconds: 60 },
      ],
      lock,
    );
    const burger = r.vendorSchedules.find((v) => v.vendorId === 'burger')!;
    expect(burger.fireOffsetMs).toBe(0);
  });

  it('delays faster vendors so everything finishes together', () => {
    const r = computeSchedule(
      [
        { vendorId: 'burger', prepSeconds: 600 },
        { vendorId: 'drinks', prepSeconds: 60 },
      ],
      lock,
    );
    const drinks = r.vendorSchedules.find((v) => v.vendorId === 'drinks')!;
    // drinks take 60s, target is 600s out => fire at 540s.
    expect(drinks.fireOffsetMs).toBe(540_000);
  });

  it('every ticket finishes exactly at targetReadyAt', () => {
    const r = computeSchedule(
      [
        { vendorId: 'a', prepSeconds: 300 },
        { vendorId: 'b', prepSeconds: 120 },
        { vendorId: 'c', prepSeconds: 480 },
      ],
      lock,
    );
    for (const v of r.vendorSchedules) {
      const finish = v.fireAt.getTime() + v.ticketPrepSeconds * 1000;
      expect(finish).toBe(r.targetReadyAt.getTime());
    }
  });

  it('uses max prep per vendor across multiple items', () => {
    const r = computeSchedule(
      [
        { vendorId: 'a', prepSeconds: 120 },
        { vendorId: 'a', prepSeconds: 300 },
      ],
      lock,
    );
    expect(r.vendorSchedules).toHaveLength(1);
    expect(r.vendorSchedules[0]!.ticketPrepSeconds).toBe(300);
  });
});
