import {
    useEffect,
    useState,
    useRef,
    useCallback,
    useMemo,
} from "react";
import apiClient from "../services/http.js";
import { monitorService } from "../services/dashboardService.js";
import { useTimemachine } from "../contexts/TimemachineContext";
import { useDocumentVisible } from "../hooks/useDocumentVisible.js";
import {
    DEFAULT_WIDGET_FONT_SIZE,
    MAX_REFRESH_INTERVAL_SEC,
    MAX_WIDGET_FONT_SIZE,
    MAX_WIDGET_H,
    MAX_WIDGET_W,
    MIN_REFRESH_INTERVAL_SEC,
    MIN_WIDGET_FONT_SIZE,
    MIN_WIDGET_H,
    MIN_WIDGET_W,
} from "../pages/dashboardConstants";
import {
    DEFAULT_CRITERIA,
    MAX_HISTORY,
    checkCriteria,
    clamp,
    formatElapsed,
    formatInterval,
    formatTime,
    migrateServers,
} from "./serverResourceHelpers";
import ServerRow from "./ServerRow";
import ServerDetailPopup from "./ServerDetailPopup";
import ServerResourceSettingsModal from "./ServerResourceSettingsModal";
import { IconClose, IconRefresh, IconSettings } from "./icons";
import { toUserSize } from "./widgetUtils.js";
import {
    sortAlertsFirst,
    useAutoScrollTopOnDataChange,
} from "../utils/widgetListHelpers";
import "./ApiCard.css";
import "./ServerResourceCard.css";

/**
 * Lazy-mounted draft buffer + handler bag for ServerResourceSettingsModal.
 * Lives outside ServerResourceCard so the parent doesn't carry 4 useStates
 * and 3 sync effects that re-run on every poll while the modal is closed.
 */
const ServerResourceSettingsContainer = ({
    open,
    onClose,
    title,
    targetIds,
    currentSize,
    sizeBounds,
    refreshIntervalSec,
    widgetFontSize,
    onSizeChange,
    onRefreshIntervalChange,
    onWidgetMetaChange,
    onWidgetConfigChange,
}) => {
    const [sizeDraft, setSizeDraft] = useState({
        w: currentSize?.w ?? 4,
        h: currentSize?.h ?? 5,
    });
    const [intervalDraft, setIntervalDraft] = useState(refreshIntervalSec ?? 30);
    const [titleDraft, setTitleDraft] = useState(title);
    const [fontSizeDraft, setFontSizeDraft] = useState(
        widgetFontSize ?? DEFAULT_WIDGET_FONT_SIZE,
    );
    const [selectedTargetIdsDraft, setSelectedTargetIdsDraft] = useState(
        () => [...targetIds],
    );

    useEffect(() => {
        setSizeDraft({ w: currentSize?.w ?? 4, h: currentSize?.h ?? 5 });
    }, [currentSize?.w, currentSize?.h]);
    useEffect(() => {
        setIntervalDraft(refreshIntervalSec ?? 30);
    }, [refreshIntervalSec]);
    useEffect(() => { setTitleDraft(title); }, [title]);
    useEffect(() => {
        setFontSizeDraft(widgetFontSize ?? DEFAULT_WIDGET_FONT_SIZE);
    }, [widgetFontSize]);

    const handleSizeApply = () => {
        const w = clamp(
            sizeDraft.w,
            sizeBounds?.minW ?? MIN_WIDGET_W,
            sizeBounds?.maxW ?? MAX_WIDGET_W,
            currentSize?.w ?? 8,
        );
        const h = clamp(
            sizeDraft.h,
            sizeBounds?.minH ?? MIN_WIDGET_H,
            sizeBounds?.maxH ?? MAX_WIDGET_H,
            currentSize?.h ?? 5,
        );
        setSizeDraft({ w, h });
        onSizeChange(w, h);
    };

    const handleIntervalApply = () => {
        const v = clamp(intervalDraft, MIN_REFRESH_INTERVAL_SEC, MAX_REFRESH_INTERVAL_SEC, 30);
        setIntervalDraft(v);
        onRefreshIntervalChange(v);
    };

    const handleTitleApply = () => {
        const t = titleDraft.trim();
        if (t && t !== title) onWidgetMetaChange?.({ title: t });
    };

    const handleFontSizeApply = () => {
        const v = clamp(
            fontSizeDraft,
            MIN_WIDGET_FONT_SIZE,
            MAX_WIDGET_FONT_SIZE,
            DEFAULT_WIDGET_FONT_SIZE,
        );
        setFontSizeDraft(v);
        onWidgetMetaChange?.({ dataFontSize: v });
    };

    const handleSaveTargets = () => {
        onWidgetConfigChange?.({ targetIds: selectedTargetIdsDraft });
        onClose?.();
    };

    return (
        <ServerResourceSettingsModal
            open={open}
            title={title}
            onClose={onClose}
            titleDraft={titleDraft}
            onTitleDraftChange={setTitleDraft}
            onTitleApply={handleTitleApply}
            sizeDraft={sizeDraft}
            sizeBounds={sizeBounds}
            onSizeDraftChange={setSizeDraft}
            onSizeApply={handleSizeApply}
            intervalDraft={intervalDraft}
            onIntervalDraftChange={setIntervalDraft}
            onIntervalApply={handleIntervalApply}
            fontSizeDraft={fontSizeDraft}
            onFontSizeDraftChange={setFontSizeDraft}
            onFontSizeApply={handleFontSizeApply}
            selectedTargetIds={selectedTargetIdsDraft}
            onSelectedTargetIdsChange={setSelectedTargetIdsDraft}
            onSave={handleSaveTargets}
        />
    );
};

/**
 * Container for the multi-server resource monitor widget.
 *
 * Owns: server polling, per-server state, history accumulation, alarm
 * reporting. Settings draft state lives in ServerResourceSettingsContainer
 * which only mounts while the modal is open. All visual sub-components are
 * stateless and live in their own files (SRP).
 */
const ServerResourceCard = ({
    title,
    widgetConfig,
    onRemove,
    currentSize,
    sizeBounds,
    onSizeChange,
    refreshIntervalSec,
    widgetFontSize,
    onRefreshIntervalChange,
    onWidgetMetaChange,
    onWidgetConfigChange,
    onAlarmChange,
}) => {
    /* ── timemachine mode check ────────────────────────────────────── */
    const tm = useTimemachine();
    const tmActive = tm.enabled;

    /* ── mode: snapshot (BE-centralized) vs legacy (credentials in widget) */
    const targetIds = useMemo(
        () => (Array.isArray(widgetConfig?.targetIds) ? widgetConfig.targetIds : []),
        [widgetConfig],
    );
    const useSnapshot = targetIds.length > 0;

    /* ── derived: servers list ────────────────────────────────────
     * snapshot mode → built from the latest /monitor-snapshot response
     * legacy mode   → migrateServers(widgetConfig.servers)
     */
    const [snapshotServers, setSnapshotServers] = useState([]);
    const legacyServers = useMemo(() => migrateServers(widgetConfig), [widgetConfig]);
    const servers = useSnapshot ? snapshotServers : legacyServers;

    /* ── display mode based on grid width ────────────────────────── */
    // Compare in user units (1.0 = old 12-col cell, post-migration 2 grid cells)
    // so the breakpoints stay stable across grid-resolution changes. The
    // server-resource row packs label + host + 3 metric bars + values; with
    // half-unit sizing operators frequently size these widgets at 3.5–4.0
    // user units where the metrics start overlapping in "normal" mode, so the
    // compact/mini cutoffs are bumped slightly compared to the other widgets.
    const userW = toUserSize(currentSize?.w ?? 8);
    const displayMode =
        userW <= 2.5
            ? "mini"
            : userW <= 4
              ? "compact"
              : userW <= 7
                ? "normal"
                : "wide";

    /* ── visibility-aware polling ────────────────────────────────── */
    const visible = useDocumentVisible();

    /* ── per-server data map ─────────────────────────────────────── */
    const [serverStates, setServerStates] = useState({});
    const [diskCycleIdx, setDiskCycleIdx] = useState(0);
    const serversRef = useRef(servers);
    const timerRef = useRef(null);

    /* ── history for detail popup charts ────────────────────────── */
    const historyRef = useRef({});
    const [historyVersion, setHistoryVersion] = useState(0);
    const [detailServerId, setDetailServerId] = useState(null);

    useEffect(() => {
        serversRef.current = servers;
    }, [servers]);

    // 서버 목록이 변하면 historyRef에서 사라진 서버의 히스토리 키를 정리한다.
    // (각 키는 MAX_HISTORY로 cap되지만, 잦은 추가/삭제 시 유령 키가 누적될 수 있음)
    useEffect(() => {
        const liveIds = new Set(servers.map((s) => s.id));
        let purged = false;
        Object.keys(historyRef.current).forEach((id) => {
            if (!liveIds.has(id)) {
                delete historyRef.current[id];
                purged = true;
            }
        });
        if (purged) setHistoryVersion((v) => v + 1);
    }, [servers]);

    /**
     * 모든 서버의 리소스 지표를 조회하여 상태에 반영한다.
     * @returns {Promise<boolean>} 네트워크 요청 자체가 성공하면 true
     *   (개별 서버의 고부하·장애 여부는 앱 레벨 신호이므로 false로 취급하지 않는다).
     *   네트워크/서버 오류(응답 없음·타임아웃·5xx·fetch 거부) 시 false.
     *   *WithTracking 래퍼가 이 반환값으로 exponential backoff를 구동한다.
     */
    const fetchAllServers = useCallback(async () => {
        // Skip polling while tab is hidden to avoid wasted requests.
        // The visibility-flip effect triggers an immediate fetch on return.
        // NOTE: 탭이 숨겨진 동안에는 알람 감지가 최대 폴링 주기만큼 지연된다.
        // Hidden tab: neutral result — don't count as success or failure.
        if (document.hidden) return true;
        if (useSnapshot) {
            if (targetIds.length === 0) return true;
            setDiskCycleIdx((prev) => prev + 1);
            try {
                const res = await monitorService.getSnapshot(targetIds);
                const items = Array.isArray(res?.items) ? res.items : [];
                const now = new Date();
                // 임계치는 BE 의 spec.criteria 가 단일 출처. 누락된 값만 코드 기본값으로
                // 보강해 위젯 알람 평가 함수가 항상 완전한 dict 을 받도록 한다.
                const derivedServers = items.map((it) => ({
                    id: it.targetId,
                    label: it.label || it.spec?.host || it.targetId,
                    osType: it.spec?.os_type || it.spec?.osType || "linux-generic",
                    host: it.spec?.host || "",
                    criteria: {
                        ...DEFAULT_CRITERIA,
                        ...(it.spec?.criteria || {}),
                    },
                }));
                setSnapshotServers(derivedServers);
                setServerStates(() => {
                    const next = {};
                    items.forEach((it) => {
                        next[it.targetId] = {
                            data: it.data,
                            error: it.errorMessage || null,
                            loading: false,
                            lastUpdated: it.updatedAt ? new Date(it.updatedAt) : null,
                            lastAttempted: now,
                        };
                    });
                    return next;
                });
                // HTTP 200 received from BE — network is up regardless of
                // individual server status (dead servers are app-level signals).
                return true;
            } catch (err) {
                const errorMsg = err?.response?.data?.message || err?.message || "스냅샷 조회 실패";
                setServerStates((prev) => {
                    const next = { ...prev };
                    targetIds.forEach((tid) => {
                        next[tid] = {
                            data: prev[tid]?.data ?? null,
                            error: errorMsg,
                            loading: false,
                            lastUpdated: prev[tid]?.lastUpdated ?? null,
                            lastAttempted: new Date(),
                        };
                    });
                    return next;
                });
                // Network/server error — signal failure so backoff engages.
                return false;
            }
        }

        const list = serversRef.current;
        if (list.length === 0) return true;
        setDiskCycleIdx((prev) => prev + 1);

        const batchPayload = list.map((srv) => {
            const item = { os_type: srv.osType, host: srv.host || "localhost" };
            if (
                srv.osType === "windows" &&
                srv.host !== "localhost" &&
                srv.host !== "127.0.0.1"
            ) {
                if (srv.username) item.username = srv.username;
                if (srv.password) item.password = srv.password;
                if (srv.domain) item.domain = srv.domain;
            }
            if (srv.osType === "windows-winrm") {
                item.username = srv.username;
                item.password = srv.password;
                if (srv.domain) item.domain = srv.domain;
                if (srv.port) item.port = Number(srv.port);
                if (srv.transport) item.transport = srv.transport;
            }
            if (
                (srv.osType.startsWith("linux") || srv.osType === "windows-ssh") &&
                srv.host !== "localhost" &&
                srv.host !== "127.0.0.1"
            ) {
                item.username = srv.username;
                item.password = srv.password;
                if (srv.port) item.port = Number(srv.port);
            }
            return item;
        });

        try {
            const res = await apiClient.post(
                "/dashboard/server-resources-batch",
                { servers: batchPayload },
            );
            const batchResults = res.data?.results || [];

            setServerStates((prev) => {
                const next = { ...prev };
                list.forEach((srv, i) => {
                    const data = batchResults[i] || null;
                    const now = new Date();
                    if (data) {
                        next[srv.id] = {
                            data,
                            error: data.error || null,
                            loading: false,
                            lastUpdated: now,
                            lastAttempted: now,
                        };
                    } else {
                        next[srv.id] = {
                            data: next[srv.id]?.data ?? null,
                            error: "No result from batch",
                            loading: false,
                            lastUpdated: next[srv.id]?.lastUpdated ?? null,
                            lastAttempted: now,
                        };
                    }
                });
                return next;
            });
            // BE answered — network success regardless of per-server metric results.
            return true;
        } catch (err) {
            const errorMsg =
                err?.response?.data?.message || err?.message || "요청 실패";
            setServerStates((prev) => {
                const next = { ...prev };
                list.forEach((srv) => {
                    next[srv.id] = {
                        data: next[srv.id]?.data ?? null,
                        error: errorMsg,
                        loading: false,
                        lastUpdated: next[srv.id]?.lastUpdated ?? null,
                        lastAttempted: new Date(),
                    };
                });
                return next;
            });
            // Network/server error — signal failure so backoff engages.
            return false;
        }
    // widgetConfig 변경은 targetIds (useMemo above) 통해 전파됨 — widgetConfig 를 deps 에 다시 넣지 말 것.
    }, [useSnapshot, targetIds]);

    // stable key for detecting server list changes.
    // snapshot mode: tracks the target id set.
    // legacy mode: tracks each server's identity (host/os may change).
    const pollKey = useMemo(() => (
        useSnapshot
            ? `s:${targetIds.join(",")}`
            : `l:${legacyServers.map((s) => `${s.id}|${s.host}|${s.osType}`).join(",")}`
    ), [useSnapshot, targetIds, legacyServers]);

    const hasItems = useSnapshot ? targetIds.length > 0 : legacyServers.length > 0;

    // Consecutive failure counter for exponential backoff polling.
    // Incremented on network/server error, reset to 0 on first success.
    const failCountRef = useRef(0);

    // Wrap fetchAllServers to track success/failure for backoff purposes.
    // fetchAllServers returns true on network success, false on network failure.
    // App-level dead signals (server reports error from a 200 response) do NOT
    // increment the counter — backoff should only engage on network failures.
    const fetchAllServersWithTracking = useCallback(async () => {
        const ok = await fetchAllServers();
        if (ok) {
            failCountRef.current = 0;
        } else {
            failCountRef.current += 1;
        }
    }, [fetchAllServers]);

    useEffect(() => {
        if (tmActive || !hasItems) return;
        fetchAllServers();
    }, [pollKey, hasItems, fetchAllServers, tmActive]);

    // 타임머신 모드: live polling 대신 tm.snapshotByKey 에서 monitor:server_resource
    // 의 snapshot 을 각 targetId 별로 읽어 serverStates 에 반영. snapshot.payload =
    // {label, data, errorMessage, spec, ...} (BE _tm_archive_monitor 와 동일 shape).
    useEffect(() => {
        if (!tmActive || !hasItems || !useSnapshot) return;
        const items = [];
        for (const tid of targetIds) {
            const snap = tm.snapshotByKey.get(`monitor:server_resource|${tid}`);
            if (!snap) {
                items.push({ targetId: tid, data: null, errorMessage: "이 시점에 데이터 없음" });
                continue;
            }
            const p = snap.payload || {};
            items.push({
                targetId: tid,
                label: p.label,
                spec: p.spec,
                data: p.data,
                errorMessage: p.errorMessage,
                updatedAt: snap.tsMs ? new Date(snap.tsMs).toISOString() : null,
            });
        }
        const derivedServers = items.map((it) => ({
            id: it.targetId,
            label: it.label || it.spec?.host || it.targetId,
            osType: it.spec?.os_type || it.spec?.osType || "linux-generic",
            host: it.spec?.host || "",
            criteria: { ...DEFAULT_CRITERIA, ...(it.spec?.criteria || {}) },
        }));
        setSnapshotServers(derivedServers);
        setServerStates(() => {
            const next = {};
            items.forEach((it) => {
                next[it.targetId] = {
                    data: it.data,
                    error: it.errorMessage || null,
                    loading: false,
                    lastUpdated: it.updatedAt ? new Date(it.updatedAt) : null,
                    lastAttempted: new Date(),
                };
            });
            return next;
        });
    // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [tmActive, tm.snapshotByKey, useSnapshot, hasItems, targetIds]);

    // Exponential-backoff polling via recursive setTimeout.
    // On consecutive failures: base → 2× → 4× → 8× → 16× → 32× (cap at 5 min).
    // Returns to base interval on first successful response.
    useEffect(() => {
        if (tmActive || !hasItems) return undefined;
        const baseSec = refreshIntervalSec ?? 30;
        // Reset failure count when poll key or interval changes so stale backoff
        // state from a previous configuration does not carry over.
        failCountRef.current = 0;

        const schedule = (delayMs) => {
            timerRef.current = setTimeout(async () => {
                await fetchAllServersWithTracking();
                const fails = failCountRef.current;
                const nextDelay = fails === 0
                    ? baseSec * 1000
                    : Math.min(baseSec * 1000 * (2 ** Math.min(fails, 5)), 5 * 60 * 1000);
                schedule(nextDelay);
            }, delayMs);
        };
        schedule(baseSec * 1000);
        return () => clearTimeout(timerRef.current);
    }, [pollKey, hasItems, refreshIntervalSec, fetchAllServersWithTracking, tmActive]);

    // Visibility-flip: immediately refetch when the user returns to the tab so
    // the widget shows fresh data rather than stale results from before hiding.
    // Trade-off: all visible-flip fetches fire simultaneously (BE burst), but
    // this equals a normal dashboard load — acceptable for user freshness.
    // 최초 마운트 시 useDocumentVisible()이 true로 초기화되므로 이 effect가 즉시 실행돼
    // 스케줄링 effect의 첫 fetch와 중복된다. isFirstMountRef로 마운트 시 1회만 건너뛴다.
    const isFirstMountRef = useRef(true);
    useEffect(() => {
        if (isFirstMountRef.current) {
            isFirstMountRef.current = false;
            return;
        }
        if (visible && hasItems) fetchAllServersWithTracking();
    // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [visible]);

    /* ── accumulate history for charts ─────────────────────────── */
    useEffect(() => {
        const now = Date.now();
        let changed = false;
        Object.entries(serverStates).forEach(([id, state]) => {
            if (!state?.data) return;
            const d = state.data;
            const point = {
                ts: now,
                cpu: d.cpu?.usedPct ?? null,
                memory: d.memory?.usedPct ?? null,
            };
            (d.disks || []).forEach((dk) => {
                const key = `disk_${(dk.mount || "root").toLowerCase()}`;
                point[key] = dk.usedPct ?? null;
            });
            const prev = historyRef.current[id] || [];
            // Avoid duplicates for same timestamp (within 500ms)
            if (prev.length > 0 && Math.abs(prev[prev.length - 1].ts - now) < 500)
                return;
            // Always create a new array (React dev mode may freeze arrays passed as props)
            const next = [...prev, point];
            historyRef.current[id] =
                next.length > MAX_HISTORY
                    ? next.slice(next.length - MAX_HISTORY)
                    : next;
            changed = true;
        });
        if (changed) setHistoryVersion((v) => v + 1);
    }, [serverStates]);

    const detailServer = useMemo(
        () =>
            detailServerId
                ? servers.find((s) => s.id === detailServerId)
                : null,
        [detailServerId, servers],
    );

    const detailHistory = useMemo(
        () => (detailServerId ? historyRef.current[detailServerId] || [] : []),
        // eslint-disable-next-line react-hooks/exhaustive-deps
        [detailServerId, historyVersion],
    );

    /* ── per-server violations (criteria check) ─────────────────── */
    const violationsMap = useMemo(() => {
        const map = {};
        servers.forEach((srv) => {
            const state = serverStates[srv.id];
            if (state?.data) {
                map[srv.id] = checkCriteria(
                    state.data,
                    srv.criteria || DEFAULT_CRITERIA,
                );
            }
        });
        return map;
    }, [servers, serverStates]);

    const totalViolations = useMemo(
        () =>
            Object.values(violationsMap).reduce((sum, v) => sum + v.length, 0),
        [violationsMap],
    );

    /* ── NG(알람) 서버를 목록 상단으로 끌어올림 ───────────────────── */
    // 판정 기준은 statusCounts 와 동일: 접속 에러(데이터 없음) 또는 임계치 위반.
    const displayServers = useMemo(
        () =>
            sortAlertsFirst(servers, (srv) => {
                const state = serverStates[srv.id];
                if (state?.error && !state?.data) return true;
                return (violationsMap[srv.id] || []).length > 0;
            }),
        [servers, serverStates, violationsMap],
    );

    const statusCounts = useMemo(() => {
        let ok = 0,
            ng = 0;
        servers.forEach((srv) => {
            const state = serverStates[srv.id];
            const v = violationsMap[srv.id] || [];
            if (!state?.data && state?.error) ng++;
            else if (v.length > 0) ng++;
            else if (state?.data) ok++;
        });
        return { ok, ng };
    }, [servers, serverStates, violationsMap]);

    // Detect backend-level failure (all servers unreachable)
    const isDead = useMemo(() => {
        if (servers.length === 0) return false;
        return servers.every((srv) => {
            const st = serverStates[srv.id];
            return st?.error && !st?.data;
        });
    }, [servers, serverStates]);

    // Stale: data exists but last successful fetch is too old, or
    // the most recent attempt failed while old data is still displayed
    const isStale = useMemo(() => {
        if (servers.length === 0 || isDead) return false;
        const staleSec = (refreshIntervalSec ?? 30) * 3;
        const now = Date.now();
        return servers.some((srv) => {
            const st = serverStates[srv.id];
            if (!st) return false;
            // Has error while showing stale data
            if (st.error && st.data) return true;
            // Last successful update is too old
            if (st.lastUpdated && (now - st.lastUpdated.getTime()) > staleSec * 1000) return true;
            return false;
        });
    }, [servers, serverStates, isDead, refreshIntervalSec]);

    // Report alarm status to parent. 타임머신 모드에서는 과거 시점 데이터에
    // 대해 라이브 알람을 발화하지 않는다 (알람 이력은 별도 페이지에서 확인).
    useEffect(() => {
        if (!onAlarmChange) return;
        if (tmActive) {
            onAlarmChange("live");
            return;
        }
        onAlarmChange(totalViolations > 0 || isDead ? "dead" : "live");
    }, [totalViolations, isDead, onAlarmChange, tmActive]);

    /* ── 갱신 주기마다 목록 스크롤 최상단으로 ─────────────────────── */
    const scrollRef = useRef(null);
    useAutoScrollTopOnDataChange(scrollRef, serverStates);

    /* ── settings modal state ────────────────────────────────────── */
    const [showSettings, setShowSettings] = useState(false);
    const hasAutoOpened = useRef(false);

    useEffect(() => {
        // 새로 추가된 위젯에 대상이 비어있으면 settings 모달을 자동으로 한 번 열어준다.
        if (
            !hasAutoOpened.current &&
            targetIds.length === 0 &&
            legacyServers.length === 0
        ) {
            setShowSettings(true);
            hasAutoOpened.current = true;
        }
    }, []); // eslint-disable-line react-hooks/exhaustive-deps

    const openSettings = useCallback(() => {
        setShowSettings(true);
    }, []);

    /* ── summary info ────────────────────────────────────────────── */
    const lastUpdated = useMemo(() => {
        let latest = null;
        Object.values(serverStates).forEach((s) => {
            if (s.lastUpdated && (!latest || s.lastUpdated > latest))
                latest = s.lastUpdated;
        });
        return latest;
    }, [serverStates]);

    // Tick for elapsed time display (only active when stale/dead)
    const [, setElapsedTick] = useState(0);
    useEffect(() => {
        if (!isStale && !isDead) return;
        const id = setInterval(() => setElapsedTick((v) => v + 1), 10_000);
        return () => clearInterval(id);
    }, [isStale, isDead]);

    /* ── render: main card ───────────────────────────────────────── */
    return (
        <div className='api-card'>
            <div className='api-card-header'>
                <div className='api-card-title-section'>
                    <div className='api-card-title-row'>
                        <h4 title={title}>{title}</h4>
                        {isDead && (
                            <span className='status-pill dead'>
                                <span className='status-dot' />
                                DEAD
                            </span>
                        )}
                        {!isDead && isStale && (
                            <span className='status-pill stale'>
                                <span className='status-dot' />
                                STALE
                            </span>
                        )}
                        <div className='title-actions'>
                            <button
                                type='button'
                                className='compact-icon-btn'
                                onClick={fetchAllServers}
                                title='새로고침'
                            >
                                <IconRefresh size={14} />
                            </button>
                            <button
                                type='button'
                                className='compact-icon-btn'
                                onClick={openSettings}
                               
                                title='설정'
                            >
                                <IconSettings size={14} />
                            </button>
                            <button
                                type='button'
                                className='compact-icon-btn remove'
                                onClick={onRemove}
                               
                                title='제거'
                            >
                                <IconClose size={14} />
                            </button>
                        </div>
                    </div>
                    <div className='api-endpoint-row'>
                        <div className='api-endpoint-info'>
                            {servers.length === 0 ? (
                                <span className='api-endpoint'>서버 미설정</span>
                            ) : (
                                <>
                                    {statusCounts.ok > 0 && (
                                        <span className='status-badge ok'>
                                            {statusCounts.ok} OK
                                        </span>
                                    )}
                                    {statusCounts.ng > 0 && (
                                        <span className='status-badge ng'>
                                            {statusCounts.ng} NG
                                        </span>
                                    )}
                                    {statusCounts.ok === 0 &&
                                        statusCounts.ng === 0 && (
                                            <span className='api-endpoint'>
                                                {servers.length}개 서버
                                            </span>
                                        )}
                                </>
                            )}
                        </div>
                        <span className='refresh-interval-chip'>
                            ⏱ {formatInterval(refreshIntervalSec ?? 30)}
                        </span>
                        {lastUpdated && (
                            <span
                                className={`last-updated-time${isStale || isDead ? " stale" : ""}`}
                                title={formatTime(lastUpdated)}
                            >
                                {isStale || isDead
                                    ? formatElapsed(lastUpdated)
                                    : formatTime(lastUpdated)}
                            </span>
                        )}
                    </div>
                </div>
            </div>

            {showSettings && (
                <ServerResourceSettingsContainer
                    open
                    onClose={() => setShowSettings(false)}
                    title={title}
                    targetIds={targetIds}
                    currentSize={currentSize}
                    sizeBounds={sizeBounds}
                    refreshIntervalSec={refreshIntervalSec}
                    widgetFontSize={widgetFontSize}
                    onSizeChange={onSizeChange}
                    onRefreshIntervalChange={onRefreshIntervalChange}
                    onWidgetMetaChange={onWidgetMetaChange}
                    onWidgetConfigChange={onWidgetConfigChange}
                />
            )}
            {detailServer && (
                <ServerDetailPopup
                    server={detailServer}
                    history={detailHistory}
                    // snapshot-mode servers are archived on the BE → the popup
                    // pulls a real multi-month trend; legacy servers fall back
                    // to the in-memory history.
                    sourceId={useSnapshot ? detailServer.id : null}
                    sourceType='monitor:server_resource'
                    onClose={() => setDetailServerId(null)}
                />
            )}

            <div className='api-card-content'>
                {servers.length === 0 ? (
                    <div className='resource-setup-prompt'>
                        <p>서버 접속 정보를 설정해주세요.</p>
                        <button
                            type='button'
                            className='size-preset-btn'
                            onClick={openSettings}
                        >
                            설정 열기
                        </button>
                    </div>
                ) : (
                    <div
                        className={`srv-list srv-list-${displayMode}`}
                        ref={scrollRef}
                        style={{ fontSize: `${widgetFontSize ?? DEFAULT_WIDGET_FONT_SIZE}px` }}
                    >
                        {displayServers.map((srv) => (
                            <ServerRow
                                key={srv.id}
                                server={srv}
                                data={serverStates[srv.id]?.data}
                                loading={
                                    serverStates[srv.id]?.loading !== false &&
                                    !serverStates[srv.id]?.data
                                }
                                error={serverStates[srv.id]?.error}
                                displayMode={displayMode}
                                violations={violationsMap[srv.id]}
                                diskCycleIdx={diskCycleIdx}
                                onDoubleClick={() => setDetailServerId(srv.id)}
                            />
                        ))}
                    </div>
                )}
            </div>
        </div>
    );
};

export default ServerResourceCard;
