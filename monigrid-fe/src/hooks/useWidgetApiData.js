/**
 * useWidgetApiData (SRP): manages per-widget polling with de-duplication and
 * auto-rescheduling. Supports table, health-check, and status-list widget types.
 */
import { useState, useEffect, useRef, useCallback, useMemo } from "react";
import {
    dataService,
    healthService,
    monitorService,
} from "../services/dashboardService.js";
import { formatErrorMessage } from "../services/http.js";
import { getEnabledCriteriaColumns } from "../utils/helpers.js";
import { useDocumentVisible } from "./useDocumentVisible.js";
import { snapshotKeyForWidget } from "../utils/snapshotKey";
import { useTimemachine } from "../contexts/TimemachineContext";

// Convert monitor-snapshot rows (BE-collected) into the shape StatusListCard
// already understands ({items, okCount, failCount}). Mirrors the wire format
// produced by the legacy `/health-check-proxy-batch` route so the card itself
// doesn't need to learn about monitor targets.
const transformMonitorSnapshotToStatusList = (snapshotResponse) => {
    const rawItems = Array.isArray(snapshotResponse?.items)
        ? snapshotResponse.items
        : [];
    const items = rawItems.map((entry) => {
        const probe = entry?.data || {};
        const ok = probe?.ok === true;
        const url = entry?.spec?.url || "";
        const error =
            entry?.errorMessage ||
            probe?.error ||
            (ok
                ? null
                : probe?.httpStatus
                  ? `HTTP ${probe.httpStatus}`
                  : "수집 결과 없음");
        return {
            id: entry?.targetId || url,
            label: entry?.label || url || entry?.targetId,
            url,
            ok,
            httpStatus: probe?.httpStatus ?? null,
            responseTimeMs: probe?.responseTimeMs ?? null,
            checkedAt: entry?.updatedAt || null,
            body: probe?.body ?? null,
            error,
        };
    });
    const okCount = items.filter((i) => i.ok).length;
    return {
        items,
        okCount,
        failCount: items.length - okCount,
        checkedAt: new Date().toISOString(),
    };
};

// TM(타임머신) 모드에서 status-list 위젯의 스냅샷을 합성한다.
// status-list 는 여러 http_status 모니터 타깃을 하나의 목록으로 묶으므로 단일
// snapshot key 로 풀 수 없다 (snapshotKey.js 가 null 반환). 대신 각 targetId 의
// `monitor:http_status|<targetId>` 스냅샷을 모아, 라이브 경로(monitorService
// .getSnapshot → transformMonitorSnapshotToStatusList)와 동일한 형태로 변환한다.
// ServerResourceCard / NetworkTestCard 가 카드 레벨에서 하는 다중 타깃 조립을,
// status-list 는 라이브 데이터도 이 훅을 타므로 훅 레벨에서 수행한다.
const buildStatusListTmData = (targetIds, snapshotByKey) => {
    const tids = Array.isArray(targetIds) ? targetIds.filter(Boolean) : [];
    let hasAny = false;
    let latestTsMs = null;
    const entries = tids.map((tid) => {
        const snap = snapshotByKey.get(`monitor:http_status|${tid}`);
        if (snap) {
            hasAny = true;
            if (snap.tsMs != null && (latestTsMs == null || snap.tsMs > latestTsMs)) {
                latestTsMs = snap.tsMs;
            }
        }
        // BE _tm_archive_monitor payload: { label, data, errorMessage, spec, ... }
        const p = snap?.payload || {};
        return {
            targetId: tid,
            label: p.label,
            spec: p.spec,
            data: p.data ?? null,
            errorMessage: snap ? (p.errorMessage ?? null) : "이 시점에 데이터 없음",
            updatedAt: snap?.tsMs != null ? new Date(snap.tsMs).toISOString() : null,
        };
    });
    const data = transformMonitorSnapshotToStatusList({ items: entries });
    // TM 모드에서는 카드의 "마지막 갱신 시각"이 현재 시각이 아니라 스냅샷 시점을
    // 가리키도록 checkedAt 를 최신 스냅샷 ts 로 덮어쓴다.
    if (latestTsMs != null) data.checkedAt = new Date(latestTsMs).toISOString();
    return { hasAny, latestTsMs, data };
};

const clampIntervalSec = (value) => {
    const n = Number(value);
    return Number.isFinite(n) ? Math.min(3600, Math.max(1, Math.floor(n))) : 5;
};

const resolveWidgetType = (widget) => {
    if (widget?.type === "health-check") return "health-check";
    if (widget?.type === "status-list") return "status-list";
    return "table";
};

/**
 * criteria 기반 알람이 활성화된 테이블 위젯인지 판정.
 * 활성화된 경우 백엔드 캐시를 우회(?fresh=1)해 실시간 상태로 알람을 평가해야 한다.
 */
const widgetNeedsFreshData = (widget) => {
    if (resolveWidgetType(widget) !== "table") return false;
    const criteria = widget?.tableSettings?.criteria;
    if (!criteria) return false;
    return getEnabledCriteriaColumns(criteria).length > 0;
};

// Stable string hash (mulberry-ish, FNV-1a in spirit). Used to compute a
// deterministic per-widget phase shift so 30 widgets sharing a 5s interval
// don't all fire on the same tick — that "thundering herd" filled the
// browser's per-host connection budget (6) and queued the tail behind it,
// stretching tail latency past the next interval and tripping in-flight
// guards. Deterministic (vs Math.random) keeps phases stable across reloads.
const stringHash = (s) => {
    let h = 0;
    for (let i = 0; i < s.length; i++) {
        h = ((h << 5) - h + s.charCodeAt(i)) | 0;
    }
    return Math.abs(h);
};

// Spread starts across 30% of the interval (capped at 1.5s so the user's
// first paint isn't visibly delayed for long-interval widgets).
const computeStartDelayMs = (widgetId, intervalSec) => {
    const windowMs = Math.min(1500, Math.floor(intervalSec * 300));
    if (windowMs <= 0) return 0;
    return stringHash(String(widgetId || "")) % windowMs;
};

const scheduleKeyFor = (widget) => {
    const intervalSec = clampIntervalSec(widget.refreshIntervalSec ?? 5);
    // status-list now keys on the registered http_status target id list — the
    // widget pulls a BE-collected snapshot, so re-key whenever the operator
    // adds/removes a target from this widget.
    const target =
        resolveWidgetType(widget) === "status-list"
            ? JSON.stringify(
                  Array.isArray(widget.targetIds) ? widget.targetIds : [],
              )
            : widget.endpoint;
    // fresh 모드 토글도 키에 포함 — 알람 criteria가 켜지거나 꺼지면 즉시 재스케줄
    const freshFlag = widgetNeedsFreshData(widget) ? "fresh" : "cached";
    return `${target}::${intervalSec}::${freshFlag}`;
};

// Compute the next polling delay for a widget based on its consecutive failure count.
// On success (fails=0) → baseIntervalSec.
// On Nth failure → min(baseIntervalSec * 2^min(N,5), 5 min).
// Caps at 5 minutes so BE recovery is detected within a reasonable window.
const nextPollDelay = (fails, baseIntervalSec) => {
    if (fails === 0) return baseIntervalSec * 1000;
    return Math.min(baseIntervalSec * 1000 * (2 ** Math.min(fails, 5)), 5 * 60 * 1000);
};

const useWidgetApiData = (widgets) => {
    // Timemachine context — always called (hooks must not be conditional).
    const tm = useTimemachine();

    const [results, setResults] = useState({});
    const [loadingMap, setLoadingMap] = useState({});
    const [refreshingMap, setRefreshingMap] = useState({});

    // Page Visibility API — pause polling while the tab is hidden and
    // immediately refetch all widgets when the user returns. This eliminates
    // the ~360 req/min BE load generated by 30 widgets × 5 s interval while
    // the dashboard is in a background tab.
    const visible = useDocumentVisible();

    const timersRef = useRef({});
    const scheduleKeyRef = useRef({});
    const inFlightRef = useRef({});
    // Per-widget AbortController so that widget removal / hook unmount
    // doesn't leave dead requests downloading the body and parsing JSON
    // (which still happens after epoch guards drop the result).
    const controllersRef = useRef({});
    const widgetsRef = useRef(widgets);
    const resultsRef = useRef(results);
    // Per-widget consecutive failure count for exponential backoff.
    // Only network/server errors increment this; successful responses reset it.
    // Abort-cancelled requests do NOT count as failures (they are intentional).
    // Map is stored in a ref so updates don't cause re-renders.
    const failureCountRef = useRef(new Map());

    useEffect(() => { widgetsRef.current = widgets; }, [widgets]);
    useEffect(() => { resultsRef.current = results; }, [results]);

    const fetchWidget = useCallback(async (widget) => {
        const widgetId = widget.id;
        const widgetType = resolveWidgetType(widget);
        const hasTarget =
            widgetType === "status-list"
                ? Array.isArray(widget.targetIds) && widget.targetIds.length > 0
                : Boolean(widget.endpoint);

        if (!widgetId || !hasTarget) return;

        if (inFlightRef.current[widgetId]) {
            return inFlightRef.current[widgetId];
        }

        const controller = new AbortController();
        controllersRef.current[widgetId] = controller;
        const signal = controller.signal;

        const intervalSec = clampIntervalSec(widget.refreshIntervalSec ?? 5);
        const requestStartedAt = Date.now();
        const hasPreviousData = resultsRef.current[widgetId]?.data != null;

        if (hasPreviousData) {
            setRefreshingMap((prev) => ({ ...prev, [widgetId]: true }));
        } else {
            setLoadingMap((prev) => ({ ...prev, [widgetId]: true }));
        }

        const fetchPromise = (() => {
            if (widgetType === "health-check") {
                return healthService.checkEndpointHealth(widget.endpoint, { signal });
            }
            if (widgetType === "status-list") {
                // Hit the BE-shared monitor-snapshot cache instead of the
                // per-request proxy fan-out. Multiple users staring at the
                // same dashboard now share one collector per target.
                return monitorService
                    .getSnapshot(widget.targetIds, { signal })
                    .then(transformMonitorSnapshotToStatusList);
            }
            return dataService.getApiData(widgetId, widget.endpoint, {
                fresh: widgetNeedsFreshData(widget),
                signal,
            });
        })()
            .then((data) => {
                // Successful response — reset consecutive failure count so the
                // next poll fires at the normal base interval.
                failureCountRef.current.set(widgetId, 0);

                if (widgetType === "health-check") {
                    const isLive = data?.ok === true;
                    setResults((prev) => ({
                        ...prev,
                        [widgetId]: {
                            id: widgetId,
                            data,
                            status: isLive ? "live" : "dead",
                            error: isLive ? null : `HTTP ${data?.httpStatus ?? "unknown"}`,
                            lastUpdatedAt: Date.now(),
                        },
                    }));
                    return;
                }

                if (widgetType === "status-list") {
                    const failCount = Number(data?.failCount || 0);
                    const okCount = Number(data?.okCount || 0);
                    const status = failCount === 0 ? "live" : okCount > 0 ? "slow-live" : "dead";
                    setResults((prev) => ({
                        ...prev,
                        [widgetId]: {
                            id: widgetId,
                            data,
                            status,
                            error: null,
                            lastUpdatedAt: Date.now(),
                        },
                    }));
                    return;
                }

                const elapsed = Date.now() - requestStartedAt;
                setResults((prev) => ({
                    ...prev,
                    [widgetId]: {
                        id: widgetId,
                        data,
                        status: elapsed > intervalSec * 1000 ? "slow-live" : "live",
                        error: null,
                        lastUpdatedAt: Date.now(),
                    },
                }));
            })
            .catch((error) => {
                // AbortController-driven cancellations: keep the previous
                // result and just clear the in-flight slot. Surfacing
                // "Request aborted" as a widget error would flash the
                // alarm UI on every widget removal.
                // Intentional aborts do NOT count as failures — they are caused
                // by widget removal or tab navigation, not BE health degradation.
                if (signal.aborted || error?.name === "CanceledError" || error?.code === "ERR_CANCELED") {
                    return;
                }
                // Network / server error — increment failure count to trigger
                // exponential backoff on the next scheduled poll.
                const prevFails = failureCountRef.current.get(widgetId) || 0;
                failureCountRef.current.set(widgetId, prevFails + 1);

                setResults((prev) => ({
                    ...prev,
                    [widgetId]: {
                        id: widgetId,
                        data: null,
                        status: "dead",
                        error: formatErrorMessage(error),
                        lastUpdatedAt: prev[widgetId]?.lastUpdatedAt ?? null,
                    },
                }));
            })
            .finally(() => {
                setLoadingMap((prev) => ({ ...prev, [widgetId]: false }));
                setRefreshingMap((prev) => ({ ...prev, [widgetId]: false }));
                delete inFlightRef.current[widgetId];
                if (controllersRef.current[widgetId] === controller) {
                    delete controllersRef.current[widgetId];
                }
            });

        inFlightRef.current[widgetId] = fetchPromise;
        return fetchPromise;
    }, []);

    useEffect(() => {
        const widgetIds = new Set(widgets.map((w) => w.id));

        // Clean up removed widgets only
        Object.keys(timersRef.current).forEach((widgetId) => {
            if (!widgetIds.has(widgetId)) {
                clearTimeout(timersRef.current[widgetId]);
                delete timersRef.current[widgetId];
                delete scheduleKeyRef.current[widgetId];
                delete inFlightRef.current[widgetId];
                // Remove the failure count entry for the removed widget so the
                // Map doesn't grow unboundedly if widgets are frequently added
                // and removed from the dashboard.
                failureCountRef.current.delete(widgetId);
                const controller = controllersRef.current[widgetId];
                if (controller) {
                    controller.abort();
                    delete controllersRef.current[widgetId];
                }
            }
        });

        // Schedule or re-schedule each widget
        widgets.forEach((widget) => {
            const intervalSec = clampIntervalSec(widget.refreshIntervalSec ?? 5);
            const key = scheduleKeyFor(widget);

            if (scheduleKeyRef.current[widget.id] === key) {
                if (!resultsRef.current[widget.id]) fetchWidget(widget);
                return;
            }

            if (timersRef.current[widget.id]) {
                clearTimeout(timersRef.current[widget.id]);
            }

            scheduleKeyRef.current[widget.id] = key;
            // Reset failure count when the schedule key changes (endpoint /
            // interval / fresh-flag changed) so stale backoff state from a
            // previous configuration doesn't carry over to the new one.
            failureCountRef.current.set(widget.id, 0);

            // Resolve the widget from widgetsRef on every tick instead of
            // capturing it in the closure: a setting edit (criteria, table
            // formatting, etc.) won't change the schedule key but still
            // needs to be visible on the next fetch — a captured `widget`
            // would keep the old settings until the user toggles something
            // that does invalidate the schedule key.
            const widgetId = widget.id;
            const startDelay = computeStartDelayMs(widgetId, intervalSec);

            // Recursive setTimeout instead of setInterval so each tick can
            // read the current failure count and schedule itself at the
            // appropriate backoff delay. setInterval fires at a fixed cadence
            // and cannot express variable inter-tick gaps.
            const scheduleTick = (delayMs) => {
                timersRef.current[widgetId] = setTimeout(async () => {
                    // Skip fetch while tab is hidden — avoids ~360 req/min for
                    // 30 widgets × 5 s interval in background tabs. The
                    // visibilitychange effect below fires an immediate refetch
                    // when the user returns, so no stale data is shown.
                    // NOTE: 탭이 숨겨진 동안에는 알람 감지가 최대 폴링 주기만큼 지연된다.
                    // Scheduled tick fires while hidden — re-arm at current backoff
                    // delay (preserves backoff state across the hidden period).
                    if (!document.hidden) {
                        const latest = widgetsRef.current.find((w) => w.id === widgetId);
                        if (latest) await fetchWidget(latest);
                    }
                    // Re-arm: read failure count AFTER the fetch completes so
                    // the next delay already reflects the outcome of this tick.
                    if (timersRef.current[widgetId] !== undefined) {
                        const fails = failureCountRef.current.get(widgetId) || 0;
                        const base = clampIntervalSec(
                            (widgetsRef.current.find((w) => w.id === widgetId)?.refreshIntervalSec) ?? 5,
                        );
                        scheduleTick(nextPollDelay(fails, base));
                    }
                }, delayMs);
            };

            // Phase the very first fetch via the start delay, then hand off
            // to the recursive scheduler for all subsequent ticks.
            timersRef.current[widgetId] = setTimeout(() => {
                // Immediate first tick (within the start-delay window).
                (async () => {
                    if (!document.hidden) {
                        const latest = widgetsRef.current.find((w) => w.id === widgetId);
                        if (latest) await fetchWidget(latest);
                    }
                    if (timersRef.current[widgetId] !== undefined) {
                        const fails = failureCountRef.current.get(widgetId) || 0;
                        scheduleTick(nextPollDelay(fails, intervalSec));
                    }
                })();
            }, startDelay);
        });

        // Only clean up all timers on full unmount (not on every widgets change)
    }, [widgets, fetchWidget]);

    // Unmount-only cleanup
    useEffect(() => {
        return () => {
            Object.values(timersRef.current).forEach(clearTimeout);
            Object.values(controllersRef.current).forEach((c) => {
                try { c.abort(); } catch { /* ignore */ }
            });
            timersRef.current = {};
            scheduleKeyRef.current = {};
            inFlightRef.current = {};
            controllersRef.current = {};
            failureCountRef.current.clear();
        };
    }, []);

    // Visibility-flip: when the user returns to the tab, immediately fetch all
    // widgets so they show fresh data right away rather than waiting up to one
    // full polling interval. All widgets burst simultaneously — intentional
    // trade-off: user-visible freshness > momentary BE burst (which is bounded
    // by the widget count, same as a normal dashboard load).
    // 최초 마운트 시 useDocumentVisible()이 true로 초기화되므로 이 effect가 즉시 실행돼
    // 스케줄링 effect의 첫 fetch와 중복된다. isFirstMountRef로 마운트 시 1회만 건너뛴다.
    const isFirstMountRef = useRef(true);
    useEffect(() => {
        if (isFirstMountRef.current) {
            isFirstMountRef.current = false;
            return;
        }
        if (visible) {
            widgetsRef.current.forEach((w) => fetchWidget(w));
        }
    // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [visible]);

    const refetchAll = useCallback(
        () => Promise.all(widgetsRef.current.map((w) => fetchWidget(w))),
        [fetchWidget],
    );

    const refetchOne = useCallback(
        (widgetId) => {
            const widget = widgetsRef.current.find((w) => w.id === widgetId);
            return widget ? fetchWidget(widget) : Promise.resolve();
        },
        [fetchWidget],
    );

    // Timemachine override: when TM mode is ON, replace results with snapshot data.
    // Live polling timers still run in the background but their results are hidden.
    // (Timers are not stopped here to avoid breaking the timer lifecycle — they are
    //  simply masked. Per the plan, widgets show snapshot payload instead of live data.)
    const tmResults = useMemo(() => {
        if (!tm.enabled) return null;
        const overridden = {};
        for (const widget of widgets) {
            // status-list: 다중 http_status 타깃을 합성해야 해서 단일 snapshot key
            // 로 풀 수 없다. 각 타깃의 monitor:http_status 스냅샷을 모아 라이브와
            // 동일한 {items, okCount, failCount} 형태로 변환한다 (Track A).
            if (resolveWidgetType(widget) === "status-list") {
                const { hasAny, latestTsMs, data } = buildStatusListTmData(
                    widget.targetIds, tm.snapshotByKey,
                );
                const failCount = Number(data?.failCount || 0);
                const okCount = Number(data?.okCount || 0);
                overridden[widget.id] = {
                    id: widget.id,
                    data: hasAny ? data : null,
                    // status-list 는 전역 알람(reportWidgetStatus)을 호출하지 않으므로
                    // 여기서의 status 는 카드 표시용일 뿐 과거 시점 라이브 알람을
                    // 유발하지 않는다. 라이브 경로와 동일한 판정 규칙을 따른다.
                    status: hasAny
                        ? (failCount === 0 ? "live" : okCount > 0 ? "slow-live" : "dead")
                        : "dead",
                    error: tm.error || (hasAny ? null : "이 시점에 데이터 없음"),
                    lastUpdatedAt: latestTsMs,
                };
                continue;
            }
            const key = tm.resolveSnapshotKey ? tm.resolveSnapshotKey(widget) : snapshotKeyForWidget(widget);
            const snap = key ? tm.snapshotByKey.get(key) : null;
            // BE 가 data_api 를 {title, endpoint, data: [...]} 로 wrapping 해서
            // 저장하지만 라이브 응답은 [...] 평탄 배열. 위젯은 평탄 형태를
            // 기대하므로 .data 를 unwrap. 모니터 타입 payload 는 .data 가 없어
            // ?? 로 자기 자신 fallback.
            const payload = snap?.payload ?? null;
            const unwrapped = payload && typeof payload === "object" && "data" in payload
                ? payload.data
                : payload;
            overridden[widget.id] = {
                id: widget.id,
                data: unwrapped,
                status: snap ? "live" : "dead",
                error: tm.error || (snap ? null : "이 시점에 데이터 없음"),
                lastUpdatedAt: snap?.tsMs ?? null,
            };
        }
        return overridden;
    // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [tm.enabled, tm.snapshotByKey, tm.error, widgets]);

    const activeResults = tm.enabled ? (tmResults ?? {}) : results;
    const activeLoadingMap = tm.enabled
        ? Object.fromEntries(widgets.map((w) => {
            const k = tm.resolveSnapshotKey ? tm.resolveSnapshotKey(w) : snapshotKeyForWidget(w);
            return [w.id, tm.loading && !tm.snapshotByKey.get(k)];
        }))
        : loadingMap;
    const activeRefreshingMap = tm.enabled ? {} : refreshingMap;

    return {
        results: activeResults,
        loadingMap: activeLoadingMap,
        refreshingMap: activeRefreshingMap,
        refetchAll: tm.enabled ? () => {} : refetchAll,
        refetchOne: tm.enabled ? () => {} : refetchOne,
    };
};

export default useWidgetApiData;
