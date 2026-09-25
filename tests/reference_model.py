"""Independent Python reference state machine for offline sync.

Mirrors tests/reference/model.ts. The sealed verifier uses this, never app code.
"""
import copy

EDITABLE = ("title", "notes", "status")

VALID_STATUSES = ("draft", "active", "complete")


def seed_records():
    return {
        "r1": {"id": "r1", "title": "Steel shipment", "notes": "40 tonnes", "status": "draft", "version": 1},
        "r2": {"id": "r2", "title": "Copper shipment", "notes": "25 tonnes", "status": "active", "version": 1},
        "r3": {"id": "r3", "title": "Timber load", "notes": "12 pallets", "status": "complete", "version": 1},
    }


def initial_model():
    records = seed_records()
    return {
        "records": copy.deepcopy(records),
        "pending": [],
        "conflicts": [],
        "online": True,
        "syncing": False,
        "error": False,
        "next_id": 1,
        "server": copy.deepcopy(records),
    }


def status_of(s):
    if s["conflicts"]:
        return "conflict"
    if s["syncing"]:
        return "syncing"
    if not s["online"]:
        return "offline"
    if s["error"]:
        return "error"
    return "online"


def canonical(s):
    pending = sorted(s["pending"], key=lambda o: o["id"])
    return {
        "records": copy.deepcopy(s["records"]),
        "pendingOperations": [
            {
                "id": o["id"],
                "recordId": o["recordId"],
                "fields": sorted(o["fields"].keys()),
                "baseVersion": o["baseVersion"],
            }
            for o in pending
        ],
        "syncStatus": status_of(s),
        "conflicts": sorted(s["conflicts"], key=lambda c: (c["recordId"], c["field"])),
    }


def _pending_fields(s, record_id):
    out = set()
    for op in s["pending"]:
        if op["recordId"] != record_id:
            continue
        out.update(op["fields"].keys())
    return out


def _reconcile(s, record_id, incoming):
    display = s["records"][record_id]
    prev = s["server"].get(record_id, display)
    touched = _pending_fields(s, record_id)
    nxt = dict(incoming)
    for f in EDITABLE:
        if f in touched:
            nxt[f] = display[f]
    for f in EDITABLE:
        if f in touched and incoming[f] != prev[f]:
            local_value = str(display[f])
            remote_value = str(incoming[f])
            existing = next((c for c in s["conflicts"] if c["recordId"] == record_id and c["field"] == f), None)
            if local_value != remote_value:
                if existing is None:
                    s["conflicts"].append(
                        {"recordId": record_id, "field": f, "localValue": local_value, "remoteValue": remote_value}
                    )
                else:
                    existing["localValue"] = local_value
                    existing["remoteValue"] = remote_value
            elif existing is not None:
                s["conflicts"] = [c for c in s["conflicts"] if not (c["recordId"] == record_id and c["field"] == f)]
    s["records"][record_id] = nxt
    s["server"][record_id] = dict(incoming)


def local_edit(s, record_id, fields):
    record = s["records"][record_id]
    server_rec = s["server"].get(record_id, record)
    clean = {f: fields[f] for f in EDITABLE if f in fields and str(fields[f]) != str(record[f])}
    if not clean:
        return
    # Explicit edits never clear conflicts (rule 8).
    s["pending"].append(
        {"id": s["next_id"], "recordId": record_id, "fields": clean, "baseVersion": server_rec["version"]}
    )
    s["next_id"] += 1
    s["records"][record_id] = {**record, **clean}
    if s["online"]:
        s["syncing"] = True
    s["error"] = False


def remote_update(s, remote):
    if remote["id"] not in s["records"]:
        s["records"][remote["id"]] = dict(remote)
        s["server"][remote["id"]] = dict(remote)
        return
    _reconcile(s, remote["id"], remote)


def stale_reject(s, op_id, remote):
    if not any(o["id"] == op_id for o in s["pending"]):
        return
    if remote["id"] not in s["records"]:
        s["server"][remote["id"]] = dict(remote)
        return
    _reconcile(s, remote["id"], remote)
    s["syncing"] = False


def ack(s, op_id, remote):
    idx = next((i for i, o in enumerate(s["pending"]) if o["id"] == op_id), None)
    if idx is None:
        return  # duplicate ack idempotent
    op = s["pending"][idx]
    remaining = [o for o in s["pending"] if o["id"] != op_id]
    nxt = dict(remote)
    for newer in sorted([o for o in remaining if o["recordId"] == remote["id"]], key=lambda o: o["id"]):
        nxt.update(newer["fields"])
    s["records"][remote["id"]] = nxt
    s["pending"] = remaining
    s["server"][remote["id"]] = dict(remote)
    still = set()
    for r in remaining:
        if r["recordId"] != remote["id"]:
            continue
        still.update(r["fields"].keys())
    kept = []
    for c in s["conflicts"]:
        if c["recordId"] != remote["id"] or c["field"] not in op["fields"] or c["field"] in still:
            kept.append(c)
            continue
        if str(nxt[c["field"]]) != str(remote[c["field"]]):
            kept.append(c)
    s["conflicts"] = kept
    # The engine flushes the next pending op right after acking the head,
    # so syncing stays true exactly while online work remains.
    s["syncing"] = bool(s["online"] and remaining)


def temp_failure(s, op_id):
    if not any(o["id"] == op_id for o in s["pending"]):
        return
    s["syncing"] = False
    s["error"] = True


def set_online(s, online):
    s["online"] = online
    if not online:
        s["syncing"] = False
    else:
        # Mirrors flush(): online with a pending op means a request in flight.
        s["syncing"] = bool(s["pending"])


def resolve_conflict(s, record_id, field, value):
    if not any(c["recordId"] == record_id and c["field"] == field for c in s["conflicts"]):
        return
    if str(s["records"][record_id][field]) != value:
        local_edit(s, record_id, {field: value})
    s["conflicts"] = [c for c in s["conflicts"] if not (c["recordId"] == record_id and c["field"] == field)]


def server_bump(s, record_id, changes):
    """Deterministic server record: apply changes, version one past snapshot."""
    base = dict(s["server"][record_id])
    base.update(changes or {})
    base["version"] = s["server"][record_id]["version"] + 1
    return base


def server_applying(s, op):
    """Server record as if the server just accepted this op."""
    return server_bump(s, op["recordId"], dict(op["fields"]))


def server_stale(s, op):
    """Server record that disagrees with this op on every touched field."""
    changes = {}
    for f in sorted(op["fields"]):
        if f == "status":
            cur = str(op["fields"][f])
            # Status is an enum in the UI (<select> with 3 options), so a stale
            # reject must carry a different *valid* status to force a conflict.
            # Appending " ~remote" would produce an unselectable value and make
            # the seeded sequence undrivable through the UI.
            nxt = next((v for v in VALID_STATUSES if v != cur), cur)
            changes[f] = nxt
        else:
            changes[f] = str(op["fields"][f]) + " ~remote"
    return server_bump(s, op["recordId"], changes)


def server_remote_update(s, record_id, changes):
    return server_bump(s, record_id, changes)


def choose_event(rng, s, step, last_acked):
    """One deterministic event valid against current model state.

    Returns tuples consumed by both the model and the browser driver:
    ("local", rid, field, value), ("remote", rec), ("ack", id, rec),
    ("dup", id, rec), ("stale", id, rec), ("failure", id),
    ("resolve", rid, field, value), ("online", bool).
    """
    pend = sorted(s["pending"], key=lambda o: o["id"])
    conf = sorted(s["conflicts"], key=lambda c: (c["recordId"], c["field"]))
    ids = sorted(s["records"])
    options = [("local", 5), ("remote", 3)]
    if pend:
        options += [("ack", 4), ("stale", 2), ("failure", 2)]
    if conf:
        options += [("resolve", 3)]
    if last_acked:
        options += [("dup", 1)]
    options += [("offline", 1)] if s["online"] else [("online", 2)]
    total = sum(w for _, w in options)
    pick = rng.randrange(total)
    kind = options[-1][0]
    acc = 0
    for key, weight in options:
        acc += weight
        if pick < acc:
            kind = key
            break
    if kind == "local":
        rid = rng.choice(ids)
        field = rng.choice(list(EDITABLE))
        if field == "status":
            # Status is edited through a <select> with exactly
            # draft/active/complete, so the driver can only select valid enum
            # values. Generate a different valid status to guarantee an op.
            cur = str(s["records"][rid]["status"])
            opts = [v for v in VALID_STATUSES if v != cur]
            value = rng.choice(opts) if opts else cur
        else:
            value = "s%d-%s" % (step, field)
        return ("local", rid, field, value)
    if kind == "remote":
        if rng.random() < 0.15:
            rid = "rx%d" % step
            return ("remote", {
                "id": rid, "title": "Extra %d" % step,
                "notes": "note %d" % step, "status": "draft", "version": 1,
            })
        rid = rng.choice(ids)
        fields = rng.sample(list(EDITABLE), rng.choice([1, 1, 2]))
        changes = {}
        for f in fields:
            if f == "status":
                cur = str(s["server"][rid]["status"])
                opts = [v for v in VALID_STATUSES if v != cur]
                changes[f] = rng.choice(opts) if opts else cur
            else:
                changes[f] = "r%d-%s" % (step, f)
        return ("remote", server_remote_update(
            s, rid, changes))
    if kind == "ack":
        op = pend[0] if rng.random() < 0.6 else rng.choice(pend)
        return ("ack", op["id"], server_applying(s, op))
    if kind == "stale":
        op = rng.choice(pend)
        return ("stale", op["id"], server_stale(s, op))
    if kind == "failure":
        return ("failure", rng.choice(pend)["id"])
    if kind == "resolve":
        c = conf[0] if rng.random() < 0.7 else rng.choice(conf)
        value = c["localValue"] if rng.random() < 0.5 else c["remoteValue"]
        return ("resolve", c["recordId"], c["field"], value)
    if kind == "dup":
        return ("dup",) + tuple(last_acked)
    if kind == "offline":
        return ("online", False)
    return ("online", True)


def snapshot(s):
    """Serialize/deserialize round-trip used to model a browser reload."""
    import json

    return json.loads(json.dumps(s))


def restore(snap):
    """Model a browser reload: durable state survives, in-flight does not.

    A fresh boot re-emits the head pending op when online, so syncing is
    recomputed exactly like flush() does. The driver re-asserts adapter
    connectivity right after every reload (the adapter itself is amnesiac).
    """
    s = snap  # snapshot() already handed us a deep copy
    s["syncing"] = bool(s["online"] and s["pending"])
    return s
