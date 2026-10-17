#!/usr/bin/env python3
"""ct_wisdom_activity_delivery.py — autonomous-work wisdom delivery (Hermes only).

Spec: docs/superpowers/specs/2026-10-16-hermes-autonomous-work-wisdom-design.md.
Split out of the shared builder (ct_wisdom_activity.py, imported as `builder`):
docs/superpowers/specs/2026-10-17-hermes-activity-delivery-split-design.md.

While the agent works on its own between user messages, what it is doing
(the file it reads or edits, the command it runs, the pattern it searches)
can trigger one relevant CT fact:

  * No `pre_tool_call` hook (amendment 8): Hermes resolves approvals and
    other plugins' blocks only after every pre_tool_call callback has
    returned, and a call it blocks there never reaches the transform.
  * `transform_tool_result` (Hermes let the call run): only when the result
    proves the tool ran (`proves_ran`, per tool; anything else sends
    nothing), build the activity from the tool's ARGS
    that ran (never contents, output, diffs, reasoning or full command
    lines), claim the model step (`api_request_id`) and the activity key in
    one atomic step, start `ct wisdom match --max 1` and wait for it within
    the 3 s budget, claim one fact atomically in the in-turn ledger, and
    splice a marker-first block into the tool result. The query is the bare
    target (A6 real-gate results): a relative path, a search pattern, or
    program plus subcommand.
  * A started query that delivers nothing for any reason but zero_hits
    frees its key for a later step (after a budget miss, only once its
    worker has finished, so one activity never has two queries in flight).
    A budget miss is one breaker failure when discovery and the capability
    probe were already cached (the match had the whole budget); on a cold
    process the worker's own outcome settles the breaker instead.
  * A ct that cannot be used (no Curated Thoughts `ct` found, no `wisdom
    match`, or a `--help` probe that timed out) is remembered for
    CT_UNUSABLE_PAUSE while PATH is unchanged: later steps skip at once
    instead of waiting. A probe timeout is also one breaker failure.

Fail-closed classes (no CT call or no delivery, one debug line):
  empty_id, ct_tool, no_activity, no_ledger, breaker_open, ct_unavailable,
  probing, seen_key, step_used, refused, discovery_miss, probe_timeout,
  capability_missing, timeout, spawn, spawn_failed, exit, parse_error,
  budget, zero_hits, unsupported_result, hook_failed.
  (`refused` means the result did not prove the tool ran.)

Verbose mode (CT_WISDOM_VERBOSE=1, ct_wisdom_verbose) records each delivery
and each query that delivered nothing with channel "activity"; per-call rate
and filter skips are not recorded.

Read-only: `ct` subprocess only (via ct_wisdom_live.match_wisdom). Stdlib
only. The hook never raises.
"""

from __future__ import annotations

import logging
import os
import threading
import time
from collections import OrderedDict

import ct_ledger
import ct_wisdom
import ct_wisdom_activity as builder
import ct_wisdom_live
import ct_wisdom_verbose

logger = logging.getLogger(__name__)

# Delivery-only limits (moved from the builder).
STEP_IDS_MAX = 16
SESSIONS_MAX = 256

# ---------------------------------------------------------------------------
# key tracker and per-step rate rule
# ---------------------------------------------------------------------------


class ActivityState:
    """Per session: recent activity keys (LRU), the model steps that started
    a query and the steps already reported. One lock.

    Amendment 8: everything happens in `transform_tool_result`, after Hermes
    decided the call may run. `start` claims the step and the key together,
    just before the query starts, so a call Hermes blocks earlier never holds
    the step."""

    def __init__(self):
        self._lock = threading.Lock()
        self._sessions = OrderedDict()

    def _state(self, session_id):
        state = self._sessions.get(session_id)
        if state is None:
            state = (OrderedDict(), OrderedDict(), OrderedDict())
            self._sessions[session_id] = state
            while len(self._sessions) > SESSIONS_MAX:
                self._sessions.popitem(last=False)
        self._sessions.move_to_end(session_id)
        return state

    def start(self, session_id, api_request_id, key):
        """None when this call may start the step's query (the step and the
        key are both recorded); else "step_used" or "seen_key". A rejected
        call changes nothing but the key's recency."""
        with self._lock:
            keys, steps, _ = self._state(session_id)
            if api_request_id in steps:
                return "step_used"
            if key in keys:
                keys.move_to_end(key)
                return "seen_key"
            steps[api_request_id] = True
            while len(steps) > STEP_IDS_MAX:
                steps.popitem(last=False)
            keys[key] = True
            while len(keys) > builder.RECENT_KEYS_MAX:
                keys.popitem(last=False)
            return None

    def release(self, session_id, api_request_id, key):
        """Undo start(): free the step and the key (the query never started)."""
        with self._lock:
            state = self._sessions.get(session_id)
            if state is not None:
                state[0].pop(key, None)
                state[1].pop(api_request_id, None)

    def release_key(self, session_id, key):
        """Forget a key whose query never got a genuine answer, so a LATER
        step can retry it (the step stays used)."""
        with self._lock:
            state = self._sessions.get(session_id)
            if state is not None:
                state[0].pop(key, None)

    def peek(self, session_id, api_request_id, key):
        """What start() would answer. Pure: records nothing, not even the
        session's or the key's recency."""
        with self._lock:
            state = self._sessions.get(session_id)
            if state is None:
                return None
            keys, steps, _ = state
            if api_request_id in steps:
                return "step_used"
            return "seen_key" if key in keys else None

    def first_report(self, session_id, api_request_id):
        """True once per step: bounds verbose skip records to one per step."""
        with self._lock:
            _, _, reported = self._state(session_id)
            if api_request_id in reported:
                return False
            reported[api_request_id] = True
            while len(reported) > STEP_IDS_MAX:
                reported.popitem(last=False)
            return True

    def reset(self):
        with self._lock:
            self._sessions.clear()


_STATE = ActivityState()

# ---------------------------------------------------------------------------
# the query (started and joined in transform_tool_result)
# ---------------------------------------------------------------------------

_clock = time.monotonic


def _spawn(target):
    threading.Thread(target=target, name="ct-wisdom-activity", daemon=True).start()


# A ct that cannot be used is remembered this long (while PATH is unchanged),
# so a broken or absent ct costs at most one wait per pause, then goes quiet.
CT_UNUSABLE_PAUSE = ct_wisdom_live.BREAKER_PAUSE
_UNUSABLE_CLASSES = frozenset({"discovery_miss", "probe_timeout", "capability_missing"})
_unusable = {}
_unusable_lock = threading.Lock()


def _ct_unusable():
    """The remembered reason ct cannot be used, or None (expired, or PATH
    changed: a new ct may be reachable)."""
    with _unusable_lock:
        if not _unusable:
            return None
        moved = _unusable["path"] != os.environ.get("PATH")
        if not moved and _clock() < _unusable["until"]:
            return _unusable["reason"]
        _unusable.clear()
    if moved:
        # discover_ct keeps one accepted path per process and the probe
        # caches per path: without a reset the retry would not re-discover.
        ct_wisdom.reset_discovery_cache()
        ct_wisdom_live.reset_capability_cache()
    return None


def _mark_unusable(reason):
    with _unusable_lock:
        _unusable.update(until=_clock() + CT_UNUSABLE_PAUSE,
                         path=os.environ.get("PATH"), reason=reason)


# At most one cold query (discovery plus capability probe) in flight per
# process: a hung ct must not collect parallel probes, one per new activity.
_probe_busy = []
_probe_lock = threading.Lock()


def _take_probe():
    with _probe_lock:
        if _probe_busy:
            return False
        _probe_busy.append(True)
        return True


def _release_probe():
    with _probe_lock:
        _probe_busy.clear()


def _ct_warm():
    """True when discovery and the capability probe are both cached, so the
    whole budget goes to `ct wisdom match` (finding 1: on a cold process the
    3 s wait also covers `ct --help` and `ct wisdom match --help`). Reads the
    two caches only; runs nothing."""
    path = ct_wisdom._accepted_ct_path
    if path is None:
        return False
    with ct_wisdom_live._capability_lock:
        return ct_wisdom_live._capability.get(path) is True


class _Prefetch:
    __slots__ = ("session_id", "api_request_id", "tool_name", "activity", "query",
                 "exclude", "deadline", "warm", "done", "result", "failure", "lock",
                 "settled", "abandoned")

    def __init__(self, session_id, api_request_id, tool_name, activity, exclude, warm):
        self.session_id = session_id
        self.api_request_id = api_request_id
        self.tool_name = tool_name
        self.activity = activity
        self.query = builder.query_for(activity)
        self.exclude = exclude
        self.deadline = _clock() + ct_wisdom_live.LIVE_TIMEOUT
        self.warm = warm
        self.done = threading.Event()
        self.result = None
        self.failure = None
        self.lock = threading.Lock()
        self.settled = False
        self.abandoned = False


def reset_state():
    """TEST-ONLY: forget keys, steps, the root, *.sln, homes and module
    caches and the pwd lookup."""
    _STATE.reset()
    builder.reset_caches()
    with _unusable_lock:
        _unusable.clear()
    _release_probe()


def _record_breaker(outcome):
    if outcome == "failure":
        ct_wisdom_live._BREAKER.record_failure()
    elif outcome == "success":
        ct_wisdom_live._BREAKER.record_success()


def _finish(p, result, failure, outcome):
    """The worker's end, under the query lock: publish the result, mark the
    query done and settle the breaker unless the transform already did. The
    shared breaker hears of each query EXACTLY once."""
    with p.lock:
        p.result, p.failure = result, failure
        p.done.set()
        record = None if p.settled else outcome
        p.settled = True
        abandoned = p.abandoned
    _record_breaker(record)
    if not p.warm:
        _release_probe()
    if failure in _UNUSABLE_CLASSES:
        _mark_unusable(failure)
    if abandoned:
        # The transform gave up on this query and delivered nothing: the key
        # is free again only now, so the activity never has two in flight.
        _STATE.release_key(p.session_id, p.activity.key)


def _run_prefetch(p):
    """Discovery, probe and match for one query (worker thread). Outcome for
    the breaker: a probe timeout (`ct --help` or `ct wisdom match --help`)
    or a match timeout/exit is a failure, an answer a success, anything else
    nothing (a spawn error resets the discovery and capability caches)."""
    result, failure, outcome = None, None, None
    try:
        path, dclass = ct_wisdom.discover_ct()
        if path is None:
            failure = dclass or "discovery_miss"
            outcome = "failure" if failure == "probe_timeout" else None
            return
        started = _clock()
        capable = ct_wisdom_live.has_match_capability(path)
        if capable is None and _clock() - started < ct_wisdom.PROBE_TIMEOUT:
            # None before the timeout can fire is an OSError at spawn (ct
            # moved or uninstalled): spawn-class, as on the match path.
            ct_wisdom.reset_discovery_cache()
            ct_wisdom_live.reset_capability_cache()
            failure = "spawn"
            return
        if not capable:
            failure = "probe_timeout" if capable is None else "capability_missing"
            outcome = "failure" if capable is None else None
            return
        answer, rclass = ct_wisdom_live.match_wisdom(
            path, p.query, builder.ACTIVITY_MAX_PER_STEP, p.exclude)
        if rclass is not None:
            if rclass in ("timeout", "exit"):
                outcome = "failure"
            elif rclass == "spawn":
                ct_wisdom.reset_discovery_cache()
                ct_wisdom_live.reset_capability_cache()
            failure = rclass
            return
        result, outcome = answer, "success"
    except Exception:
        logger.debug("wisdom-activity: prefetch failed", exc_info=True)
        result, failure, outcome = None, "hook_failed", None
    finally:
        _finish(p, result, failure, outcome)


def _wait(p):
    """Wait for the query within what is left of its budget; True when done."""
    return p.done.wait(max(0.0, p.deadline - _clock()))


def _budget_ran_out(p):
    """The transform's wait ran out. Under the query lock: False when the
    worker finished meanwhile (its result is used and it settled the
    breaker). Else True; a warm query then records ONE budget failure (the
    core's recordActivityBudgetMiss) and the worker's later outcome is
    ignored. A cold query (discovery or probe ran in this budget) records
    nothing here: the worker's own outcome settles the breaker later. Either
    way the query is marked abandoned: its worker frees the key when it
    finishes."""
    with p.lock:
        if p.done.is_set():
            return False
        p.abandoned = True
        record = None
        if p.warm and not p.settled:
            p.settled = True
            record = "failure"
    _record_breaker(record)
    return True


def _skip(session_id, failure_class, record=False, **detail):
    """Log one skip. With record=True it is also reported to verbose mode
    (only for decisions about a real would-be query, never for the per-call
    rate and filter checks, which would flood the user's terminal)."""
    logger.debug("wisdom-activity: skip session=%s class=%s",
                 session_id or "<empty>", failure_class)
    if record:
        _record_activity_skip(dict(detail, host="hermes", channel="activity",
                                   session_id=session_id, reason=failure_class))
    return None



def _blocked_report(session_id, api_request_id, activity, blocked):
    """A would-be trigger that cannot run (no_ledger, breaker_open,
    ct_unavailable, probing): verbose mode hears of it once per step, so
    while ct is remembered as unusable it logs one ct_unavailable record per
    new-activity step (the user sees nothing). Nothing is recorded in the
    key tracker."""
    report = (_STATE.peek(session_id, api_request_id, activity.key) is None
              and _STATE.first_report(session_id, api_request_id))
    return _skip(session_id, blocked, record=report, query=builder.query_for(activity),
                 activity=activity.line)


def _gate_blocked(session_id):
    """"no_ledger" | "breaker_open" | None, and the ledger."""
    ledger = ct_ledger.LEDGER_CACHE.get(session_id)
    if ledger is None:
        return "no_ledger", None
    return ("breaker_open" if ct_wisdom_live._BREAKER.is_open() else None), ledger


# ---------------------------------------------------------------------------
# transform_tool_result hook
# ---------------------------------------------------------------------------


def _record_activity_delivery(event):
    """The one seam every activity delivery goes through: verbose mode
    (ct_wisdom_verbose, a no-op unless CT_WISDOM_VERBOSE is on). Never
    changes the delivered bytes; never raises."""
    try:
        ct_wisdom_verbose.record_delivery(event)
    except Exception:  # pragma: no cover - the recorder never raises
        pass


def _record_activity_skip(event):
    """Verbose record of an activity that queried (or would have) but
    delivered nothing."""
    try:
        ct_wisdom_verbose.record_non_delivery(event)
    except Exception:  # pragma: no cover - the recorder never raises
        pass


def on_transform_tool_result(**kwargs):
    """Hermes `transform_tool_result` callback: str replaces the result,
    None keeps it. Never raises."""
    try:
        return _transform(kwargs.get("result"), kwargs.get("session_id"),
                          kwargs.get("tool_call_id"), kwargs.get("tool_name"),
                          kwargs.get("args"), kwargs.get("task_id"),
                          kwargs.get("api_request_id"))
    except Exception:
        logger.debug("wisdom-activity: transform failed", exc_info=True)
        return None


# Proof that a tool ran (INTENT rule 9, spec 2026-10-17-hermes-fail-closed-
# ran-check-design.md): the success shape of each activity tool's result at
# the Hermes pin (tests/e2e/Dockerfile HERMES_COMMIT). Every result needs to
# be a JSON object whose `error` is absent or null; then, per tool:
#   - terminal: `exit_code` an int >= 0 and no `status` (foreground run,
#     non-zero exit included, or background spawn); or `status`
#     "yielded_to_background" with a `session_id` (terminal_tool.py,
#     terminal_tool_result.py, terminal_tool_background.py);
#   - read_file: `content` a str, no `status` (the dedup stub has one), and
#     `is_binary` not true (ReadResult.to_dict);
#   - write_file: `bytes_written` an int >= 0 (WriteResult.to_dict);
#   - patch: `success` is True (PatchResult.to_dict);
#   - search_files: `total_count` an int >= 0 (SearchResult.to_dict).
# Anything else (plain text, unknown fields, another tool) proves nothing,
# so nothing is sent. Fields are checked for presence and type only; no tool
# output is read. Hermes's status kwarg is not used: it says "error" for any
# non-zero exit, a command that ran (agent/display.py).


def _is_count(value):
    """An int >= 0 that is not a bool."""
    return isinstance(value, int) and not isinstance(value, bool) and value >= 0


def proves_ran(tool_name, data):
    """True only when `data` (the parsed tool result) proves the tool ran.
    Fails closed: any shape not listed above is False."""
    if not isinstance(data, dict) or data.get("error") is not None:
        return False
    if tool_name == "terminal":
        if "status" not in data:
            return _is_count(data.get("exit_code"))
        session = data.get("session_id")
        return (data.get("status") == "yielded_to_background"
                and isinstance(session, str) and bool(session))
    if tool_name == "read_file":
        return (isinstance(data.get("content"), str) and "status" not in data
                and data.get("is_binary") is not True)
    if tool_name == "write_file":
        return _is_count(data.get("bytes_written"))
    if tool_name == "patch":
        return data.get("success") is True
    if tool_name == "search_files":
        return _is_count(data.get("total_count"))
    return False


def _transform(result, session_id, tool_call_id, tool_name=None, args=None, task_id=None,
               api_request_id=None):
    if not (builder._nonempty(session_id) and builder._nonempty(tool_call_id) and builder._nonempty(api_request_id)):
        return _skip(session_id, "empty_id")
    if builder.is_ct_tool(tool_name):
        return _skip(session_id, "ct_tool")
    # Cheapest first: most calls of a step pass through here.
    if _STATE.peek(session_id, api_request_id, None) == "step_used":
        return _skip(session_id, "step_used")
    if not builder._is_activity_tool(tool_name):
        return _skip(session_id, "no_activity")
    data = builder._parse(result)
    # Hermes decided by now (approvals, other plugins' blocks, guardrails),
    # but a refusal can be worded any way. Send only when the result proves
    # the tool ran (INTENT rule 9): anything else sends nothing. Nothing is
    # recorded, so the step stays free for a later call of the same step.
    if not proves_ran(tool_name, data):
        return _skip(session_id, "refused")
    mode = builder._splice_mode(result, data)
    if mode is None:
        return _skip(session_id, "unsupported_result")
    # The args that actually ran (after any plugin `modify`).
    activity = builder.activity_for(tool_name, args, task_id=task_id)
    if activity is None or not builder.query_for(activity):
        return _skip(session_id, "no_activity")
    blocked, ledger = _gate_blocked(session_id)
    if blocked is None and _ct_unusable() is not None:
        blocked = "ct_unavailable"
    warm = _ct_warm() if blocked is None else True
    if blocked is None and not warm and not _take_probe():
        blocked = "probing"  # another cold query is discovering / probing
    if blocked is not None:
        return _blocked_report(session_id, api_request_id, activity, blocked)
    refused = _STATE.start(session_id, api_request_id, activity.key)
    if refused is not None:
        if not warm:
            _release_probe()
        return _skip(session_id, refused)
    try:
        p = _Prefetch(session_id, api_request_id, tool_name, activity,
                      sorted(ledger)[:ct_wisdom_live.EXCLUDE_MAX], warm)
        _spawn(lambda: _run_prefetch(p))
    except Exception:
        # No thread, no query: nothing was sent, so free the step, the key
        # and the probe slot.
        logger.debug("wisdom-activity: could not start the query", exc_info=True)
        _STATE.release(session_id, api_request_id, activity.key)
        if not warm:
            _release_probe()
        return _skip(session_id, "spawn_failed")
    try:
        return _deliver(p, result, mode)
    except Exception:
        # The query ran (the step stays used) but nothing was delivered.
        _STATE.release_key(session_id, activity.key)
        raise


def _deliver(p, result, mode=None):
    """Join the started query and deliver one fact, or skip. Any non-delivery
    other than zero_hits releases the key (the step stays used); after a
    budget miss the worker releases it when it finishes."""
    session_id = p.session_id
    base = {"query": p.query, "activity": p.activity.line}

    def miss(failure_class):
        _STATE.release_key(session_id, p.activity.key)
        return _skip(session_id, failure_class, record=True, **base)

    if not _wait(p) and _budget_ran_out(p):
        return _skip(session_id, "budget", record=True, **base)
    if p.failure is not None:
        return miss(p.failure)
    ledger = ct_ledger.LEDGER_CACHE.get(session_id)
    if ledger is None:
        return miss("no_ledger")
    for item, superseded in builder.render_candidates(
            p.result["entries"], p.result["corrections"], ledger):
        block = builder.render_activity_block(item, superseded, p.activity)
        if not block:
            continue
        out = builder.splice(result, block, mode)
        if out is None:
            return miss("unsupported_result")
        claimed = ct_ledger.LEDGER_CACHE.claim(session_id, [item["id"]])
        if claimed is None:
            return miss("no_ledger")
        if not claimed:
            continue  # another tool thread delivered it first
        logger.debug("wisdom-activity: deliver session=%s ids=%s", session_id, item["id"])
        _record_activity_delivery({
            "host": "hermes", "channel": "activity", "session_id": session_id,
            "query": p.query, "activity": p.activity.line, "result": p.result,
            "ledger": sorted(ledger), "delivered": [item["id"]], "block": block,
            "tool_name": p.tool_name, "api_request_id": p.api_request_id,
        })
        return out
    # Nothing new survived (CT answered): the key stays seen. Report against
    # the ledger as it is now, including anything a concurrent tool thread
    # just claimed.
    after = ct_ledger.LEDGER_CACHE.get(session_id) or ledger
    return _skip(session_id, "zero_hits", record=True, result=p.result,
                 ledger=sorted(after), **base)
