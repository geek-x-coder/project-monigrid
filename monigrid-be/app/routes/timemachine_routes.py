"""Timemachine endpoints (Phase 3).

Read-only access to the local SQLite archive of collector / cache samples,
plus admin-managed retention hours.

Routes:

    GET  /dashboard/timemachine?at=ISO[&sourceType=...&sourceId=...]
        - Without sourceType/sourceId: the most recent sample at-or-before
          ``at`` for every source (one row per source). Used by the rewind
          dashboard to repaint every widget at one timestamp.
        - With sourceType + sourceId: that single source's sample only.
        Response: { items: [{sourceType, sourceId, tsMs, payload}], atMs }

    GET  /dashboard/timemachine/stats
        Basic store stats (row count, time span). Used by the FE settings
        tab to show "X 시간치 보존 중" hint.

    GET  /dashboard/timemachine/retention
        - Returns the current retention_hours value (KV, default 72).

    PUT  /dashboard/timemachine/retention
        - Admin: body {retentionHours: float}. 0 disables eviction.
"""
from __future__ import annotations

from datetime import datetime, timezone

from flask import jsonify, request

from app.auth import require_admin, require_auth


_DEFAULT_RETENTION_HOURS = 72.0


def _parse_at_ms(raw: str | None) -> int | None:
    """Accept ISO-8601 or epoch-millis. Return epoch-ms or None on parse failure."""
    if raw is None or raw == "":
        return None
    s = str(raw).strip()
    # Numeric → assume already epoch ms (or seconds — clamp to ms).
    if s.lstrip("-").isdigit():
        n = int(s)
        # Heuristic: 10-digit values are seconds, everything else ms.
        return n * 1000 if abs(n) < 10_000_000_000 else n
    try:
        # Allow trailing 'Z' (Python <3.11 fromisoformat only since 3.11)
        if s.endswith("Z"):
            s = s[:-1] + "+00:00"
        dt = datetime.fromisoformat(s)
        if dt.tzinfo is None:
            dt = dt.replace(tzinfo=timezone.utc)
        return int(dt.timestamp() * 1000)
    except ValueError:
        return None


def register(app, backend, limiter) -> None:
    @app.route("/dashboard/timemachine", methods=["GET"])
    @require_auth
    def timemachine_query():
        store = backend.get_timemachine_store()
        if store is None:
            return jsonify({"message": "timemachine disabled"}), 503

        at_raw = request.args.get("at")
        at_ms = _parse_at_ms(at_raw)
        if at_ms is None:
            return jsonify({"message": "query param 'at' (ISO-8601 or epoch ms) is required"}), 400

        source_type = (request.args.get("sourceType") or "").strip() or None
        source_id = (request.args.get("sourceId") or "").strip() or None

        try:
            if source_type and source_id:
                row = store.get_sample_at(
                    source_type=source_type, source_id=source_id, at_ms=at_ms,
                )
                items = [
                    {
                        "sourceType": source_type,
                        "sourceId": source_id,
                        "tsMs": row["tsMs"],
                        "payload": row["payload"],
                    }
                ] if row is not None else []
            else:
                items = store.list_samples_at(at_ms=at_ms)
        except Exception:
            backend.logger.exception("timemachine query failed at=%s", at_raw)
            return jsonify({"message": "timemachine query failed"}), 500

        return jsonify({"items": items, "atMs": at_ms, "count": len(items)}), 200

    @app.route("/dashboard/timemachine/stats", methods=["GET"])
    @require_auth
    def timemachine_stats():
        store = backend.get_timemachine_store()
        if store is None:
            return jsonify({"enabled": False}), 200
        try:
            data = store.stats()
        except Exception:
            backend.logger.exception("timemachine stats failed")
            return jsonify({"message": "stats failed"}), 500
        data["enabled"] = True
        return jsonify(data), 200

    @app.route("/dashboard/timemachine/retention", methods=["GET"])
    @require_auth
    def timemachine_get_retention():
        try:
            kv = backend.settings_store.load_scalar_sections() or {}
            raw = kv.get("timemachine_retention_hours")
            hours = float(raw) if raw not in (None, "") else _DEFAULT_RETENTION_HOURS
        except Exception:
            backend.logger.exception("timemachine retention read failed")
            hours = _DEFAULT_RETENTION_HOURS
        return jsonify({"retentionHours": hours}), 200

    @app.route("/dashboard/timemachine/window", methods=["GET"])
    @require_auth
    def timemachine_window():
        store = backend.get_timemachine_store()
        if store is None:
            return jsonify({"message": "timemachine disabled"}), 503

        from_ms = _parse_at_ms(request.args.get("from"))
        to_ms = _parse_at_ms(request.args.get("to"))
        if from_ms is None or to_ms is None:
            return jsonify({"message": "from/to (ISO-8601 or epoch ms) required"}), 400
        if from_ms > to_ms:
            return jsonify({"message": "from must be <= to"}), 400

        try:
            step_ms = int(request.args.get("stepMs", "30000"))
        except (TypeError, ValueError):
            return jsonify({"message": "stepMs must be int (ms)"}), 400
        if step_ms < 1000:
            return jsonify({"message": "stepMs must be >= 1000"}), 400

        frame_count = (to_ms - from_ms) // step_ms + 1
        if frame_count > 200:
            return jsonify({
                "message": f"too many frames ({frame_count}); reduce window or increase stepMs (max 200 per call)",
            }), 400

        items = []
        cursor = from_ms
        try:
            while cursor <= to_ms:
                snapshot = store.list_samples_at(at_ms=cursor)
                items.append({"atMs": cursor, "snapshot": snapshot})
                cursor += step_ms
        except Exception:
            backend.logger.exception("timemachine window failed from=%s to=%s step=%s",
                                     from_ms, to_ms, step_ms)
            return jsonify({"message": "window query failed"}), 500

        return jsonify({"items": items, "count": len(items)}), 200

    @app.route("/dashboard/timemachine/series", methods=["GET"])
    @require_auth
    def timemachine_series():
        store = backend.get_timemachine_store()
        if store is None:
            return jsonify({"message": "timemachine disabled"}), 503

        source_type = (request.args.get("sourceType") or "").strip()
        source_id = (request.args.get("sourceId") or "").strip()
        if not source_type or not source_id:
            return jsonify({"message": "sourceType, sourceId required"}), 400

        from_ms = _parse_at_ms(request.args.get("from"))
        to_ms = _parse_at_ms(request.args.get("to"))
        if from_ms is None or to_ms is None:
            return jsonify({"message": "from/to required"}), 400

        try:
            limit = int(request.args.get("limit", "500"))
        except (TypeError, ValueError):
            return jsonify({"message": "limit must be int"}), 400
        limit = max(1, min(limit, 2000))

        try:
            items = store.list_samples_range(
                source_type=source_type, source_id=source_id,
                from_ms=from_ms, to_ms=to_ms, limit=limit,
            )
        except Exception:
            backend.logger.exception("timemachine series failed")
            return jsonify({"message": "series query failed"}), 500

        return jsonify({
            "items": items, "count": len(items),
            "sourceType": source_type, "sourceId": source_id,
        }), 200

    @app.route("/dashboard/timemachine/series/agg", methods=["GET"])
    @require_auth
    def timemachine_series_agg():
        """Numeric trend series for one source, auto-selecting raw vs rollup
        resolution. Feeds the zoomable multi-range detail graph.

        Params: sourceType, sourceId, from, to (ISO/epoch-ms), maxPoints
        (default 1000), metric (optional filter).
        Response: { resolution, bucketMs, series: {metric: [{ts,avg,min,max,count}]} }
        """
        store = backend.get_timemachine_store()
        if store is None:
            return jsonify({"message": "timemachine disabled"}), 503

        source_type = (request.args.get("sourceType") or "").strip()
        source_id = (request.args.get("sourceId") or "").strip()
        if not source_type or not source_id:
            return jsonify({"message": "sourceType, sourceId required"}), 400

        from_ms = _parse_at_ms(request.args.get("from"))
        to_ms = _parse_at_ms(request.args.get("to"))
        if from_ms is None or to_ms is None:
            return jsonify({"message": "from/to required"}), 400
        if from_ms > to_ms:
            return jsonify({"message": "from must be <= to"}), 400

        try:
            max_points = int(request.args.get("maxPoints", "1000"))
        except (TypeError, ValueError):
            return jsonify({"message": "maxPoints must be int"}), 400

        metric = (request.args.get("metric") or "").strip() or None

        # Raw-serve window = the configured raw retention (bounds raw decode).
        # 0/disabled → None, so the store falls back to its 3-day serve cap.
        try:
            kv = backend.settings_store.load_scalar_sections() or {}
            raw_hours = kv.get("timemachine_retention_hours")
            hours = float(raw_hours) if raw_hours not in (None, "") else _DEFAULT_RETENTION_HOURS
        except Exception:
            hours = _DEFAULT_RETENTION_HOURS
        raw_window_ms = int(hours * 3600 * 1000) if hours > 0 else None

        try:
            result = store.query_series_auto(
                source_type=source_type, source_id=source_id,
                from_ms=from_ms, to_ms=to_ms, max_points=max_points,
                raw_window_ms=raw_window_ms, metric=metric,
            )
        except Exception:
            backend.logger.exception("timemachine series/agg failed")
            return jsonify({"message": "series/agg query failed"}), 500

        return jsonify({
            "sourceType": source_type, "sourceId": source_id,
            "fromMs": from_ms, "toMs": to_ms,
            "resolution": result.get("resolution"),
            "bucketMs": result.get("bucketMs"),
            "series": result.get("series", {}),
        }), 200

    @app.route("/dashboard/timemachine/retention", methods=["PUT"])
    @require_auth
    @require_admin
    def timemachine_put_retention():
        body = request.get_json(silent=True) or {}
        raw = body.get("retentionHours")
        if raw is None:
            return jsonify({"message": "body.retentionHours is required"}), 400
        try:
            hours = float(raw)
        except (TypeError, ValueError):
            return jsonify({"message": "retentionHours must be a number"}), 400
        if hours < 0:
            return jsonify({"message": "retentionHours must be >= 0"}), 400
        try:
            backend.settings_store.set_kv_scalar("timemachine_retention_hours", hours)
        except Exception:
            backend.logger.exception("timemachine retention write failed")
            return jsonify({"message": "retention save failed"}), 500
        backend.logger.info("Timemachine retention updated hours=%.2f", hours)
        return jsonify({"retentionHours": hours}), 200
