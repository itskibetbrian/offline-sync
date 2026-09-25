import type { Conflict, LocalMutation, TradeRecord } from "../types";

const KEY = "afterquery-offline-sync-v1";

type Persisted = {
  records: Record<string, TradeRecord>;
  pending: LocalMutation[];
  conflicts: Conflict[];
  nextId: number;
};

const defaults = (): Persisted => ({
  records: {
    r1: {
      id: "r1",
      title: "Steel shipment",
      notes: "40 tonnes",
      status: "draft",
      version: 1
    }
  },
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
