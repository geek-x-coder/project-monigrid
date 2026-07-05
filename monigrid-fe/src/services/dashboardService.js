/**
 * Dashboard service (ISP + SRP): split into focused method groups.
 * Each method group handles one concern: endpoints, data, health, SQL, logs, cache.
 */
import apiClient, { getRememberedApiBaseUrl } from "./http.js";

// BE의 backend.reload()는 현재 동기 처리라 모니터 타깃이 많으면 10~30s 소요된다.
// reload 를 유발하는 호출(config 저장, 모니터 타깃 CRUD)은 별도 타임아웃을 적용해
// 기본 10s 초과 오류가 사용자에게 노출되지 않도록 한다.
// (BE reload 비동기화는 Phase 5 과제 — 그 전까지 FE 타임아웃으로 회피)
const RELOAD_TIMEOUT_MS = 60_000;

// ── Endpoint catalog ──────────────────────────────────────────────────────────

export const endpointService = {
    getApiEndpoints: async () => {
        const response = await apiClient.get("/dashboard/endpoints");
        return response.data;
    },

    getSqlEditableEndpoints: async () => {
        const response = await apiClient.get("/dashboard/sql-editor/endpoints");
        return response.data;
    },
};

// ── Data fetching ─────────────────────────────────────────────────────────────

export const dataService = {
    /**
     * @param {string|null} _apiId  (호환성을 위해 유지, 사용 안 함)
     * @param {string} endpoint     호출할 경로/URL
     * @param {{fresh?: boolean, signal?: AbortSignal}} [options]
     *        fresh=true 면 백엔드 캐시를 우회 (?fresh=1).
     *        signal 은 AbortController.signal — 위젯 제거 시 in-flight 응답을 끊는다.
     */
    getApiData: async (_apiId, endpoint, options = {}) => {
        const url = options?.fresh
            ? `${endpoint}${endpoint.includes("?") ? "&" : "?"}fresh=1`
            : endpoint;
        const response = await apiClient.get(url, { signal: options?.signal });
        return response.data;
    },

    getMultipleApiData: async (endpoints) => {
        const promises = endpoints.map(({ id, url }) =>
            apiClient
                .get(url)
                .then((res) => ({ id, data: res.data, status: "success" }))
                .catch((error) => ({
                    id,
                    data: null,
                    status: "error",
                    error: error.response?.data?.message || error.message,
                })),
        );
        return Promise.all(promises);
    },
};

// ── Health checks ─────────────────────────────────────────────────────────────

const isCrossOrigin = (url) => {
    try {
        const target = new URL(url, window.location.origin);
        return target.origin !== window.location.origin;
    } catch {
        return false;
    }
};

/**
 * 우리 백엔드(API base)와 동일 origin인지 판정.
 *
 * 헬스체크 프록시(`/dashboard/health-check-proxy*`)는 백엔드가 서버사이드에서
 * 외부 호출을 흉내내는 구조라 Authorization 헤더를 첨부하지 않는다. 따라서
 * 타깃이 인증이 필요한 우리 백엔드 자기 자신을 가리키면 매 폴링마다
 * `Auth rejected reason=missing_token` 경고가 찍힌다.
 *
 * 이를 막기 위해 타깃이 우리 API base와 같은 origin이면 프록시를 우회하고
 * `apiClient`로 직접 호출하여 요청 인터셉터가 Bearer 토큰을 붙이도록 한다.
 */
const isOurBackendUrl = (url) => {
    try {
        const target = new URL(url, window.location.origin);
        const base = new URL(getRememberedApiBaseUrl());
        return target.origin === base.origin;
    } catch {
        return false;
    }
};

const needsProxy = (url) =>
    isCrossOrigin(url) && !isOurBackendUrl(url);

export const healthService = {
    checkEndpointHealth: async (endpoint, { signal } = {}) => {
        // In web mode, use the backend proxy for cross-origin URLs to avoid CORS
        if (needsProxy(endpoint)) {
            const startedAt = Date.now();
            try {
                const response = await apiClient.post(
                    "/dashboard/health-check-proxy",
                    { url: endpoint, timeout: 10 },
                    { signal },
                );
                return {
                    httpStatus: response.data.httpStatus,
                    ok: response.data.ok === true,
                    responseTimeMs: response.data.responseTimeMs ?? (Date.now() - startedAt),
                    checkedAt: new Date().toISOString(),
                    body: response.data.body,
                };
            } catch (error) {
                return {
                    httpStatus: null,
                    ok: false,
                    responseTimeMs: Date.now() - startedAt,
                    checkedAt: new Date().toISOString(),
                    body: null,
                    error: error?.message || "Proxy request failed",
                };
            }
        }

        const startedAt = Date.now();
        const response = await apiClient.get(endpoint, { validateStatus: () => true, signal });
        return {
            httpStatus: response.status,
            ok: response.status === 200,
            responseTimeMs: Date.now() - startedAt,
            checkedAt: new Date().toISOString(),
            body: response.data,
        };
    },

    checkMultipleEndpointsHealth: async (endpoints) => {
        const endpointList = endpoints || [];

        // Separate items with missing URLs
        const emptyItems = [];
        const proxyItems = [];
        const directItems = [];

        endpointList.forEach((item, index) => {
            const label = String(item?.label || item?.title || item?.url || `API ${index + 1}`).trim();
            const url = String(item?.url || "").trim();
            const id = String(item?.id || url || `missing-${index}`);

            if (!url) {
                emptyItems.push({
                    id, label, url, ok: false, httpStatus: null,
                    responseTimeMs: null, checkedAt: new Date().toISOString(),
                    error: "URL이 비어 있습니다.",
                });
            } else if (needsProxy(url)) {
                proxyItems.push({ id, label, url, timeout: 10 });
            } else {
                directItems.push({ id, label, url });
            }
        });

        // Batch proxy request for cross-origin URLs
        let proxyResults = [];
        if (proxyItems.length > 0) {
            try {
                const res = await apiClient.post("/dashboard/health-check-proxy-batch", {
                    urls: proxyItems.map((p) => ({ id: p.id, url: p.url, timeout: p.timeout })),
                });
                const batchResults = res.data?.results || [];
                proxyResults = proxyItems.map((p, i) => {
                    const r = batchResults[i] || {};
                    return {
                        id: p.id, label: p.label, url: p.url,
                        ok: r.ok === true,
                        httpStatus: r.httpStatus ?? null,
                        responseTimeMs: r.responseTimeMs ?? null,
                        checkedAt: new Date().toISOString(),
                        body: r.body ?? null,
                        error: r.ok ? null : (r.error || `HTTP ${r.httpStatus}`),
                    };
                });
            } catch (error) {
                proxyResults = proxyItems.map((p) => ({
                    id: p.id, label: p.label, url: p.url,
                    ok: false, httpStatus: null, responseTimeMs: null,
                    checkedAt: new Date().toISOString(), body: null,
                    error: error?.response?.data?.message || error?.message || "요청 실패",
                }));
            }
        }

        // Direct requests for same-origin URLs
        const directResults = await Promise.all(
            directItems.map(async (item) => {
                try {
                    const result = await healthService.checkEndpointHealth(item.url);
                    return {
                        id: item.id, label: item.label, url: item.url,
                        ...result,
                        error: result.ok ? null : `HTTP ${result.httpStatus}`,
                    };
                } catch (error) {
                    return {
                        id: item.id, label: item.label, url: item.url,
                        ok: false, httpStatus: null, responseTimeMs: null,
                        checkedAt: new Date().toISOString(), body: null,
                        error: error?.response?.data?.detail || error?.response?.data?.message || error?.message || "요청 실패",
                    };
                }
            }),
        );

        // Merge results back in original order
        const resultMap = {};
        [...emptyItems, ...proxyResults, ...directResults].forEach((r) => { resultMap[r.id] = r; });
        const items = endpointList.map((item, index) => {
            const id = String(item?.id || item?.url || `missing-${index}`);
            return resultMap[id] || {
                id, label: String(item?.label || item?.title || item?.url || `API ${index + 1}`).trim(),
                url: String(item?.url || "").trim(),
                ok: false, httpStatus: null, responseTimeMs: null,
                checkedAt: new Date().toISOString(), error: "Unknown",
            };
        });

        const okCount = items.filter((item) => item.ok).length;
        return {
            items,
            okCount,
            failCount: items.length - okCount,
            checkedAt: new Date().toISOString(),
        };
    },
};

// ── SQL editor ────────────────────────────────────────────────────────────────

export const sqlEditorService = {
    getApiSqlScript: async (apiId) => {
        const response = await apiClient.get(`/dashboard/sql-editor/${apiId}`);
        return response.data;
    },

    getSqlValidationRules: async () => {
        const response = await apiClient.get("/dashboard/sql-editor/validation-rules");
        return response.data;
    },

    updateApiSqlScript: async (apiId, sql) => {
        const response = await apiClient.put(`/dashboard/sql-editor/${apiId}`, { sql });
        return response.data;
    },

    listSqlFiles: async () => {
        const response = await apiClient.get("/dashboard/sql-editor/files");
        return response.data;
    },

    createSqlFile: async (sqlId, sql, { overwrite = true } = {}) => {
        const response = await apiClient.post("/dashboard/sql-editor/files", {
            sqlId, sql, overwrite,
        });
        return response.data;
    },
};

// ── Alerts (BE-side transition log) ──────────────────────────────────────────
//
// "logService" was the original aggregate name when this module also exposed
// the now-removed /logs file viewer. Phase 1 dropped that endpoint; the
// remaining surface is the alert history query. The export name is preserved
// to keep `import { logService } from ...` callers working without churn.

export const logService = {
    /**
     * Fetch BE-side alert transition events.
     *
     * Phase 1 backend response shape:
     *   { items: [...], totalCount, limit, offset }
     * where each item has:
     *   { id, sourceType, sourceId, metric, severity, level, label,
     *     message, payload, createdAt }
     *
     * @param {Object} [params]
     * @param {string} [params.from]        ISO-8601 lower bound (createdAt)
     * @param {string} [params.to]          ISO-8601 upper bound (createdAt)
     * @param {string} [params.sourceType]  "server_resource" | "network" | "http_status"
     * @param {string} [params.sourceId]    monitor target id (exact match)
     * @param {string} [params.severity]    "raise" | "clear"
     * @param {string} [params.keyword]     substring match against label OR message
     * @param {number} [params.limit]       1..1000 (default 200)
     * @param {number} [params.offset]      non-negative int (default 0)
     */
    getAlerts: async (params = {}) => {
        const usp = new URLSearchParams();
        if (params.from) usp.set("from", params.from);
        if (params.to) usp.set("to", params.to);
        if (params.sourceType) usp.set("sourceType", params.sourceType);
        if (params.sourceId) usp.set("sourceId", params.sourceId);
        if (params.severity) usp.set("severity", params.severity);
        if (params.keyword) usp.set("keyword", params.keyword);
        if (params.limit != null) usp.set("limit", String(params.limit));
        if (params.offset != null) usp.set("offset", String(params.offset));
        const qs = usp.toString();
        const response = await apiClient.get(
            `/dashboard/alerts${qs ? `?${qs}` : ""}`,
        );
        return response.data;
    },
};

// ── Cache management ──────────────────────────────────────────────────────────

export const cacheService = {
    refreshEndpointCache: async ({
        apiId = null,
        endpoint = null,
        resetConnection = false,
    } = {}) => {
        const response = await apiClient.post("/dashboard/cache/refresh", {
            api_id: apiId,
            endpoint,
            reset_connection: resetConnection,
        });
        return response.data;
    },

    /** Per-endpoint cache health + BE refresh_interval_sec (non-admin readable). */
    getStatus: async () => {
        const response = await apiClient.get("/dashboard/cache/status");
        return response.data;
    },
};

// ── Widget configs (BE-central display columns + thresholds) ─────────────────
//
// Phase 2: per (apiId, widgetType) shared definition. Personal layout state
// (size, column order, column width) stays in user_preferences.

export const widgetConfigService = {
    /** Return every (apiId, widgetType, config, updatedAt) row. */
    list: async () => {
        const response = await apiClient.get("/dashboard/widget-configs");
        return response.data;
    },
    /** Return a single widget config or null if 404. */
    get: async (apiId, widgetType) => {
        try {
            const response = await apiClient.get(
                `/dashboard/widget-configs/${encodeURIComponent(apiId)}/${encodeURIComponent(widgetType)}`,
            );
            return response.data;
        } catch (err) {
            if (err?.response?.status === 404) return null;
            throw err;
        }
    },
    /** Admin: upsert. body: {displayColumns, thresholds, ...}. */
    save: async (apiId, widgetType, config) => {
        const response = await apiClient.put(
            `/dashboard/widget-configs/${encodeURIComponent(apiId)}/${encodeURIComponent(widgetType)}`,
            { config },
        );
        return response.data;
    },
    /** Admin: delete. */
    remove: async (apiId, widgetType) => {
        await apiClient.delete(
            `/dashboard/widget-configs/${encodeURIComponent(apiId)}/${encodeURIComponent(widgetType)}`,
        );
    },
};

// ── Active alerts polling (Phase 2) ──────────────────────────────────────────

export const alertService = {
    /** Snapshot of currently-raised (un-cleared) alarms across all sources. */
    listActive: async ({ signal } = {}) => {
        const response = await apiClient.get("/dashboard/alerts/active", { signal });
        return response.data;
    },
};

// ── Timemachine (Phase 3) ────────────────────────────────────────────────────
//
// 시점 조회 API + retention KV. 모든 메서드는 인증된 사용자가 호출 가능하지만
// retention 변경은 admin 전용.

export const timemachineService = {
    /**
     * Fetch the closest-in-time samples for one or every source.
     * @param {Object} params
     * @param {string|number} params.at - ISO-8601 string OR epoch ms
     * @param {string} [params.sourceType] - "monitor:server_resource" / "data_api" 등
     * @param {string} [params.sourceId]
     */
    queryAt: async ({ at, sourceType, sourceId, signal } = {}) => {
        const usp = new URLSearchParams();
        if (at != null) usp.set("at", String(at));
        if (sourceType) usp.set("sourceType", sourceType);
        if (sourceId) usp.set("sourceId", sourceId);
        const response = await apiClient.get(
            `/dashboard/timemachine?${usp.toString()}`,
            { signal },
        );
        return response.data;
    },
    /**
     * Fetch multiple snapshots in one call (Phase 2 playback prefetch).
     * @param {Object} params
     * @param {number} params.from - epoch ms (start of window)
     * @param {number} params.to - epoch ms (end of window)
     * @param {number} [params.stepMs=30000] - frame interval in ms
     * @param {Object} [options]
     * @param {AbortSignal} [options.signal]
     */
    queryWindow: async ({ from, to, stepMs = 30000 }, options = {}) => {
        const response = await apiClient.get("/dashboard/timemachine/window", {
            params: { from, to, stepMs },
            signal: options.signal,
        });
        return response.data;
    },
    /**
     * Fetch a single source's samples in a time range (Phase 3 detail modal).
     * @param {Object} params
     * @param {string} params.sourceType  e.g. "monitor:server_resource"
     * @param {string} params.sourceId
     * @param {number} params.from        epoch ms
     * @param {number} params.to          epoch ms
     * @param {number} [params.limit=500]
     * @param {Object} [options]
     * @param {AbortSignal} [options.signal]
     */
    queryRange: async ({ sourceType, sourceId, from, to, limit = 500 }, options = {}) => {
        const response = await apiClient.get("/dashboard/timemachine/series", {
            params: { sourceType, sourceId, from, to, limit },
            signal: options.signal,
        });
        return response.data;
    },
    /**
     * Aggregated numeric trend series for one source, auto-resolution (raw for
     * recent windows, 5-min rollup for older). Feeds the zoomable detail graph.
     * @returns { resolution, bucketMs, series: {metric: [{ts,avg,min,max,count}]} }
     */
    queryRangeAgg: async (
        { sourceType, sourceId, from, to, maxPoints = 1000, metric } = {},
        options = {},
    ) => {
        const params = { sourceType, sourceId, from, to, maxPoints };
        if (metric) params.metric = metric;
        const response = await apiClient.get("/dashboard/timemachine/series/agg", {
            params,
            signal: options.signal,
        });
        return response.data;
    },
    /** Store stats (row count, time span, enabled flag). */
    stats: async () => {
        const response = await apiClient.get("/dashboard/timemachine/stats");
        return response.data;
    },
    /** Read current retention hours (>= 0). */
    getRetention: async () => {
        const response = await apiClient.get("/dashboard/timemachine/retention");
        return response.data;
    },
    /** Admin: write retention hours (0 disables eviction). */
    setRetention: async (retentionHours) => {
        const response = await apiClient.put("/dashboard/timemachine/retention", {
            retentionHours,
        });
        return response.data;
    },
};

// ── Backend config management (admin only) ───────────────────────────────────

export const configService = {
    getConfig: async () => {
        const response = await apiClient.get("/dashboard/config");
        return response.data;
    },

    updateConfig: async (configData) => {
        const response = await apiClient.put("/dashboard/config", configData, { timeout: RELOAD_TIMEOUT_MS });
        return response.data;
    },

    reloadConfig: async () => {
        const response = await apiClient.post("/dashboard/reload-config");
        return response.data;
    },
    /** Admin: one-shot DB connection test. Body: {jdbc_driver_class, jdbc_url,
     *  username, password}. Returns {success, message}. */
    testConnection: async (body) => {
        const response = await apiClient.post(
            "/dashboard/connections/test",
            body,
        );
        return response.data;
    },
};

// ── Monitor targets & snapshots (BE-centralized collection) ──────────────────

export const monitorService = {
    listTargets: async () => {
        const response = await apiClient.get("/dashboard/monitor-targets");
        return response.data;
    },

    createTarget: async (body) => {
        const response = await apiClient.post("/dashboard/monitor-targets", body, { timeout: RELOAD_TIMEOUT_MS });
        return response.data;
    },

    updateTarget: async (id, body) => {
        const response = await apiClient.put(
            `/dashboard/monitor-targets/${encodeURIComponent(id)}`,
            body,
            { timeout: RELOAD_TIMEOUT_MS },
        );
        return response.data;
    },

    deleteTarget: async (id) => {
        const response = await apiClient.delete(
            `/dashboard/monitor-targets/${encodeURIComponent(id)}`,
            { timeout: RELOAD_TIMEOUT_MS },
        );
        return response.data;
    },

    /**
     * Fetch latest collected snapshots for given target ids.
     * @param {string[]} [ids]  optional; omit to fetch all
     * @param {{signal?: AbortSignal}} [options]
     */
    getSnapshot: async (ids, { signal } = {}) => {
        const query = Array.isArray(ids) && ids.length > 0
            ? `?ids=${encodeURIComponent(ids.join(","))}`
            : "";
        const response = await apiClient.get(`/dashboard/monitor-snapshot${query}`, { signal });
        return response.data;
    },

    refreshTarget: async (id) => {
        const response = await apiClient.post(
            `/dashboard/monitor-snapshot/${encodeURIComponent(id)}/refresh`,
        );
        return response.data;
    },

    async applyTargetsBatch(creates, updates, deletes) {
        const response = await apiClient.post(
            "/dashboard/monitor-targets/batch",
            { creates, updates, deletes },
            { timeout: RELOAD_TIMEOUT_MS },  // BE reload 시간 고려 — 이슈 #2 의 RELOAD_TIMEOUT_MS 패턴 따라감
        );
        invalidateMonitorTargetsCache();  // Phase 3 Task 3.7 cache 와 호환
        return response.data;
    },
};

// ── Monitor target list — 30s promise cache ───────────────────────────────────
// 여러 위젯 settings 모달이 30초 안에 차례로 열릴 때 중복 GET 을 제거한다.
// · 동시 호출 안전: in-flight 중인 promise 를 그대로 반환 → race 없음
// · 오류 시 즉시 invalidate → 다음 호출이 fresh fetch
// · CRUD 후 invalidateMonitorTargetsCache() 를 호출해 stale 방지

let _mtCachedPromise = null;
let _mtCacheExpiry = 0;

/**
 * monitorService.listTargets 에 30s TTL promise 캐시를 씌운 래퍼.
 * MonitorTargetPicker 와 DashboardPage 등에서 이 함수를 사용한다.
 */
export function listMonitorTargetsCached() {
    const now = Date.now();
    if (_mtCachedPromise && now < _mtCacheExpiry) return _mtCachedPromise;
    _mtCachedPromise = monitorService.listTargets();
    _mtCacheExpiry = now + 30_000;
    _mtCachedPromise.catch(() => {
        _mtCachedPromise = null;
        _mtCacheExpiry = 0;
    });
    return _mtCachedPromise;
}

/** monitor target CRUD 직후 호출해 캐시를 무효화한다. */
export function invalidateMonitorTargetsCache() {
    _mtCachedPromise = null;
    _mtCacheExpiry = 0;
}

// ── Admin user management (admin only) ────────────────────────────────────

export const adminUserService = {
    list: async () => {
        const response = await apiClient.get("/admin/users");
        return response.data?.users || [];
    },

    create: async ({ username, password, role = "user", displayName = null, enabled = true }) => {
        const response = await apiClient.post("/admin/users", {
            username,
            password,
            role,
            display_name: displayName,
            enabled,
        });
        return response.data?.user;
    },

    update: async (username, patch) => {
        const body = {};
        if (patch.password !== undefined) body.password = patch.password;
        if (patch.role !== undefined) body.role = patch.role;
        if (patch.displayName !== undefined) body.display_name = patch.displayName;
        if (patch.enabled !== undefined) body.enabled = patch.enabled;
        const response = await apiClient.put(
            `/admin/users/${encodeURIComponent(username)}`,
            body,
        );
        return response.data?.user;
    },

    remove: async (username) => {
        const response = await apiClient.delete(
            `/admin/users/${encodeURIComponent(username)}`,
        );
        return response.data;
    },
};

// ── User preferences (per-user widgets / layouts / thresholds) ──────────────

export const preferencesService = {
    get: async () => {
        const response = await apiClient.get("/dashboard/me/preferences");
        return response.data?.preferences || {};
    },

    save: async (preferences) => {
        const response = await apiClient.put("/dashboard/me/preferences", { preferences });
        return response.data?.preferences || preferences;
    },
};

// ── Backward-compatible aggregate export (preserves existing imports) ─────────

const dashboardService = {
    ...endpointService,
    ...dataService,
    ...healthService,
    ...sqlEditorService,
    ...logService,
    refreshEndpointCache: cacheService.refreshEndpointCache,
    ...configService,
};

export default dashboardService;
