import { prisma } from '../../db/client.js';

// PrepEstimator seam (S8): the single point where "how long will this item
// take to cook RIGHT NOW" is answered. Price is contractual and stays frozen
// in the snapshot; prep time is a PREDICTION and should be the freshest
// estimate available at the moment fire times are computed.
//
// Today: the static estimator returns the menu item's CURRENT prepSeconds (an
// admin correcting a wrong estimate mid-evening affects the next group, not
// the next deploy), falling back to the snapshot if the item no longer exists.
//
// Phase 2 (per the project doc's load model): a live estimator replaces this
// one — seeded from menu values, refined by rolling `prepared − sent`
// averages per vendor from Ticket data, padded by a queue_adjustment when the
// vendor's SENT count spikes. It plugs in here; nothing outside this module
// changes.

export interface PrepEstimateInput {
  menuItemId: string;
  vendorId: string;
  snapshotPrepSeconds: number;
}

export interface PrepEstimator {
  readonly name: string;
  // Returns seconds keyed by menuItemId. Implementations must return an entry
  // for every distinct input menuItemId (fall back to the snapshot).
  estimate(items: PrepEstimateInput[]): Promise<Map<string, number>>;
}

class StaticMenuEstimator implements PrepEstimator {
  readonly name = 'static-menu';

  async estimate(items: PrepEstimateInput[]): Promise<Map<string, number>> {
    const result = new Map<string, number>();
    if (items.length === 0) return result;

    // Seed with snapshots so every input id has an answer even if the menu
    // item was deleted after the order was placed.
    for (const it of items) {
      if (!result.has(it.menuItemId)) result.set(it.menuItemId, it.snapshotPrepSeconds);
    }

    const current = await prisma.menuItem.findMany({
      where: { id: { in: [...result.keys()] } },
      select: { id: true, prepSeconds: true },
    });
    for (const mi of current) {
      result.set(mi.id, mi.prepSeconds);
    }
    return result;
  }
}

let instance: PrepEstimator | null = null;

export function getPrepEstimator(): PrepEstimator {
  if (!instance) instance = new StaticMenuEstimator();
  return instance;
}
