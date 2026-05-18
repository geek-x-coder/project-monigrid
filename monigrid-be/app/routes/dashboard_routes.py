"""Dashboard endpoints: endpoint listing, cache, sql-editor, db-health, config."""
from __future__ import annotations

from flask import jsonify, request

from app.auth import caller_is_admin, current_username, require_admin, require_auth, verify_jwt_token
from app.exceptions import SqlFileNotFoundError
from app.utils import get_client_ip


def register(app, backend, limiter) -> None:
    rl = backend.config.rate_limits

    @app.route("/dashboard/endpoints", methods=["GET"])
    @require_auth
    def dashboard_endpoints():
        return jsonify(backend.list_endpoints()), 200

    @app.route("/dashboard/sql-editor/endpoints", methods=["GET"])
    @require_auth
    @require_admin
    def dashboard_sql_editor_endpoints():
        return jsonify(backend.list_sql_editable_endpoints()), 200

    @app.route("/dashboard/cache/status", methods=["GET"])
    @require_auth
    def dashboard_cache_status():
        """Return per-endpoint cache health: refresh time, duration, row count, errors."""
        snapshot = backend.snapshot_cache_entries()
        endpoints_by_path = getattr(backend.config, "endpoints_by_path", {}) or {}

        entries = []
        for api_id, entry in snapshot.items():
            conn = backend.config.connections.get(entry.connection_id)
            # FE 위젯이 폴링 주기 floor 를 계산할 때 사용. endpoint 정의가 없으면
            # (legacy 캐시 잔존 등) None 으로 두면 FE 는 전역 minimum 만 적용한다.
            ep_def = endpoints_by_path.get(entry.path)
            entries.append({
                "apiId":                entry.api_id,
                "path":                 entry.path,
                "connectionId":         entry.connection_id,
                "dbType":               conn.db_type if conn else "unknown",
                "hasData":              entry.data is not None,
                "rowCount":             len(entry.data) if isinstance(entry.data, list) else (1 if entry.data is not None else 0),
                "updatedAt":            entry.updated_at,
                "lastRefreshStartedAt": entry.last_refresh_started_at,
                "lastDurationSec":      entry.last_duration_sec,
                "errorMessage":         entry.error_message,
                "errorDetail":          entry.error_detail,
                "isTimeout":            entry.is_timeout,
                "source":               entry.source,
                "refreshIntervalSec":   ep_def.refresh_interval_sec if ep_def else None,
            })

        healthy = sum(1 for e in entries if e["hasData"])
        return jsonify({
            "endpoints":    entries,
            "totalCount":   len(entries),
            "healthyCount": healthy,
        }), 200

    @app.route("/dashboard/sql-editor/validation-rules", methods=["GET"])
    @require_auth
    @require_admin
    def dashboard_sql_editor_validation_rules():
        return jsonify(backend.get_sql_validation_rules()), 200

    @app.route("/dashboard/sql-editor/<api_id>", methods=["GET"])
    @require_auth
    @require_admin
    def dashboard_sql_editor_get(api_id: str):
        try:
            payload = backend.get_sql_for_api(api_id)
        except KeyError:
            return jsonify({"message": "enabled api not found"}), 404
        except SqlFileNotFoundError as error:
            return jsonify({"message": str(error), "detail": error.sql_path}), 404
        return jsonify(payload), 200

    @app.route("/dashboard/sql-editor/files", methods=["GET"])
    @require_auth
    @require_admin
    def dashboard_sql_editor_list_files():
        return jsonify({"files": backend.list_sql_files()}), 200

    @app.route("/dashboard/sql-editor/files", methods=["POST"])
    @require_auth
    @require_admin
    def dashboard_sql_editor_create_file():
        """Create (or overwrite) a standalone SQL entry in the settings DB.

        JSON body:
          sqlId     — required, [A-Za-z0-9_-]{1,64}
          sql       — required, SELECT-only SQL body
          overwrite — optional bool (default true)
        """
        body = request.get_json(silent=True) or {}
        sql_id = str(body.get("sqlId") or "").strip()
        sql_text = body.get("sql")
        overwrite = bool(body.get("overwrite", True))

        client_ip = get_client_ip()
        auth_header = request.headers.get("Authorization", "")
        token = auth_header[7:] if auth_header.startswith("Bearer ") else ""
        token_payload = verify_jwt_token(token) or {}
        actor = str(token_payload.get("username", "unknown"))

        try:
            result = backend.create_sql_file(
                sql_id, str(sql_text or ""), actor, client_ip, overwrite=overwrite,
            )
        except ValueError as error:
            return jsonify({"message": str(error)}), 400
        except FileExistsError as error:
            return jsonify({
                "message": "sql file already exists",
                "detail": str(error),
            }), 409
        return jsonify(result), 201 if result.get("created") else 200

    @app.route("/dashboard/sql-editor/<api_id>", methods=["PUT"])
    @require_auth
    @require_admin
    def dashboard_sql_editor_update(api_id: str):
        request_json = request.get_json(silent=True) or {}
        sql = request_json.get("sql")
        client_ip = get_client_ip()
        auth_header = request.headers.get("Authorization", "")
        token = auth_header[7:] if auth_header.startswith("Bearer ") else ""
        token_payload = verify_jwt_token(token) or {}
        actor = str(token_payload.get("username", "unknown"))

        try:
            result = backend.update_sql_for_api(api_id, str(sql or ""), actor, client_ip)
        except KeyError:
            return jsonify({"message": "enabled api not found"}), 404
        except SqlFileNotFoundError as error:
            return jsonify({"message": str(error), "detail": error.sql_path}), 404
        except ValueError as error:
            return jsonify({"message": str(error)}), 400
        return jsonify(result), 200

    @app.route("/dashboard/db-health/connections", methods=["GET"])
    @require_auth
    def db_health_connections():
        """Return the list of configured DB connections (id, dbType, jdbcUrl)."""
        return jsonify({"connections": backend.list_db_connections()}), 200

    @app.route("/dashboard/db-health/status", methods=["GET"])
    @require_auth
    def db_health_status():
        """Execute a diagnostic query for the given connection and category.

        Query params:
          connection_id  — required
          category       — required: slow_queries | tablespace | locks
          timeout_sec    — optional (default 10, max 60)
        """
        connection_id = (request.args.get("connection_id") or "").strip()
        category = (request.args.get("category") or "").strip()
        if not connection_id:
            return jsonify({"message": "connection_id is required"}), 400
        if category not in ("slow_queries", "tablespace", "locks"):
            return jsonify({"message": "category must be one of: slow_queries, tablespace, locks"}), 400
        try:
            timeout_sec = float(request.args.get("timeout_sec", "10"))
            timeout_sec = max(1.0, min(60.0, timeout_sec))
        except (TypeError, ValueError):
            timeout_sec = 10.0

        result = backend.get_db_health_data(connection_id, category, timeout_sec)
        return jsonify(result), 200

    # Split into two handlers (one per HTTP method) so the route reads
    # top-to-bottom instead of branching on request.method. Tests can target
    # either path independently and stack traces point to the actual operation.
    @app.route("/dashboard/config", methods=["GET"])
    @require_auth
    @require_admin
    def get_config():
        """Return the config stored in the settings DB (same shape as the
        legacy config.json so the frontend is unchanged)."""
        try:
            return jsonify(backend.settings_store.load_config_dict()), 200
        except Exception:
            backend.logger.exception("Config read from settings DB failed")
            return jsonify({"message": "failed to read config", "detail": "internal error"}), 500

    @app.route("/dashboard/config", methods=["PUT"])
    @require_auth
    @require_admin
    def update_config():
        """Persist the config back into the settings DB and apply partial reload.

        Phase 5B: replaced nuclear backend.reload() with apply_partial_config_reload
        — only changed connections/APIs/globals are mutated. Response now includes
        applied/skipped/errors arrays for partial-reload diagnostics.
        """
        client_ip = get_client_ip()
        username = current_username()
        config_data = request.get_json(silent=True)
        if not config_data or not isinstance(config_data, dict):
            return jsonify({"message": "invalid config JSON"}), 400

        try:
            partial_result = backend.apply_partial_config_reload(
                config_data, actor=username,
            )
        except Exception:
            backend.logger.exception(
                "Partial config reload failed clientIp=%s actor=%s",
                client_ip, username,
            )
            return jsonify({
                "message": "config save+reload failed",
                "detail": "internal error",
                "saved": False,
                "reloaded": False,
            }), 500

        backend.logger.info(
            "Config updated and partially reloaded successfully clientIp=%s applied=%d errors=%d",
            client_ip, len(partial_result["applied"]), len(partial_result["errors"]),
        )
        enabled_apis = [ep for ep in backend.config.apis.values() if ep.enabled]
        body = {
            "message": "config updated and reloaded",
            "saved": True,
            "reloaded": True,
            "endpointCount": len(enabled_apis),
            "connectionCount": len(backend.config.connections),
            "applied": partial_result["applied"],
            "skipped": partial_result["skipped"],
            "errors": partial_result["errors"],
        }
        status_code = 207 if partial_result["errors"] else 200
        return jsonify(body), status_code

    @app.route("/dashboard/connections/test", methods=["POST"])
    @require_auth
    @require_admin
    def test_connection():
        """One-shot DB connection test for the ConfigEditorPage's connection
        rows. Body: {jdbc_driver_class, jdbc_url, username, password}.

        Uses the union of currently-loaded JARs from all configured
        connections — that's enough classpath to load any known driver
        regardless of which connection the user is editing. Opens a real
        JDBC connection, closes it immediately, and returns a structured
        result. Failure cases (driver not found, auth error, network) all
        come back as 200 with success=false so the FE can display the
        message inline without treating it as an HTTP error.
        """
        import jaydebeapi

        from app.db import ensure_jvm_started

        body = request.get_json(silent=True) or {}
        driver_class = str(body.get("jdbc_driver_class") or "").strip()
        jdbc_url = str(body.get("jdbc_url") or "").strip()
        if not driver_class or not jdbc_url:
            return jsonify({
                "success": False,
                "message": "jdbc_driver_class / jdbc_url 은 필수입니다.",
            }), 400

        username = str(body.get("username") or "")
        password = str(body.get("password") or "")
        driver_args = [username, password] if (username or password) else []

        # 현재 로딩된 모든 connection 의 JAR union — 어떤 driver class 를
        # 테스트하든 classpath 에 들어 있을 가능성을 최대화. dict.fromkeys 로
        # 순서 보존 + dedupe. 추가로 알려진 jar 들의 부모 디렉토리(drivers/)
        # 의 *.jar 까지 포함해 미등록 db_type 도 테스트 가능하게.
        # 주의: JVM 은 이미 시작되어 classpath 변경 불가하지만, jaydebeapi 의
        # jars 인자는 startup 시점의 classpath 와 일치해야 ClassLoader 가
        # 해당 driver 를 찾을 수 있다 (service.py 의 startup 도 동일 스캔).
        import glob as _glob
        import os as _os
        all_jars = list(dict.fromkeys(
            jar
            for cc in backend.config.connections.values()
            for jar in cc.jdbc_jars
        ))
        candidate_dirs = {_os.path.dirname(j) for j in all_jars if j}
        for d in candidate_dirs:
            for jar_path in _glob.glob(_os.path.join(d, "*.jar")):
                if jar_path not in all_jars:
                    all_jars.append(jar_path)

        client_ip = get_client_ip()
        try:
            ensure_jvm_started()
            conn = jaydebeapi.connect(
                driver_class, jdbc_url, driver_args, all_jars,
            )
        except Exception as exc:
            # Driver/JAR/credential/network 등 모든 실패는 message 로 흘려준다.
            # 운영자가 입력값을 고치는 데 쓰일 수 있도록 원본 메시지 그대로
            # (단, 길이 제한). DB 비밀번호가 응답에 포함되는 일은 없다.
            backend.logger.info(
                "Connection test failed driverClass=%s jdbcUrl=%s clientIp=%s error=%s",
                driver_class, jdbc_url, client_ip, exc,
            )
            return jsonify({
                "success": False,
                "message": str(exc)[:1000],
            }), 200

        try:
            conn.close()
        except Exception:
            # close 실패는 success 판정에 영향 주지 않음 — 어차피 connect 는 성공.
            pass

        backend.logger.info(
            "Connection test ok driverClass=%s jdbcUrl=%s clientIp=%s",
            driver_class, jdbc_url, client_ip,
        )
        return jsonify({
            "success": True,
            "message": "연결 성공",
        }), 200

    @app.route("/dashboard/reload-config", methods=["POST"])
    @require_auth
    @require_admin
    @limiter.limit(rl.reload_config)
    def reload_config():
        client_ip = get_client_ip()
        try:
            backend.reload()
        except Exception:
            backend.logger.exception("Config reload failed clientIp=%s", client_ip)
            return jsonify({"message": "config reload failed", "detail": "internal error"}), 500
        backend.logger.info("Config reload success clientIp=%s", client_ip)
        return jsonify({"message": "config reloaded", "endpointCount": len(backend.config.apis)}), 200

    @app.route("/dashboard/cache/refresh", methods=["POST"])
    @require_auth
    @limiter.limit(rl.cache_refresh)
    def refresh_cached_endpoint():
        request_json = request.get_json(silent=True) or {}
        api_id = request_json.get("api_id")
        endpoint_value = request_json.get("endpoint")
        reset_connection = bool(request_json.get("reset_connection", False))
        client_ip = get_client_ip()

        # Privileged operations: only admins may flush every cache or force a
        # JDBC reconnect. Regular users are still allowed to refresh a single
        # endpoint's cache so that the per-widget "manual refresh" works.
        is_admin = caller_is_admin()

        endpoint = backend.resolve_endpoint_reference(
            api_id=str(api_id).strip() if api_id else None,
            endpoint_value=str(endpoint_value).strip() if endpoint_value else None,
        )

        if endpoint is None and (api_id or endpoint_value):
            return jsonify({"message": "enabled api not found"}), 404

        if endpoint is None:
            if not is_admin:
                backend.logger.warning(
                    "Refresh-all cache rejected reason=non_admin clientIp=%s", client_ip,
                )
                return jsonify({"message": "Admin privileges are required"}), 403
            entries = backend.refresh_all_endpoint_caches(
                source="manual-refresh-all", client_ip=client_ip, reset_connection=reset_connection,
            )
            return jsonify({
                "message": "cache refresh completed",
                "refreshedCount": len(entries),
                "results": [
                    {"apiId": e.api_id, "path": e.path, "ok": e.data is not None,
                     "message": e.error_message, "detail": e.error_detail}
                    for e in entries
                ],
            }), 200

        # Non-admin users may refresh a single endpoint's cache, but they are
        # not allowed to force a JDBC reconnect — that affects every caller
        # sharing the connection pool.
        effective_reset = reset_connection and is_admin
        if reset_connection and not is_admin:
            backend.logger.warning(
                "reset_connection ignored reason=non_admin apiId=%s clientIp=%s",
                endpoint.api_id, client_ip,
            )
        entry = backend.refresh_endpoint_cache(
            endpoint, source="manual-refresh", client_ip=client_ip, reset_connection=effective_reset,
        )
        return jsonify({
            "message": "cache refresh completed",
            "apiId": entry.api_id,
            "path": entry.path,
            "ok": entry.data is not None,
            "errorMessage": entry.error_message,
            "errorDetail": entry.error_detail,
            "updatedAt": entry.updated_at,
            "durationSec": entry.last_duration_sec,
        }), 200
