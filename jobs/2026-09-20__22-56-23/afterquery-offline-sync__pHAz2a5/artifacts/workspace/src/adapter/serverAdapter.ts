import type { LocalMutation, TradeRecord } from "../types";

export type AdapterEvent =
  | { type: "ack"; mutationId: number; record: TradeRecord }
  | { type: "stale"; mutationId: number; record: TradeRecord }
  | { type: "remote"; record: TradeRecord }
  | { type: "failure"; mutationId: number }
  | { type: "connectivity"; online: boolean };

type Listener = (event: AdapterEvent) => void;

const listeners = new Set<Listener>();
let online = true;
let queuedMutations: LocalMutation[] = [];

export const adapter = {
  subscribe(listener: Listener) {
    listeners.add(listener);
    return () => listeners.delete(listener);
  },

  isOnline() {
    return online;
  },

  setOnline(value: boolean) {
    online = value;
    this.emit({ type: "connectivity", online: value });
  },

  sendMutation(mutation: LocalMutation) {
    queuedMutations.push(mutation);
  },

  pendingRequests() {
    return [...queuedMutations];
  },

  clearRequest(mutationId: number) {
    queuedMutations = queuedMutations.filter((m) => m.id !== mutationId);
  },

  emit(event: AdapterEvent) {
    if (event.type === "ack" || event.type === "stale" || event.type === "failure") {
      this.clearRequest(event.mutationId);
    }
    listeners.forEach((listener) => listener(event));
  },

  reset() {
    online = true;
    queuedMutations = [];
  }
};
