// The core domain logic: given the items in a group, compute when each
// vendor's ticket should fire so that all food finishes within one window.
//
// Model (static prep times for now):
//   - Each order item has a prep duration (seconds).
//   - Items are grouped into one ticket per vendor.
//   - A ticket's prep time = the MAX prep time of its items (a kitchen works
//     items in parallel; the ticket is done when its slowest item is done).
//     If you'd rather model a single cook line working items sequentially,
//     swap max() for a sum() here — that's the only change needed.
//   - target_ready = anchor + max(ticket prep across all vendors)
//   - each ticket fires at: target_ready - ticket_prep
//     => the slowest vendor fires immediately; faster vendors wait.
//
// The ANCHOR is the moment cooking is allowed to begin — not necessarily the
// lock time. lockGroup() calls this with the lock time for a provisional
// display estimate; maybeSchedule() calls it again with the all-paid moment,
// which is when fire times actually count. Anchoring real fire times at lock
// would let a slow payment push them all into the past and collapse the
// stagger (every ticket firing at once).
//
// This is deliberately a pure function of its inputs so it can be unit-tested
// without a database, queue, or clock. When GoTab provides live cook estimates,
// only the prepSeconds values feeding this change — the math stays identical.

export interface SchedulerItem {
  vendorId: string;
  prepSeconds: number;
}

export interface VendorSchedule {
  vendorId: string;
  ticketPrepSeconds: number;
  // ms offset from the anchor at which this ticket should fire.
  fireOffsetMs: number;
  fireAt: Date;
}

export interface ScheduleResult {
  targetReadyAt: Date;
  vendorSchedules: VendorSchedule[];
}

export function computeSchedule(
  items: SchedulerItem[],
  anchor: Date,
): ScheduleResult {
  if (items.length === 0) {
    return { targetReadyAt: anchor, vendorSchedules: [] };
  }

  // Ticket prep per vendor = max item prep for that vendor.
  const prepByVendor = new Map<string, number>();
  for (const it of items) {
    const cur = prepByVendor.get(it.vendorId) ?? 0;
    if (it.prepSeconds > cur) prepByVendor.set(it.vendorId, it.prepSeconds);
  }

  const maxPrepSeconds = Math.max(...prepByVendor.values());
  const targetReadyAt = new Date(anchor.getTime() + maxPrepSeconds * 1000);

  const vendorSchedules: VendorSchedule[] = [];
  for (const [vendorId, ticketPrepSeconds] of prepByVendor) {
    const fireOffsetMs = (maxPrepSeconds - ticketPrepSeconds) * 1000;
    vendorSchedules.push({
      vendorId,
      ticketPrepSeconds,
      fireOffsetMs,
      fireAt: new Date(anchor.getTime() + fireOffsetMs),
    });
  }

  // Earliest-firing first (purely for predictable ordering).
  vendorSchedules.sort((a, b) => a.fireOffsetMs - b.fireOffsetMs);
  return { targetReadyAt, vendorSchedules };
}
