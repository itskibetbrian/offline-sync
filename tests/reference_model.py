"""Independent Python reference state machine for offline sync.

Mirrors tests/reference/model.ts. The sealed verifier uses this, never app code.
"""
import copy

EDITABLE = ("title", "notes", "status")

# Merge machinery treats `deleted` as a fourth field, except that a delete on
# one side concurrent with edits on the other always yields one conflict on
# field "deleted" (see _reconcile). Conflict values use words, never bools.
DELETED_WORD = "deleted"
PRESENT_WORD = "present"

VALID_STATUSES = ("draft", "active", "complete")


def _deleted_word(record):
    return DELETED_WORD if record["deleted"] else PRESENT_WORD


def seed_records():
    return {
        "r1": {"id": "r1", "title": "Steel shipment", "notes": "40 tonnes", "status": "draft", "version": 1, "deleted": False},
        "r2": {"id": "r2", "title": "Copper shipment", "notes": "25 tonnes", "status": "active", "version": 1, "deleted": False},
        "r3": {"id": "r3", "title": "Timber load", "notes": "12 pallets", "status": "complete", "version": 1, "deleted": False},
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
    ops = []
    for o in pending:
        entry = {
            "id": o["id"],
            "recordId": o["recordId"],
            "fields": sorted(o["fields"].keys()),
            "baseVersion": o["baseVersion"],
        }
        if o.get("deleted") is not None:
            entry["deleted"] = o["deleted"]
        if o.get("created") is not None:
            entry["created"] = o["created"]
        ops.append(entry)
    return {
        "records": copy.deepcopy(s["records"]),
        "pendingOperations": ops,
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


def _pending_touches_deleted(s, record_id):
    return any(
        o["recordId"] == record_id and o.get("deleted") is not None
        for o in s["pending"]
    )


def _upsert_conflict(s, record_id, field, local_value, remote_value):
    existing = next((c for c in s["conflicts"] if c["recordId"] == record_id and c["field"] == field), None)
    if local_value != remote_value:
        if existing is None:
            s["conflicts"].append(
                {"recordId": record_id, "field": field, "localValue": local_value, "remoteValue": remote_value}
            )
        else:
            existing["localValue"] = local_value
            existing["remoteValue"] = remote_value
    elif existing is not None:
        s["conflicts"] = [c for c in s["conflicts"] if not (c["recordId"] == record_id and c["field"] == field)]


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
            _upsert_conflict(s, record_id, f, str(display[f]), str(incoming[f]))
    # The deleted flag merges like a field, with one extra rule: a delete on
    # one side concurrent with edits on the other always yields exactly one
    # conflict on field "deleted", using the words "deleted"/"present".
    flag_touched = _pending_touches_deleted(s, record_id)
    if flag_touched:
        nxt["deleted"] = display["deleted"]
    if flag_touched and incoming["deleted"] != prev["deleted"]:
        _upsert_conflict(
            s, record_id, "deleted",
            _deleted_word(display), _deleted_word(incoming),
        )
    elif display["deleted"] != incoming["deleted"] and any(
        o["recordId"] == record_id for o in s["pending"]
    ):
        # A delete racing local edits, or pending flag work meeting an
        # incoming record still carrying the old flag. With nothing pending
        # at all, an incoming flag change merges silently (rule 1's mirror).
        _upsert_conflict(
            s, record_id, "deleted",
            _deleted_word(display), _deleted_word(incoming),
        )
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


def _append_flag_op(s, record_id, deleted):
    """Delete/restore mutation. Editing a deleted record never restores it;
    only an explicit restore clears the flag."""
    record = s["records"][record_id]
    if record["deleted"] == deleted:
        return
    server_rec = s["server"].get(record_id, record)
    s["pending"].append(
        {"id": s["next_id"], "recordId": record_id, "fields": {}, "baseVersion": server_rec["version"], "deleted": deleted}
    )
    s["next_id"] += 1
    s["records"][record_id] = {**record, "deleted": deleted}
    if s["online"]:
        s["syncing"] = True
    s["error"] = False


def delete_record(s, record_id):
    _append_flag_op(s, record_id, True)


def restore_record(s, record_id):
    _append_flag_op(s, record_id, False)


def create_record(s):
    """Local creation: temp id, version 0, full field snapshot as the op."""
    op_id = s["next_id"]
    temp_id = "c%d" % op_id
    record = {
        "id": temp_id, "title": "Untitled", "notes": "",
        "status": "draft", "version": 0, "deleted": False,
    }
    s["pending"].append(
        {"id": op_id, "recordId": temp_id,
         "fields": {"title": "Untitled", "notes": "", "status": "draft"},
         "baseVersion": 0, "created": True}
    )
    s["next_id"] += 1
    s["records"][temp_id] = record
    if s["online"]:
        s["syncing"] = True
    s["error"] = False
    return temp_id


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
    if remote["id"] != op["recordId"]:
        # Acceptance of a creation: the server assigned a real id. Every
        # reference to the temp id moves over before replay runs.
        for o in remaining:
            if o["recordId"] == op["recordId"]:
                o["recordId"] = remote["id"]
        for c in s["conflicts"]:
            if c["recordId"] == op["recordId"]:
                c["recordId"] = remote["id"]
        if op["recordId"] in s["records"]:
            del s["records"][op["recordId"]]
    nxt = dict(remote)
    for newer in sorted([o for o in remaining if o["recordId"] == remote["id"]], key=lambda o: o["id"]):
        if newer.get("deleted") is not None:
            nxt["deleted"] = newer["deleted"]
        nxt.update(newer["fields"])
    s["records"][remote["id"]] = nxt
    s["pending"] = remaining
    s["server"][remote["id"]] = dict(remote)
    # A delete/restore mutation acknowledges the "deleted" flag itself, so a
    # lingering "deleted" conflict drops under the same conditions as fields.
    acked_flag = op.get("deleted") is not None
    still = set()
    for r in remaining:
        if r["recordId"] != remote["id"]:
            continue
        still.update(r["fields"].keys())
        if r.get("deleted") is not None:
            still.add("deleted")
    kept = []
    for c in s["conflicts"]:
        if c["recordId"] != remote["id"]:
            kept.append(c)
            continue
        if c["field"] == "deleted":
            if not acked_flag or "deleted" in still:
                kept.append(c)
                continue
            if nxt["deleted"] != remote["deleted"]:
                kept.append(c)
            continue
        if c["field"] not in op["fields"] or c["field"] in still:
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
    if field == "deleted":
        if _deleted_word(s["records"][record_id]) != value:
            if value == DELETED_WORD:
                delete_record(s, record_id)
            else:
                restore_record(s, record_id)
    elif str(s["records"][record_id][field]) != value:
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
    rec = server_bump(s, op["recordId"], dict(op["fields"]))
    if op.get("deleted") is not None:
        rec["deleted"] = op["deleted"]
    return rec


def server_ack_create(s, op):
    """Server acceptance of a creation: the record as currently displayed,
    stamped with a fresh real id and version 1."""
    disp = s["records"][op["recordId"]]
    return {"id": "n%d" % op["id"], "title": disp["title"],
            "notes": disp["notes"], "status": disp["status"],
            "deleted": disp["deleted"], "version": 1}


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
    if op.get("deleted") is not None:
        changes["deleted"] = not op["deleted"]
    return server_bump(s, op["recordId"], changes)


def server_remote_update(s, record_id, changes):
    return server_bump(s, record_id, changes)


def choose_event(rng, s, step, last_acked):
    """One deterministic event valid against current model state.

    Returns tuples consumed by both the model and the browser driver:
    ("local", rid, field, value), ("remote", rec), ("ack", id, rec),
    ("dup", id, rec), ("stale", id, rec), ("failure", id),
    ("resolve", rid, field, value), ("online", bool),
    ("delete", rid), ("restore", rid), ("create",).
    """
    pend = sorted(s["pending"], key=lambda o: o["id"])
    conf = sorted(s["conflicts"], key=lambda c: (c["recordId"], c["field"]))
    ids = sorted(s["records"])
    options = [("local", 5), ("remote", 3), ("create", 3)]
    if any(not s["records"][i]["deleted"] for i in ids):
        options += [("delete", 3)]
    if any(s["records"][i]["deleted"] for i in ids):
        options += [("restore", 3)]
    noncreated = [o for o in pend if not o.get("created")]
    # The server never addresses records it has not accepted yet: ack, stale
    # and remote skip version-0 records (their field operations wait behind
    # their creation). Failures may target anything.
    accepted = [o for o in pend if s["records"][o["recordId"]]["version"] > 0]
    if pend:
        options += [("failure", 2)]
    if [o for o in pend if o.get("created") or o in accepted]:
        options += [("ack", 4)]
    if [o for o in noncreated if o in accepted]:
        options += [("stale", 3)]
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
        if rng.random() < 0.12:
            rid = "rx%d" % step
            return ("remote", {
                "id": rid, "title": "Extra %d" % step,
                "notes": "note %d" % step, "status": "draft", "version": 1,
                "deleted": False,
            })
        # The server never addresses records it has not accepted yet.
        synced = [i for i in ids if s["records"][i]["version"] > 0]
        if rng.random() < 0.25:
            present = [i for i in synced if not s["records"][i]["deleted"]]
            if present:
                rid = rng.choice(present)
                return ("remote", server_remote_update(
                    s, rid, {"deleted": True}))
        rid = rng.choice(synced)
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
        ackable = [o for o in pend if o.get("created") or o in accepted]
        op = ackable[0] if rng.random() < 0.6 else rng.choice(ackable)
        if op.get("created"):
            return ("ack", op["id"], server_ack_create(s, op))
        return ("ack", op["id"], server_applying(s, op))
    if kind == "stale":
        # Stale rejects never target creations: the server has no snapshot
        # to disagree with until it accepts them.
        op = rng.choice([o for o in noncreated if o in accepted])
        return ("stale", op["id"], server_stale(s, op))
    if kind == "failure":
        return ("failure", rng.choice(pend)["id"])
    if kind == "resolve":
        c = conf[0] if rng.random() < 0.7 else rng.choice(conf)
        value = c["localValue"] if rng.random() < 0.5 else c["remoteValue"]
        return ("resolve", c["recordId"], c["field"], value)
    if kind == "dup":
        return ("dup",) + tuple(last_acked)
    if kind == "delete":
        present = [i for i in ids if not s["records"][i]["deleted"]]
        return ("delete", rng.choice(present))
    if kind == "restore":
        gone = [i for i in ids if s["records"][i]["deleted"]]
        return ("restore", rng.choice(gone))
    if kind == "create":
        return ("create",)
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
