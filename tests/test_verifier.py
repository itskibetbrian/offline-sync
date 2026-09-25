"""Sealed verifier: the built app runs in headless Chromium and is compared
event-by-event against the independent Python reference model.

Nothing here reads app source. Only behavior is graded: UI edits and
resolutions go through documented test ids, adapter events go through the
documented adapter hooks, reloads are real page reloads, and every step
asserts deep equality of records, versions, pending projection, conflicts,
and status. A missing bundle fails every browser test, so doing nothing
scores 0.
"""
import functools
import http.server
import json
import random
import threading
from pathlib import Path

import pytest
from playwright.sync_api import sync_playwright

import reference_model as ref

WS = Path("/workspace")
DIST = WS / "dist"

STATE_EXPR = "window.__OFFLINE_SYNC_STATE__()"
READY_EXPR = "window.__OFFLINE_SYNC_READY__ === true"
ADAPTER = "window.__OFFLINE_SYNC_ADAPTER__"
CHROME_ARGS = ["--no-sandbox", "--disable-dev-shm-usage"]
ACTION_TIMEOUT = 8000


# ---------- fixtures ----------

@pytest.fixture(scope="session")
def base_url():
    if not (DIST / "index.html").is_file():
        pytest.fail("missing /workspace/dist/index.html; run npm run build in /workspace")
    handler = functools.partial(http.server.SimpleHTTPRequestHandler, directory=str(DIST))
    server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    yield "http://127.0.0.1:%d/" % server.server_address[1]
    server.shutdown()


@pytest.fixture(scope="session")
def browser():
    try:
        pw = sync_playwright().start()
        launched = pw.chromium.launch(headless=True, args=CHROME_ARGS)
    except Exception as exc:
        pytest.fail("chromium launch failed: %s" % exc)
    yield launched
    launched.close()
    pw.stop()


@pytest.fixture()
def live(browser, base_url):
    """Fresh browser context (clean storage) on the app plus a fresh model."""
    ctx = browser.new_context()
    page = ctx.new_page()
    page.set_default_timeout(ACTION_TIMEOUT)
    page.set_default_navigation_timeout(20000)
    page.goto(base_url)
    page.wait_for_function(READY_EXPR, timeout=20000)
    yield page, ref.initial_model()
    ctx.close()


# ---------- app drivers ----------

def app_state(page):
    return page.evaluate(STATE_EXPR)


def app_set_online(page, online):
    page.evaluate("(on) => %s.setOnline(on)" % ADAPTER, online)


def app_ack(page, op_id, rec):
    page.evaluate(
        "([mid, rec]) => %s.ack(mid, rec)" % ADAPTER, [op_id, rec])


def app_stale(page, op_id, rec):
    page.evaluate(
        "([mid, rec]) => %s.stale(mid, rec)" % ADAPTER, [op_id, rec])


def app_remote(page, rec):
    page.evaluate("(rec) => %s.remote(rec)" % ADAPTER, rec)


def app_failure(page, op_id):
    page.evaluate("(mid) => %s.failure(mid)" % ADAPTER, op_id)


def ui_edit(page, record_id, field, value):
    page.click("[data-testid=select-record-%s]" % record_id)
    if field == "status":
        # The status control is a <select>. If a future seed ever produces a
        # value outside draft/active/complete, inject the option first so the
        # driver stays operable; the app also renders the current value as an
        # option so arbitrary server values remain displayable.
        page.evaluate("""(val) => {
            const sel = document.querySelector('[data-testid="record-status"]');
            if (sel && !Array.from(sel.options).some(o => o.value === val)) {
                const opt = document.createElement('option');
                opt.value = val;
                opt.textContent = val;
                sel.appendChild(opt);
            }
        }""", value)
        page.select_option("[data-testid=record-status]", value)
    else:
        page.fill("[data-testid=record-%s]" % field, value)
    page.click("[data-testid=save-record]")


def ui_resolve(page, record_id, field, which):
    assert which in ("local", "remote")
    page.click("[data-testid=keep-%s-%s-%s]" % (which, record_id, field))


def ev_reload(page, model):
    """Real reload, then re-assert adapter connectivity (it is amnesiac)."""
    page.reload()
    page.wait_for_function(READY_EXPR, timeout=20000)
    app_set_online(page, model["online"])
    ref.set_online(model, model["online"])


def check(page, model, where):
    actual = app_state(page)
    expected = ref.canonical(model)
    assert actual == expected, "%s\napp=%s\nref=%s" % (
        where, json.dumps(actual, sort_keys=True), json.dumps(expected, sort_keys=True))


# ---------- oracle self-checks (guard the grader, not the agent) ----------

def test_oracle_selfcheck_projection_sorts():
    s = ref.initial_model()
    ref.local_edit(s, "r1", {"status": "active", "title": "B"})
    assert ref.canonical(s)["pendingOperations"][0]["fields"] == ["status", "title"]


def test_oracle_selfcheck_duplicate_ack():
    s = ref.initial_model()
    ref.local_edit(s, "r1", {"notes": "50 tonnes"})
    server = {"id": "r1", "title": "Steel shipment", "notes": "50 tonnes",
              "status": "draft", "version": 2}
    ref.ack(s, 1, server)
    before = ref.canonical(s)
    ref.ack(s, 1, server)
    assert ref.canonical(s) == before


def test_oracle_selfcheck_stale_ack_replay():
    s = ref.initial_model()
    ref.local_edit(s, "r1", {"title": "First"})
    ref.local_edit(s, "r1", {"notes": "Second"})
    ref.ack(s, 1, {"id": "r1", "title": "First", "notes": "40 tonnes",
                   "status": "draft", "version": 5})
    assert [o["id"] for o in s["pending"]] == [2]
    assert s["records"]["r1"]["notes"] == "Second"


def test_oracle_selfcheck_reload_recomputes_syncing():
    s = ref.initial_model()
    ref.local_edit(s, "r1", {"notes": "x"})
    assert ref.canonical(ref.restore(ref.snapshot(s)))["syncStatus"] == "syncing"
    ref.set_online(s, False)
    assert ref.canonical(ref.restore(ref.snapshot(s)))["syncStatus"] == "offline"


# ---------- browser behavior tests ----------

def test_dist_loads_and_reports_seed_state(live):
    page, model = live
    check(page, model, "seed state")
    badge = page.text_content("[data-testid=sync-status]")
    assert badge is not None and badge.strip() == "online"


def test_offline_edits_survive_reload_then_sync(live):
    page, model = live
    app_set_online(page, False)
    ref.set_online(model, False)
    ui_edit(page, "r1", "notes", "offline-note-1")
    ref.local_edit(model, "r1", {"notes": "offline-note-1"})
    ui_edit(page, "r2", "title", "offline-title-2")
    ref.local_edit(model, "r2", {"title": "offline-title-2"})
    ui_edit(page, "r3", "status", "active")
    ref.local_edit(model, "r3", {"status": "active"})
    check(page, model, "offline edits")
    ev_reload(page, model)
    check(page, model, "after reload while offline")
    app_set_online(page, True)
    ref.set_online(model, True)
    check(page, model, "after reconnect")
    for op in sorted(model["pending"], key=lambda o: o["id"]):
        rec = ref.server_applying(model, op)
        app_ack(page, op["id"], rec)
        ref.ack(model, op["id"], rec)
        check(page, model, "after ack %d" % op["id"])
    assert model["pending"] == []


def test_duplicate_and_out_of_order_acks(live):
    page, model = live
    ui_edit(page, "r1", "title", "First")
    ref.local_edit(model, "r1", {"title": "First"})
    ui_edit(page, "r1", "notes", "Second")
    ref.local_edit(model, "r1", {"notes": "Second"})
    ui_edit(page, "r2", "title", "Copper+")
    ref.local_edit(model, "r2", {"title": "Copper+"})
    check(page, model, "three pending")
    op2 = next(o for o in model["pending"] if o["id"] == 2)
    rec2 = ref.server_applying(model, op2)
    app_ack(page, 2, rec2)
    ref.ack(model, 2, rec2)
    check(page, model, "after out-of-order ack of op 2")
    app_ack(page, 2, rec2)
    ref.ack(model, 2, rec2)
    check(page, model, "after duplicate ack of op 2")
    for op_id in (3, 1):
        op = next(o for o in model["pending"] if o["id"] == op_id)
        rec = ref.server_applying(model, op)
        app_ack(page, op_id, rec)
        ref.ack(model, op_id, rec)
        check(page, model, "after ack of op %d" % op_id)
    assert model["pending"] == []


def test_stale_conflict_resolved_through_ui(live):
    page, model = live
    ui_edit(page, "r1", "notes", "local-60")
    ref.local_edit(model, "r1", {"notes": "local-60"})
    op = model["pending"][-1]
    rec = ref.server_stale(model, op)
    app_stale(page, op["id"], rec)
    ref.stale_reject(model, op["id"], rec)
    check(page, model, "after stale rejection")
    assert len(model["conflicts"]) == 1
    conflict = ref.canonical(model)["conflicts"][0]
    ui_resolve(page, conflict["recordId"], conflict["field"], "remote")
    ref.resolve_conflict(model, conflict["recordId"], conflict["field"],
                         conflict["remoteValue"])
    check(page, model, "after UI resolution")
    assert model["conflicts"] == []
    assert len(model["pending"]) == 2
    op2 = model["pending"][-1]
    rec2 = ref.server_applying(model, op2)
    app_ack(page, op2["id"], rec2)
    ref.ack(model, op2["id"], rec2)
    check(page, model, "after ack of resolution")
    assert model["conflicts"] == []


def test_failure_then_reconnect_and_reload(live):
    page, model = live
    ui_edit(page, "r1", "notes", "fragile")
    ref.local_edit(model, "r1", {"notes": "fragile"})
    op = model["pending"][-1]
    app_failure(page, op["id"])
    ref.temp_failure(model, op["id"])
    check(page, model, "after temporary failure")
    assert ref.canonical(model)["syncStatus"] == "error"
    ev_reload(page, model)
    check(page, model, "after reload with failure outstanding")
    ui_edit(page, "r1", "title", "recovered-title")
    ref.local_edit(model, "r1", {"title": "recovered-title"})
    check(page, model, "after new edit clears error")
    for op in sorted(model["pending"], key=lambda o: o["id"]):
        rec = ref.server_applying(model, op)
        app_ack(page, op["id"], rec)
        ref.ack(model, op["id"], rec)
        check(page, model, "after ack %d" % op["id"])
    assert model["pending"] == []


def test_seeded_adversarial_sequence(live):
    page, model = live
    rng = random.Random(20240920)
    last_acked = None
    reloads = 0
    for step in range(50):
        event = ref.choose_event(rng, model, step, last_acked)
        kind = event[0]
        if kind == "local":
            _, rid, field, value = event
            ui_edit(page, rid, field, value)
            ref.local_edit(model, rid, {field: value})
        elif kind == "remote":
            app_remote(page, event[1])
            ref.remote_update(model, event[1])
        elif kind == "ack":
            _, op_id, rec = event
            app_ack(page, op_id, rec)
            ref.ack(model, op_id, rec)
            last_acked = (op_id, rec)
        elif kind == "dup":
            _, op_id, rec = event
            app_ack(page, op_id, rec)
            ref.ack(model, op_id, rec)
        elif kind == "stale":
            _, op_id, rec = event
            app_stale(page, op_id, rec)
            ref.stale_reject(model, op_id, rec)
        elif kind == "failure":
            app_failure(page, event[1])
            ref.temp_failure(model, event[1])
        elif kind == "resolve":
            _, rid, field, value = event
            current = ref.canonical(model)["conflicts"]
            match = [c for c in current
                     if c["recordId"] == rid and c["field"] == field]
            assert match, "resolve target vanished at step %d" % step
            want = "local" if match[0]["localValue"] == value else "remote"
            ui_resolve(page, rid, field, want)
            ref.resolve_conflict(model, rid, field, value)
        elif kind == "online":
            app_set_online(page, event[1])
            ref.set_online(model, event[1])
        check(page, model, "seeded step %d (%s)" % (step, kind))
        if reloads < 4 and rng.random() < 0.08:
            reloads += 1
            ev_reload(page, model)
            check(page, model, "seeded reload %d" % reloads)
