import type { Conflict, LocalMutation, TradeRecord } from "../types";

const KEY = "offline-sync-v1";

type Persisted = {
  records: Record<string, TradeRecord>;
  pending: LocalMutation[];
  conflicts: Conflict[];
  nextId: number;
};

const seedRecords = (): Record<string, TradeRecord> => ({
  r1: {
    id: "r1",
    title: "Steel shipment",
    notes: "40 tonnes",
    status: "draft",
    version: 1
  },
  r2: {
    id: "r2",
    title: "Copper shipment",
    notes: "25 tonnes",
    status: "active",
    version: 1
  },
  r3: {
    id: "r3",
    title: "Timber load",
    notes: "12 pallets",
    status: "complete",
    version: 1
  }
});

const defaults = (): Persisted => ({
  records: seedRecords(),
  pending: [],
  conflicts: [],
  nextId: 1
});

export function load(): Persisted {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return defaults();
    return JSON.parse(raw) as Persisted;
  } catch {
    return defaults();
  }
}

export function save(state: Persisted) {
  localStorage.setItem(KEY, JSON.stringify(state));
}

export type { Persisted };
