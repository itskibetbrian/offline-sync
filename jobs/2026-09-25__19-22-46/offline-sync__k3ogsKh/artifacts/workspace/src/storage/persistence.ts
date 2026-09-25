import type { Conflict, LocalMutation, TradeRecord } from "../types";

const KEY = "offline-sync-v1";

type Persisted = {
  records: Record<string, TradeRecord>;
  pending: LocalMutation[];
  conflicts: Conflict[];
  nextId: number;
  server: Record<string, TradeRecord>;
  error: boolean;
};

const seedRecords = (): Record<string, TradeRecord> => ({
  r1: {
    id: "r1",
    title: "Steel shipment",
    notes: "40 tonnes",
    status: "draft",
    version: 1,
    deleted: false
  },
  r2: {
    id: "r2",
    title: "Copper shipment",
    notes: "25 tonnes",
    status: "active",
    version: 1,
    deleted: false
  },
  r3: {
    id: "r3",
    title: "Timber load",
    notes: "12 pallets",
    status: "complete",
    version: 1,
    deleted: false
  }
});

const defaults = (): Persisted => {
  const records = seedRecords();
  return {
    records: JSON.parse(JSON.stringify(records)),
    pending: [],
    conflicts: [],
    nextId: 1,
    server: JSON.parse(JSON.stringify(records)),
    error: false
  };
};

export function load(): Persisted {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return defaults();
    const parsed = JSON.parse(raw) as Partial<Persisted>;
    const base = defaults();
    const records = (parsed.records ?? base.records) as Record<string, TradeRecord>;
    // Migrate persisted state written before the server snapshot existed.
    const server = (parsed.server ?? records) as Record<string, TradeRecord>;
    return {
      records,
      pending: (parsed.pending ?? []) as LocalMutation[],
      conflicts: (parsed.conflicts ?? []) as Conflict[],
      nextId: parsed.nextId ?? 1,
      server: JSON.parse(JSON.stringify(server)),
      error: parsed.error === true
    };
  } catch {
    return defaults();
  }
}

export function save(state: Persisted) {
  localStorage.setItem(KEY, JSON.stringify(state));
}

export function resetPersisted(): Persisted {
  const fresh = defaults();
  save(fresh);
  return fresh;
}

export type { Persisted };
