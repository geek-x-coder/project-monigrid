"""Timemachine sample store (Phase 3).

Periodically-collected samples — both monitor target snapshots and data API
endpoint cache refreshes — are appended to a local SQLite file as they
happen. The dashboard's "rewind" UI later fetches the closest-in-time sample
per source so the user can step backward through history.

Why a separate store (not the settings DB):

- Settings DB holds organisation policy / catalog / alert events. It is
  small, schema-controlled, and may live on a remote JDBC server. Time
  series volume (every collector tick × every source) would dominate it.

- A node-local SQLite file has zero ops cost: no provisioning, no
  failover, no pool tuning, and the stdlib ``sqlite3`` module ships with
  Python so there's no new dependency.

- Active-Active note: each node writes its own ``.db`` and the rewind
  endpoint reads only the local file. The lossy semantics (you may see
  the snapshot from whichever node served you) are acceptable for a
  visualisation tool — the source-of-truth (settings/alerts) still lives
  in the shared JDBC DB.

Concurrency:

  ``sqlite3`` connections are not thread-safe. We open the connection with
  ``check_same_thread=False`` and serialise every public method on an
  RLock — every collector / cache thread sees the same connection and the
  lock guarantees one writer at a time.

Compression:

  Per-sample ``zlib.compress(json.dumps(payload).encode("utf-8"))``.
  Default level (6) trades ~70-80% of the bytes for sub-millisecond CPU
  on the typical (small dict) payload — zlib is faster than the SQLite
  insert it precedes, so the cost is invisible in collector wall time.
"""
from __future__ import annotations

import json
import logging
import os
import sqlite3
import threading
import time
import zlib
from typing import Any


_DDL = [
    """
    CREATE TABLE IF NOT EXISTS timemachine_samples (
        id           INTEGER PRIMARY KEY AUTOINCREMENT,
        source_type  TEXT NOT NULL,
        source_id    TEXT NOT NULL,
        ts_ms        INTEGER NOT NULL,
        payload      BLOB NOT NULL
    )
    """,
    "CREATE INDEX IF NOT EXISTS idx_tm_source_ts ON timemachine_samples (source_type, source_id, ts_ms)",
    "CREATE INDEX IF NOT EXISTS idx_tm_ts ON timemachine_samples (ts_ms)",
]


# ── Rollup (downsampled tier) ────────────────────────────────────────────────
# Raw samples (30s monitors / 5s data-api) are kept short-term for high-fidelity
# replay; older monitor data is aggregated into fixed 5-minute buckets holding
# numeric metrics only (no JSON payload). A 3-month trend query then reads a few
# thousand pre-computed rows instead of decompressing hundreds of thousands of
# blobs. avg is stored as (sum, cnt) so buckets are mergeable across rollup runs.
_ROLLUP_BUCKET_MS = 5 * 60 * 1000  # 5 minutes

# Trend windows fully within this recent span are served from raw samples
# (native 30s detail, bucketed down if needed); older windows come from the
# rollup tier. Also bounds how much raw is ever decoded for one query.
_RAW_SERVE_WINDOW_MS = 3 * 24 * 3600 * 1000  # 3 days

_ROLLUP_DDL = [
    """
    CREATE TABLE IF NOT EXISTS timemachine_rollup (
        source_type TEXT NOT NULL,
        source_id   TEXT NOT NULL,
        metric      TEXT NOT NULL,
        ts_bucket   INTEGER NOT NULL,   -- floor(ts_ms / bucket) * bucket
        sum_val     REAL NOT NULL,      -- Σ values in bucket (avg = sum / cnt)
        min_val     REAL NOT NULL,
        max_val     REAL NOT NULL,
        cnt         INTEGER NOT NULL,
        PRIMARY KEY (source_type, source_id, metric, ts_bucket)
    )
    """,
    "CREATE INDEX IF NOT EXISTS idx_tmr_src_ts ON timemachine_rollup (source_type, source_id, ts_bucket)",
    """
    CREATE TABLE IF NOT EXISTS timemachine_rollup_meta (
        k TEXT PRIMARY KEY,
        v INTEGER NOT NULL
    )
    """,
]


class TimemachineStore:
    """Append-only time-series of source samples + per-source latest-at lookup."""

    def __init__(
        self,
        *,
        db_path: str,
        logger: logging.Logger,
    ) -> None:
        self._db_path = db_path
        self._logger = logger
        self._conn: sqlite3.Connection | None = None
        self._lock = threading.RLock()

    # ── lifecycle ────────────────────────────────────────────────────────

    def connect(self) -> None:
        """Open the SQLite file (creates parent directory + schema if needed)."""
        with self._lock:
            if self._conn is not None:
                return
            parent = os.path.dirname(os.path.abspath(self._db_path))
            if parent:
                os.makedirs(parent, exist_ok=True)
            # check_same_thread=False so collector / cache threads can call
            # write_sample without each opening their own connection. Lock
            # provides the actual mutual exclusion.
            self._conn = sqlite3.connect(
                self._db_path,
                check_same_thread=False,
                isolation_level=None,  # autocommit; we still BEGIN where useful
            )
            # WAL keeps reads (dashboard rewind queries) from blocking writes
            # (background collectors). Synchronous=NORMAL is the standard
            # WAL pairing; durability tradeoff is acceptable for a
            # visualisation cache that is intentionally lossy on crash.
            try:
                self._conn.execute("PRAGMA journal_mode = WAL")
                self._conn.execute("PRAGMA synchronous = NORMAL")
            except Exception:
                self._logger.exception("timemachine PRAGMA failed — continuing")
            for stmt in _DDL:
                self._conn.execute(stmt)
            for stmt in _ROLLUP_DDL:
                self._conn.execute(stmt)
            self._logger.info("Timemachine store ready path=%s", self._db_path)

    def close(self) -> None:
        with self._lock:
            if self._conn is None:
                return
            try:
                self._conn.close()
            except Exception:
                pass
            self._conn = None

    # ── writes ───────────────────────────────────────────────────────────

    def write_sample(
        self,
        *,
        source_type: str,
        source_id: str,
        payload: Any,
        ts_ms: int | None = None,
    ) -> None:
        """Append one sample. ``payload`` is JSON-serialised then zlib-compressed.

        Failures here MUST NOT propagate up to the collector — the timemachine
        is a best-effort archive. We log and swallow.
        """
        if self._conn is None:
            return
        try:
            ts = int(ts_ms) if ts_ms is not None else int(time.time() * 1000)
            blob = zlib.compress(
                json.dumps(payload, ensure_ascii=False, default=str).encode("utf-8"),
            )
            with self._lock:
                if self._conn is None:
                    return
                self._conn.execute(
                    "INSERT INTO timemachine_samples "
                    "(source_type, source_id, ts_ms, payload) VALUES (?, ?, ?, ?)",
                    (str(source_type), str(source_id), ts, blob),
                )
        except Exception:
            self._logger.exception(
                "timemachine write_sample failed sourceType=%s sourceId=%s",
                source_type, source_id,
            )

    def prune_older_than(self, *, ts_ms: int) -> int:
        """Delete samples older than ``ts_ms``. Returns number of rows removed.

        Run from the retention thread. Idempotent + safe under concurrent writes
        (lock serialises the DELETE just like every other op)."""
        if self._conn is None:
            return 0
        try:
            with self._lock:
                if self._conn is None:
                    return 0
                cur = self._conn.execute(
                    "DELETE FROM timemachine_samples WHERE ts_ms < ?",
                    (int(ts_ms),),
                )
                return int(cur.rowcount or 0)
        except Exception:
            self._logger.exception("timemachine prune_older_than failed")
            return 0

    def vacuum_if_needed(self) -> None:
        """Reclaim deleted-page space. Cheap on small DBs; called occasionally."""
        if self._conn is None:
            return
        try:
            with self._lock:
                if self._conn is None:
                    return
                self._conn.execute("VACUUM")
        except Exception:
            self._logger.exception("timemachine vacuum failed")

    # ── reads ────────────────────────────────────────────────────────────

    def get_sample_at(
        self,
        *,
        source_type: str,
        source_id: str,
        at_ms: int,
    ) -> dict[str, Any] | None:
        """Return the most recent sample at-or-before ``at_ms`` for one source.

        Output shape: ``{tsMs, payload}`` where payload is the decoded dict
        the collector originally saved. Returns ``None`` if no sample exists
        within the available window.
        """
        if self._conn is None:
            return None
        try:
            with self._lock:
                if self._conn is None:
                    return None
                row = self._conn.execute(
                    "SELECT ts_ms, payload FROM timemachine_samples "
                    "WHERE source_type = ? AND source_id = ? AND ts_ms <= ? "
                    "ORDER BY ts_ms DESC LIMIT 1",
                    (str(source_type), str(source_id), int(at_ms)),
                ).fetchone()
        except Exception:
            self._logger.exception(
                "timemachine get_sample_at failed sourceType=%s sourceId=%s",
                source_type, source_id,
            )
            return None
        if row is None:
            return None
        return {"tsMs": int(row[0]), "payload": _decode_payload(row[1])}

    def list_samples_at(self, *, at_ms: int) -> list[dict[str, Any]]:
        """For every (source_type, source_id) that has any sample ≤ at_ms,
        return its most recent sample. Used by the rewind dashboard fetch.

        Implemented with a window-style "latest per group" pattern that
        SQLite supports via correlated subquery — fine for the scale here
        (a few hundred sources × any retention window).
        """
        if self._conn is None:
            return []
        try:
            with self._lock:
                if self._conn is None:
                    return []
                rows = self._conn.execute(
                    "SELECT t.source_type, t.source_id, t.ts_ms, t.payload "
                    "FROM timemachine_samples t "
                    "JOIN ( "
                    "  SELECT source_type, source_id, MAX(ts_ms) AS max_ts "
                    "  FROM timemachine_samples WHERE ts_ms <= ? "
                    "  GROUP BY source_type, source_id "
                    ") m ON m.source_type = t.source_type "
                    "  AND m.source_id = t.source_id AND m.max_ts = t.ts_ms",
                    (int(at_ms),),
                ).fetchall()
        except Exception:
            self._logger.exception("timemachine list_samples_at failed")
            return []
        out: list[dict[str, Any]] = []
        for r in rows:
            out.append({
                "sourceType": str(r[0]),
                "sourceId": str(r[1]),
                "tsMs": int(r[2]),
                "payload": _decode_payload(r[3]),
            })
        return out

    def list_samples_range(
        self, *, source_type: str, source_id: str,
        from_ms: int, to_ms: int, limit: int = 500,
    ) -> list[dict[str, Any]]:
        """Return samples for one source within [from_ms, to_ms] ordered ascending.

        Output shape: ``[{tsMs, payload}, ...]``. Used by the Phase 3 ``/series``
        endpoint to feed detail modals with a 1-hour timeseries.
        """
        if self._conn is None:
            return []
        try:
            with self._lock:
                if self._conn is None:
                    return []
                rows = self._conn.execute(
                    "SELECT ts_ms, payload FROM timemachine_samples "
                    "WHERE source_type = ? AND source_id = ? "
                    "AND ts_ms BETWEEN ? AND ? "
                    "ORDER BY ts_ms ASC LIMIT ?",
                    (source_type, source_id, int(from_ms), int(to_ms), int(limit)),
                ).fetchall()
        except Exception:
            self._logger.exception("timemachine list_samples_range failed")
            return []
        return [{"tsMs": int(r[0]), "payload": _decode_payload(r[1])} for r in rows]

    def stats(self) -> dict[str, Any]:
        """Return basic stats for the Configuration page (row count, span)."""
        if self._conn is None:
            return {"rowCount": 0, "minTsMs": None, "maxTsMs": None}
        try:
            with self._lock:
                if self._conn is None:
                    return {"rowCount": 0, "minTsMs": None, "maxTsMs": None}
                row = self._conn.execute(
                    "SELECT COUNT(*), MIN(ts_ms), MAX(ts_ms) FROM timemachine_samples",
                ).fetchone()
        except Exception:
            self._logger.exception("timemachine stats failed")
            return {"rowCount": 0, "minTsMs": None, "maxTsMs": None}
        if row is None:
            return {"rowCount": 0, "minTsMs": None, "maxTsMs": None}
        return {
            "rowCount": int(row[0] or 0),
            "minTsMs": int(row[1]) if row[1] is not None else None,
            "maxTsMs": int(row[2]) if row[2] is not None else None,
        }

    # ── rollup (downsampled tier) ────────────────────────────────────────

    def _get_meta_locked(self, key: str, default: int) -> int:
        row = self._conn.execute(
            "SELECT v FROM timemachine_rollup_meta WHERE k = ?", (key,),
        ).fetchone()
        return int(row[0]) if row is not None else default

    def _set_meta_locked(self, key: str, value: int) -> None:
        self._conn.execute(
            "INSERT INTO timemachine_rollup_meta (k, v) VALUES (?, ?) "
            "ON CONFLICT(k) DO UPDATE SET v = excluded.v",
            (key, int(value)),
        )

    def run_rollup(
        self, *, extractor=None, batch_size: int = 5000, max_batches: int = 10000,
    ) -> dict[str, int]:
        """Aggregate not-yet-rolled monitor samples into 5-minute buckets.

        Incremental + resumable: advances a rowid watermark so each call only
        processes samples appended since the last run (rowid, not ts_ms, so the
        mergeable upsert can never double-count same-millisecond rows). Runs in
        bounded batches, holding the store lock only for the DB read and upsert
        — not the zlib-decode/aggregate step — so a large first backfill does
        not stall background collectors.

        Only ``monitor:*`` sources are rolled up: ``data_api`` payloads are
        arbitrary JSON with no universal numeric metric.
        """
        if self._conn is None:
            return {"rows": 0, "buckets": 0, "batches": 0}
        extract = extractor or extract_metrics
        total_rows = 0
        total_buckets = 0
        batches = 0
        while batches < max_batches:
            with self._lock:
                if self._conn is None:
                    break
                wm = self._get_meta_locked("rollup_watermark_id", 0)
                rows = self._conn.execute(
                    "SELECT id, source_type, source_id, ts_ms, payload "
                    "FROM timemachine_samples "
                    "WHERE id > ? AND source_type LIKE 'monitor:%' "
                    "ORDER BY id ASC LIMIT ?",
                    (wm, int(batch_size)),
                ).fetchall()
            if not rows:
                break
            # Decode + aggregate OUTSIDE the lock (the expensive part).
            acc: dict[tuple, list] = {}
            max_id = wm
            for row_id, st, sid, ts_ms, blob in rows:
                if row_id > max_id:
                    max_id = row_id
                metrics = extract(st, _decode_payload(blob))
                if not metrics:
                    continue
                bucket = (int(ts_ms) // _ROLLUP_BUCKET_MS) * _ROLLUP_BUCKET_MS
                for metric, value in metrics.items():
                    fv = _num(value)
                    if fv is None:
                        continue
                    key = (st, sid, metric, bucket)
                    a = acc.get(key)
                    if a is None:
                        acc[key] = [fv, fv, fv, 1]
                    else:
                        a[0] += fv
                        if fv < a[1]:
                            a[1] = fv
                        if fv > a[2]:
                            a[2] = fv
                        a[3] += 1
            with self._lock:
                if self._conn is None:
                    break
                self._conn.execute("BEGIN")
                try:
                    for (st, sid, metric, bucket), (s, mn, mx, cnt) in acc.items():
                        self._conn.execute(
                            "INSERT INTO timemachine_rollup "
                            "(source_type, source_id, metric, ts_bucket, sum_val, min_val, max_val, cnt) "
                            "VALUES (?, ?, ?, ?, ?, ?, ?, ?) "
                            "ON CONFLICT(source_type, source_id, metric, ts_bucket) DO UPDATE SET "
                            "sum_val = sum_val + excluded.sum_val, "
                            "min_val = MIN(min_val, excluded.min_val), "
                            "max_val = MAX(max_val, excluded.max_val), "
                            "cnt = cnt + excluded.cnt",
                            (st, sid, metric, bucket, s, mn, mx, cnt),
                        )
                    self._set_meta_locked("rollup_watermark_id", max_id)
                    self._conn.execute("COMMIT")
                except Exception:
                    self._conn.execute("ROLLBACK")
                    raise
            total_rows += len(rows)
            total_buckets += len(acc)
            batches += 1
            if len(rows) < batch_size:
                break
        return {"rows": total_rows, "buckets": total_buckets, "batches": batches}

    def prune_rollup_older_than(self, *, ts_bucket_ms: int) -> int:
        """Delete rollup buckets older than ``ts_bucket_ms``. Returns rows removed."""
        if self._conn is None:
            return 0
        try:
            with self._lock:
                if self._conn is None:
                    return 0
                cur = self._conn.execute(
                    "DELETE FROM timemachine_rollup WHERE ts_bucket < ?",
                    (int(ts_bucket_ms),),
                )
                return int(cur.rowcount or 0)
        except Exception:
            self._logger.exception("timemachine prune_rollup failed")
            return 0

    def query_series_auto(
        self, *, source_type: str, source_id: str, from_ms: int, to_ms: int,
        max_points: int = 1000, raw_window_ms: int | None = None,
        now_ms: int | None = None, metric: str | None = None, extractor=None,
    ) -> dict[str, Any]:
        """Return a numeric trend series for one source, auto-selecting resolution.

        Windows fully within the recent raw-serve span are served from raw
        samples (native detail, bucketed down to ``max_points`` if needed);
        older windows are served from the 5-minute rollup tier grouped to a
        bucket width that keeps the point count under ``max_points``.

        Output: ``{resolution, bucketMs, series: {metric: [{ts, avg, min, max, count}]}}``
        where ``ts`` is the bucket-start epoch-ms.
        """
        now = int(now_ms) if now_ms is not None else int(time.time() * 1000)
        raw_win = int(raw_window_ms) if raw_window_ms is not None else _RAW_SERVE_WINDOW_MS
        raw_win = min(max(0, raw_win), _RAW_SERVE_WINDOW_MS)
        from_ms = int(from_ms)
        to_ms = int(to_ms)
        max_points = max(10, min(int(max_points), 5000))
        if from_ms >= now - raw_win:
            return self._series_from_raw(
                source_type=source_type, source_id=source_id,
                from_ms=from_ms, to_ms=to_ms, max_points=max_points,
                metric=metric, extract=extractor or extract_metrics,
            )
        return self._series_from_rollup(
            source_type=source_type, source_id=source_id,
            from_ms=from_ms, to_ms=to_ms, max_points=max_points, metric=metric,
        )

    def _series_from_raw(
        self, *, source_type, source_id, from_ms, to_ms, max_points, metric, extract,
    ) -> dict[str, Any]:
        raw = self.list_samples_range(
            source_type=source_type, source_id=source_id,
            from_ms=from_ms, to_ms=to_ms, limit=100_000,
        )
        cols: dict[str, list] = {}
        for item in raw:
            ts = int(item["tsMs"])
            for m, v in extract(source_type, item["payload"]).items():
                if metric and m != metric:
                    continue
                fv = _num(v)
                if fv is None:
                    continue
                cols.setdefault(m, []).append((ts, fv))
        densest = max((len(v) for v in cols.values()), default=0)
        if densest <= max_points:
            series = {
                m: [{"ts": ts, "avg": v, "min": v, "max": v, "count": 1} for ts, v in pts]
                for m, pts in cols.items()
            }
            return {"resolution": "raw", "bucketMs": 0, "series": series}
        span = max(1, to_ms - from_ms)
        bucket_ms = max(1000, span // max_points)
        series = {m: _bucketize(pts, bucket_ms) for m, pts in cols.items()}
        return {"resolution": "raw", "bucketMs": bucket_ms, "series": series}

    def _series_from_rollup(
        self, *, source_type, source_id, from_ms, to_ms, max_points, metric,
    ) -> dict[str, Any]:
        span = max(1, to_ms - from_ms)
        target = max(1, span // max_points)
        mult = max(1, -(-target // _ROLLUP_BUCKET_MS))  # ceil-div
        bucket_ms = mult * _ROLLUP_BUCKET_MS
        empty = {"resolution": "rollup", "bucketMs": bucket_ms, "series": {}}
        if self._conn is None:
            return empty
        sql = (
            "SELECT metric, (ts_bucket / ?) * ? AS b, "
            "SUM(sum_val), MIN(min_val), MAX(max_val), SUM(cnt) "
            "FROM timemachine_rollup "
            "WHERE source_type = ? AND source_id = ? AND ts_bucket BETWEEN ? AND ? "
        )
        args = [int(bucket_ms), int(bucket_ms), source_type, source_id,
                int(from_ms), int(to_ms)]
        if metric:
            sql += "AND metric = ? "
            args.append(metric)
        sql += "GROUP BY metric, b ORDER BY metric ASC, b ASC"
        try:
            with self._lock:
                if self._conn is None:
                    return empty
                rows = self._conn.execute(sql, args).fetchall()
        except Exception:
            self._logger.exception("timemachine rollup query failed")
            return empty
        series: dict[str, list] = {}
        for m, b, s, mn, mx, c in rows:
            c = int(c or 0)
            series.setdefault(str(m), []).append({
                "ts": int(b),
                "avg": (s / c) if c else None,
                "min": mn, "max": mx, "count": c,
            })
        return {"resolution": "rollup", "bucketMs": bucket_ms, "series": series}


def _num(value: Any) -> float | None:
    """Coerce to a finite float, or None (rejects None/bool/NaN/inf/non-numeric)."""
    if value is None or isinstance(value, bool):
        return None
    try:
        f = float(value)
    except (TypeError, ValueError):
        return None
    if f != f or f in (float("inf"), float("-inf")):
        return None
    return f


def _nested(d: Any, *keys: str) -> Any:
    cur = d
    for k in keys:
        if not isinstance(cur, dict):
            return None
        cur = cur.get(k)
    return cur


def _bucketize(points: list, bucket_ms: int) -> list:
    """Group (ts, value) points into fixed-width buckets → [{ts,avg,min,max,count}]."""
    acc: dict[int, list] = {}
    for ts, v in points:
        b = (int(ts) // bucket_ms) * bucket_ms
        a = acc.get(b)
        if a is None:
            acc[b] = [v, v, v, 1]
        else:
            a[0] += v
            if v < a[1]:
                a[1] = v
            if v > a[2]:
                a[2] = v
            a[3] += 1
    return [
        {"ts": b, "avg": s / c, "min": mn, "max": mx, "count": c}
        for b, (s, mn, mx, c) in sorted(acc.items())
    ]


def extract_metrics(source_type: str, payload: Any) -> dict[str, float]:
    """Map a monitor sample payload to a flat {metric: numeric} dict.

    Only monitor sources have well-defined numeric metrics; unknown source
    types (e.g. ``data_api``) return {} and are skipped by the rollup.
    """
    if not isinstance(payload, dict):
        return {}
    data = payload.get("data")
    if not isinstance(data, dict):
        return {}
    out: dict[str, float] = {}
    if source_type == "monitor:server_resource":
        cpu = _num(_nested(data, "cpu", "usedPct"))
        if cpu is not None:
            out["cpu"] = cpu
        mem = _num(_nested(data, "memory", "usedPct"))
        if mem is not None:
            out["mem"] = mem
        disks = data.get("disks")
        if isinstance(disks, list):
            for dk in disks:
                if not isinstance(dk, dict):
                    continue
                pct = _num(dk.get("usedPct"))
                if pct is None:
                    continue
                mount = str(dk.get("mount") or "root")
                out[f"disk:{mount}"] = pct
    elif source_type == "monitor:network":
        rt = _num(data.get("responseTimeMs"))
        if rt is not None:
            out["responseTimeMs"] = rt
        if "success" in data:
            out["success"] = 1.0 if data.get("success") else 0.0
    elif source_type == "monitor:http_status":
        rt = _num(data.get("responseTimeMs"))
        if rt is not None:
            out["responseTimeMs"] = rt
        if "ok" in data:
            out["up"] = 1.0 if data.get("ok") else 0.0
    return out


def _decode_payload(blob: Any) -> Any:
    if blob is None:
        return None
    try:
        text = zlib.decompress(blob).decode("utf-8")
    except Exception:
        # Defensive fallback: someone wrote raw JSON bytes by hand
        try:
            text = bytes(blob).decode("utf-8")
        except Exception:
            return None
    try:
        return json.loads(text)
    except json.JSONDecodeError:
        return text
