import { useEffect, useMemo, useState } from "react";
import { WidthProvider, Responsive } from "react-grid-layout/legacy";
import { useNavigate } from "react-router-dom";
import { useWidgetApiData } from "../hooks/useApi";
import {
    dashboardService,
    getRememberedApiBaseUrl,
    normalizeUserEndpoint,
    rememberApiBaseUrl,
    resolveEndpointWithBase,
} from "../services/api";
import {
    alertService,
    cacheService,
    monitorService,
    widgetConfigService,
} from "../services/dashboardService";
import { IconHistory } from "../components/icons.jsx";
import { API_BASE_URL as BUILDTIME_API_BASE_URL } from "../services/http";
import { useDashboardStore } from "../store/dashboardStore";
import { useAuthStore } from "../store/authStore";
import { useAlarmStore } from "../store/alarmStore";
import AlarmBanner from "../components/AlarmBanner";
import { TimemachineProvider, useTimemachine } from "../contexts/TimemachineContext";
import TimemachineControlBar from "../components/TimemachineControlBar";
// SQL 편집기 / 백엔드 설정 모달은 모두 ConfigEditorPage 안으로 이동했다.
// 비밀번호 게이트는 ConfigEditorPage 내부에서 sessionStorage 기반으로 처리.
import DashboardHeader from "./DashboardHeader";
import AddApiModal from "./AddApiModal";
import DashboardSettingsModal from "./DashboardSettingsModal";
import WidgetRenderer from "./WidgetRenderer";
import {
    DEFAULT_DATA_WIDGET_FONT_SIZE,
    DEFAULT_REFRESH_INTERVAL_SEC,
    DEFAULT_WIDGET_FONT_SIZE,
    DEFAULT_WIDGET_LAYOUT,
    GRID_COLUMNS,
    MAX_WIDGET_FONT_SIZE,
    MAX_WIDGET_H,
    MAX_WIDGET_W,
    MIN_WIDGET_FONT_SIZE,
    MIN_WIDGET_H,
    MIN_WIDGET_W,
    WIDGET_TYPE_BAR_CHART,
    WIDGET_TYPE_LINE_CHART,
    WIDGET_TYPE_NETWORK_TEST,
    WIDGET_TYPE_SERVER_RESOURCE,
    WIDGET_TYPE_STATUS_LIST,
    WIDGET_TYPE_TABLE,
} from "./dashboardConstants";
import {
    clampValue,
    computeWidgetIntervalFloor,
    createDefaultApis,
    createStatusListWidget,
    layoutArrayToMap,
    normalizeWidgetLayout,
} from "./dashboardHelpers";
import { computeAlarmedWidgets } from "./alarmMapping";
import { mergeWidgetsWithBeConfigs } from "./widgetConfigMerge";
import "react-grid-layout/css/styles.css";
import "react-resizable/css/styles.css";
import "./DashboardPage.css";

const ResponsiveGridLayout = WidthProvider(Responsive);

const COMPANY_NAME =
    import.meta.env.VITE_COMPANY_NAME || "Monitoring Dashboard";
const CURRENT_YEAR = new Date().getFullYear();
// Build-time title fallback — used when no KV override is set by admin.
// LoginPage intentionally keeps its own copy (unauthenticated, no KV access).
const APP_TITLE = import.meta.env.VITE_APP_TITLE || "Monitoring Dashboard";
// 빌드 시점 기본 URL 해석은 services/http.js에 일원화되어 있다.
// (VITE_API_URL이 명시적 빈 문자열이면 same-origin 모드 → window.location.origin)
// localStorage에 저장된 값이 있으면 그것을 우선한다.
const API_BASE_URL = getRememberedApiBaseUrl() || BUILDTIME_API_BASE_URL;

const DEFAULT_APIS = createDefaultApis(API_BASE_URL);

const DashboardPageInner = () => {
    // Timemachine context (provided by outer DashboardPage wrapper)
    const tm = useTimemachine();
    const navigate = useNavigate();
    const logout = useAuthStore((state) => state.logout);
    const user = useAuthStore((state) => state.user);
    const widgets = useDashboardStore((state) => state.widgets);
    const layouts = useDashboardStore((state) => state.layouts);
    const setWidgets = useDashboardStore((state) => state.setWidgets);
    const addWidget = useDashboardStore((state) => state.addWidget);
    const removeWidget = useDashboardStore((state) => state.removeWidget);
    const updateWidget = useDashboardStore((state) => state.updateWidget);
    const saveLayout = useDashboardStore((state) => state.saveLayout);
    const saveLayouts = useDashboardStore((state) => state.saveLayouts);
    const dashboardSettings = useDashboardStore(
        (state) => state.dashboardSettings,
    );
    const setDashboardSettings = useDashboardStore(
        (state) => state.setDashboardSettings,
    );
    const exportDashboardConfig = useDashboardStore(
        (state) => state.exportDashboardConfig,
    );
    const importDashboardConfig = useDashboardStore(
        (state) => state.importDashboardConfig,
    );
    const syncPreferencesFromServer = useDashboardStore(
        (state) => state.syncPreferencesFromServer,
    );
    const disableServerSync = useDashboardStore(
        (state) => state.disableServerSync,
    );
    const flushPendingPush = useDashboardStore(
        (state) => state.flushPendingPush,
    );

    // 빌드 시점 기본값 해석은 services/http.js에 일원화 (same-origin 모드 포함)
    const rememberedApiBaseUrl =
        getRememberedApiBaseUrl() || BUILDTIME_API_BASE_URL;

    const [showAddApi, setShowAddApi] = useState(false);
    const [showDashboardSettings, setShowDashboardSettings] = useState(false);
    const [newApiForm, setNewApiForm] = useState({
        title: "",
        endpoint: "",
        type: WIDGET_TYPE_TABLE,
        targetIds: [],
    });
    const [monitorTargets, setMonitorTargets] = useState([]);
    const [monitorTargetsError, setMonitorTargetsError] = useState(null);
    // BE 가 endpoint 당 / monitor target 당 정의한 refresh 주기. 위젯 polling
    // floor 계산에 쓰임 (handleRefreshIntervalChange 가 사용자 입력을 clamp).
    // path → seconds.
    const [beApiByPath, setBeApiByPath] = useState({});
    // target id → seconds.
    const [beIntervalsByTargetId, setBeIntervalsByTargetId] = useState({});
    const [fontSizeDraft, setFontSizeDraft] = useState(
        dashboardSettings?.widgetFontSize ?? DEFAULT_WIDGET_FONT_SIZE,
    );
    const [configJsonDraft, setConfigJsonDraft] = useState("");
    const [configErrorMessage, setConfigErrorMessage] = useState("");
    const [apiBaseUrlDraft, setApiBaseUrlDraft] = useState(rememberedApiBaseUrl);
    const [apiBaseUrlSaved, setApiBaseUrlSaved] = useState(false);
    const [backendVersion, setBackendVersion] = useState(null);
    const [dashboardTitle, setDashboardTitle] = useState("");
    // Footer Copyright 의 회사명 — admin 이 ConfigEditorPage 기본 탭에서 편집한
    // KV 값. 빈 문자열이면 build-time COMPANY_NAME 으로 fallback.
    const [companyName, setCompanyName] = useState("");
    const [isFullscreen, setIsFullscreen] = useState(
        () => typeof document !== "undefined" && !!document.fullscreenElement,
    );

    useEffect(() => {
        const handleFullscreenChange = () => {
            setIsFullscreen(!!document.fullscreenElement);
        };
        document.addEventListener("fullscreenchange", handleFullscreenChange);
        return () => {
            document.removeEventListener(
                "fullscreenchange",
                handleFullscreenChange,
            );
        };
    }, []);

    // 마운트 시 한 번 BE 측 refresh 주기를 로드해 두고, 5분마다 재조회한다.
    // - /dashboard/cache/status      → endpoint path 별 refreshIntervalSec
    // - /dashboard/monitor-targets   → monitor target id 별 interval_sec
    // 두 정보는 사용자가 위젯 settings 모달에서 refresh 주기를 줄일 때
    // floor 로 사용된다 (handleRefreshIntervalChange).
    useEffect(() => {
        let cancelled = false;
        const loadBeIntervals = async () => {
            try {
                const [cacheStatus, targetsResp] = await Promise.all([
                    cacheService.getStatus().catch(() => null),
                    monitorService.listTargets().catch(() => null),
                ]);
                if (cancelled) return;
                if (cacheStatus && Array.isArray(cacheStatus.endpoints)) {
                    const map = {};
                    for (const ep of cacheStatus.endpoints) {
                        const sec = Number(ep.refreshIntervalSec);
                        if (ep.path && Number.isFinite(sec) && sec > 0) {
                            map[ep.path] = sec;
                        }
                    }
                    setBeApiByPath(map);
                }
                if (targetsResp && Array.isArray(targetsResp.targets)) {
                    const map = {};
                    for (const t of targetsResp.targets) {
                        const sec = Number(t.interval_sec ?? t.intervalSec);
                        if (t.id && Number.isFinite(sec) && sec > 0) {
                            map[String(t.id)] = sec;
                        }
                    }
                    setBeIntervalsByTargetId(map);
                }
            } catch {
                /* 네트워크 에러는 무시 — floor 가 없으면 전역 MIN 만 적용 */
            }
        };
        loadBeIntervals();
        const handle = setInterval(loadBeIntervals, 5 * 60 * 1000);
        return () => {
            cancelled = true;
            clearInterval(handle);
        };
    }, []);

    // AddApiModal 이 열릴 때 모니터 대상 목록을 로드해 둔다.
    // 서버 리소스/네트워크 위젯은 이 목록에서 골라서만 추가할 수 있다.
    useEffect(() => {
        if (!showAddApi) return;
        let cancelled = false;
        (async () => {
            try {
                const data = await monitorService.listTargets();
                if (cancelled) return;
                setMonitorTargets(Array.isArray(data?.targets) ? data.targets : []);
                setMonitorTargetsError(null);
            } catch (err) {
                if (cancelled) return;
                setMonitorTargets([]);
                setMonitorTargetsError(
                    err?.response?.data?.message ||
                        err?.message ||
                        "모니터 대상을 불러올 수 없습니다.",
                );
            }
        })();
        return () => {
            cancelled = true;
        };
    }, [showAddApi]);

    const handleToggleFullscreen = () => {
        if (!document.fullscreenElement) {
            document.documentElement.requestFullscreen?.().catch(() => {});
        } else {
            document.exitFullscreen?.().catch(() => {});
        }
    };

    useEffect(() => {
        let cancelled = false;
        const fetchBackendVersion = async () => {
            try {
                // /dashboard/health (authenticated) instead of /health
                // (public liveness probe). The latter intentionally no
                // longer leaks the deployed build version.
                const res = await dashboardService.getApiData(null, "/dashboard/health");
                if (cancelled) return;
                if (res?.version) setBackendVersion(res.version);
                // dashboardTitle / companyName: empty string → FE falls back to
                // build-time APP_TITLE / COMPANY_NAME.
                setDashboardTitle(res?.dashboardTitle ?? "");
                setCompanyName(res?.companyName ?? "");
            } catch {
                /* ignore */
            }
        };
        fetchBackendVersion();
        return () => {
            cancelled = true;
        };
    }, []);

    // Sync browser tab title whenever the KV-driven title changes
    useEffect(() => {
        document.title = dashboardTitle || APP_TITLE;
    }, [dashboardTitle]);

    useEffect(() => {
        setFontSizeDraft(
            dashboardSettings?.widgetFontSize ?? DEFAULT_WIDGET_FONT_SIZE,
        );
    }, [dashboardSettings?.widgetFontSize]);

    // Hydrate the store with server-side preferences once per session
    // (keyed by username so switching users re-fetches).
    //
    // buildDefaults is passed so that the store can seed the initial widget set
    // INSIDE the sync window when both localStorage and the BE have no record
    // (new PC, first login). Doing the seed here — outside the sync — would
    // race the async GET: setWidgets() triggers queueServerPush() which sets
    // _dirtyDuringSync=true, causing the local-wins branch to discard BE prefs
    // and push empty defaults back to the server.
    //
    // ⚠ WARNING: 이 effect 와 sync 응답 사이에 setWidgets/setLayouts 같은
    // store mutating effect 를 추가하면 위 race 가 재발한다 (issue #4 재현).
    // 새 effect 는 반드시 syncPreferencesFromServer 의 .then() 안에서 실행하거나,
    // store 의 _syncInFlight=false 확인 후 실행할 것.
    useEffect(() => {
        if (!user?.username) return;
        const buildDefaults = () => {
            const statusListWidget = createStatusListWidget();
            const defaultWidgets = [...DEFAULT_APIS, statusListWidget];
            const defaultLayouts = Object.fromEntries(
                defaultWidgets
                    .filter((w) => w.defaultLayout)
                    .map((w) => [w.id, w.defaultLayout]),
            );
            return { widgets: defaultWidgets, layouts: defaultLayouts };
        };
        syncPreferencesFromServer(buildDefaults);
    }, [user?.username, syncPreferencesFromServer]);

    const baseDashboardWidgets = widgets ?? DEFAULT_APIS;
    const isAdmin =
        user?.role === "admin" ||
        String(user?.username || "")
            .trim()
            .toLowerCase() === "admin";

    const reportWidgetStatus = useAlarmStore(
        (state) => state.reportWidgetStatus,
    );
    const syncAlarmedWidgets = useAlarmStore(
        (state) => state.syncAlarmedWidgets,
    );
    const alarmedWidgets = useAlarmStore((state) => state.alarmedWidgets);
    const [endpointCatalog, setEndpointCatalog] = useState([]);
    // Phase 2: BE-central widget_configs (displayColumns, thresholds) catalog.
    // 60s 폴링 — 위젯별 설정은 운영자만 자주 바꾸지 않는다. 폴링 자체가 폴링
    // 자체가 매번 settings DB 1번 SELECT 라 부담 작음.
    const [widgetConfigs, setWidgetConfigs] = useState([]);

    // augmented widgets: BE displayColumns 가 컬럼 정의 / labels 의 단일
    // 출처가 되도록 머지. user pref 의 columnWidths / 순서 / 위젯 크기는 그대로.
    const dashboardWidgets = useMemo(
        () => mergeWidgetsWithBeConfigs({
            widgets: baseDashboardWidgets,
            widgetConfigs,
            endpointCatalog,
        }),
        [baseDashboardWidgets, widgetConfigs, endpointCatalog],
    );
    const alarmSound = useAlarmStore((state) => state.alarmSound);
    const setAlarmSound = useAlarmStore((state) => state.setAlarmSound);
    const soundEnabled = useAlarmStore((state) => state.soundEnabled);
    const setSoundEnabled = useAlarmStore((state) => state.setSoundEnabled);

    const { results, loadingMap, refreshingMap, refetchAll, refetchOne } =
        useWidgetApiData(dashboardWidgets);

    // Phase 2 / Step 2c-A: BE 가 알람 평가의 단일 출처다. FE 가 같은 데이터를
    // 다시 평가하지 않고, /dashboard/alerts/active 폴링 결과를 widget id 로
    // 매핑해 alarmStore 에 동기화한다. ServerResourceCard / NetworkTestCard 가
    // 자체 onAlarmChange 콜백으로 보내는 즉각 신호는 그대로 두지만 (probe
    // 수준 fail 표시), 임계치/criteria 기반 평가는 모두 BE 로 이전됐다.

    // endpoint 카탈로그: widget.endpoint → api id 매핑에 필요
    useEffect(() => {
        let cancelled = false;
        (async () => {
            try {
                const list = await dashboardService.getApiEndpoints();
                if (cancelled) return;
                setEndpointCatalog(Array.isArray(list) ? list : []);
            } catch {
                if (!cancelled) setEndpointCatalog([]);
            }
        })();
        return () => { cancelled = true; };
    }, []);

    // widget_configs 카탈로그 — 운영자가 ConfigEditorPage 에서 저장하면 다음
    // 폴링에서 반영된다. 60s 주기로 부담 작게 유지.
    useEffect(() => {
        let cancelled = false;
        const tick = async () => {
            try {
                const data = await widgetConfigService.list();
                if (cancelled) return;
                setWidgetConfigs(Array.isArray(data?.configs) ? data.configs : []);
            } catch {
                /* swallow — keep last known config */
            }
        };
        tick();
        const id = setInterval(tick, 60_000);
        return () => { cancelled = true; clearInterval(id); };
    }, []);

    // active alerts 폴링 (5초)
    useEffect(() => {
        let cancelled = false;
        const tick = async () => {
            try {
                const data = await alertService.listActive();
                if (cancelled) return;
                const items = Array.isArray(data?.items) ? data.items : [];
                const ids = computeAlarmedWidgets({
                    activeAlerts: items,
                    widgets: dashboardWidgets,
                    endpointCatalog,
                });
                syncAlarmedWidgets(ids);
            } catch {
                /* swallow — keep last known state */
            }
        };
        tick();
        const handle = setInterval(tick, 5000);
        return () => {
            cancelled = true;
            clearInterval(handle);
        };
    }, [dashboardWidgets, endpointCatalog, syncAlarmedWidgets]);

    // Memoised so the responsiveLayouts object below stays stable across
    // re-renders that don't touch the widget set or saved layout map (the
    // common case — polling results updating). `layouts` only changes
    // when the user finishes a drag/resize (onDragStop/onResizeStop), so
    // the dep array hits in steady state.
    const gridLayout = useMemo(
        () => dashboardWidgets.map((widget) =>
            normalizeWidgetLayout(widget, layouts[widget.id]),
        ),
        [dashboardWidgets, layouts],
    );

    // ResponsiveGridLayout does shallow-equals on `layouts`; rebuilding the
    // {lg, md, sm, xs, xxs} object every render forced an internal layout
    // recomputation against 30+ children even when nothing visible changed.
    const responsiveLayouts = useMemo(
        () => ({
            lg: gridLayout,
            md: gridLayout,
            sm: gridLayout,
            xs: gridLayout,
            xxs: gridLayout,
        }),
        [gridLayout],
    );

    const handleLogout = () => {
        disableServerSync();
        logout();
        navigate("/login");
    };

    const handleRemoveApi = (apiId) => {
        reportWidgetStatus(apiId, "live");
        removeWidget(apiId);
    };

    const handleAddApi = () => {
        if (!newApiForm.title.trim()) {
            return;
        }

        const isStatusListWidget = newApiForm.type === WIDGET_TYPE_STATUS_LIST;
        const isNetworkTestWidget = newApiForm.type === WIDGET_TYPE_NETWORK_TEST;
        const isServerResourceWidget =
            newApiForm.type === WIDGET_TYPE_SERVER_RESOURCE;
        const needsEndpoint =
            !isStatusListWidget && !isNetworkTestWidget && !isServerResourceWidget;
        if (needsEndpoint && !newApiForm.endpoint.trim()) {
            return;
        }

        // 모니터 대상에 의존하는 위젯은 등록된 대상을 1개 이상 선택해야 한다.
        // (status-list 도 이제 http_status 모니터 대상에서 골라 추가하는 구조다.)
        const selectedTargetIds = Array.isArray(newApiForm.targetIds)
            ? newApiForm.targetIds.filter(Boolean)
            : [];
        if (
            (isServerResourceWidget ||
                isNetworkTestWidget ||
                isStatusListWidget) &&
            selectedTargetIds.length === 0
        ) {
            return;
        }

        // Date.now() alone collides on rapid double-click — append a small
        // random tail to keep ids unique within the same millisecond.
        const widgetId = `api-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
        const nextLayout = {
            ...DEFAULT_WIDGET_LAYOUT,
            y: dashboardWidgets.length * 4,
        };
        const isChartType =
            newApiForm.type === "line-chart" ||
            newApiForm.type === "bar-chart";
        // table / status-list / server-resource 는 정보 밀도 위주의 표 형태
        // 위젯이므로 신규 생성 시 dataFontSize 를 10 으로 시드한다.
        // chart / network-test 는 전역 widgetFontSize 상속.
        const seedSmallFont =
            newApiForm.type === WIDGET_TYPE_TABLE ||
            isStatusListWidget ||
            isServerResourceWidget;
        const newWidget = {
            id: widgetId,
            type: newApiForm.type,
            title: newApiForm.title.trim(),
            endpoint: needsEndpoint
                ? normalizeUserEndpoint(
                      newApiForm.endpoint.trim(),
                      rememberedApiBaseUrl,
                  )
                : undefined,
            defaultLayout: nextLayout,
            refreshIntervalSec: DEFAULT_REFRESH_INTERVAL_SEC,
            dataFontSize: seedSmallFont
                ? DEFAULT_DATA_WIDGET_FONT_SIZE
                : undefined,
            // status-list 위젯은 등록된 http_status 모니터 대상 id 목록을 보유한다.
            // (BE 가 주기적으로 폴링한 결과를 monitor-snapshot 으로 가져온다.)
            targetIds: isStatusListWidget ? selectedTargetIds : undefined,
            tableSettings:
                newApiForm.type === WIDGET_TYPE_TABLE
                    ? { visibleColumns: [], columnWidths: {}, criteria: {} }
                    : undefined,
            chartSettings: isChartType
                ? {
                      xAxisKey: "",
                      yAxisKeys: [],
                      timeRange: "all",
                      orientation: "vertical",
                  }
                : undefined,
            serverConfig: isServerResourceWidget
                ? { targetIds: selectedTargetIds }
                : undefined,
            networkConfig: isNetworkTestWidget
                ? { targetIds: selectedTargetIds }
                : undefined,
        };

        addWidget(newWidget);
        saveLayout(widgetId, nextLayout);
        setNewApiForm({
            title: "",
            endpoint: "",
            type: WIDGET_TYPE_TABLE,
            targetIds: [],
        });
        setShowAddApi(false);
    };

    const handleWidgetMetaChange = (apiId, updates) => {
        const targetWidget = dashboardWidgets.find(
            (widget) => widget.id === apiId,
        );
        if (!targetWidget || !updates) {
            return;
        }

        // 임의 필드(dataFontSize 등)는 그대로 통과시키되, title/endpoint 는
        // 명시적으로 변경 요청된 경우에만 검증/정규화. 이전 코드는 항상 title
        // 만 뽑아 forward 해 dataFontSize 같은 patch 가 store 에 도달하지 못했다.
        const patch = { ...updates };

        if (Object.prototype.hasOwnProperty.call(updates, "title")) {
            const nextTitle = String(updates.title ?? "").trim();
            if (!nextTitle) return;
            patch.title = nextTitle;
        }

        if (Object.prototype.hasOwnProperty.call(updates, "endpoint")) {
            // endpoint 가 없는 위젯 타입은 무시
            if (
                targetWidget.type === WIDGET_TYPE_STATUS_LIST ||
                targetWidget.type === WIDGET_TYPE_NETWORK_TEST ||
                targetWidget.type === WIDGET_TYPE_SERVER_RESOURCE
            ) {
                delete patch.endpoint;
            } else {
                const nextEndpoint = String(updates.endpoint ?? "").trim();
                if (!nextEndpoint) return;
                patch.endpoint = normalizeUserEndpoint(
                    nextEndpoint,
                    rememberedApiBaseUrl,
                );
            }
        }

        if (Object.keys(patch).length === 0) return;
        updateWidget(apiId, patch);
    };

    const handleStatusListTargetIdsChange = (apiId, targetIds) => {
        const sanitized = Array.isArray(targetIds)
            ? targetIds.filter(Boolean)
            : [];
        updateWidget(apiId, { targetIds: sanitized });
    };

    const isBackendManagedEndpoint = (endpointValue) => {
        if (!endpointValue) {
            return false;
        }

        try {
            const targetUrl = new URL(
                resolveEndpointWithBase(endpointValue, rememberedApiBaseUrl),
            );
            const baseUrl = new URL(rememberedApiBaseUrl);
            return (
                targetUrl.origin === baseUrl.origin &&
                targetUrl.pathname.startsWith("/api/")
            );
        } catch {
            return false;
        }
    };

    const handleManualRefresh = async (widget) => {
        if (
            widget?.type !== WIDGET_TYPE_STATUS_LIST &&
            isBackendManagedEndpoint(widget?.endpoint)
        ) {
            try {
                await dashboardService.refreshEndpointCache({
                    endpoint: widget.endpoint,
                    resetConnection: true,
                });
            } catch (error) {
                console.warn(
                    "Cache refresh failed before manual widget refresh",
                    error,
                );
            }
        }

        await refetchOne(widget.id);
    };

    const handleLayoutCommit = (nextLayout) => {
        const nextLayoutMap = layoutArrayToMap(nextLayout, layouts);
        saveLayouts({ ...layouts, ...nextLayoutMap });
    };

    const handleWidgetSizeChange = (apiId, nextWidth, nextHeight) => {
        const currentLayout =
            layouts[apiId] ??
            gridLayout.find((item) => item.i === apiId) ??
            DEFAULT_WIDGET_LAYOUT;

        const width = clampValue(
            nextWidth,
            currentLayout.minW ?? MIN_WIDGET_W,
            MAX_WIDGET_W,
            currentLayout.w,
        );
        const height = clampValue(
            nextHeight,
            currentLayout.minH ?? MIN_WIDGET_H,
            MAX_WIDGET_H,
            currentLayout.h,
        );

        saveLayout(apiId, {
            ...currentLayout,
            w: width,
            h: height,
        });
    };

    const handleRefreshIntervalChange = (apiId, intervalSec) => {
        // 위젯이 참조하는 endpoint / monitor target 의 BE 갱신 주기보다 작게
        // 설정하지 못하도록 floor 를 적용. 매칭되는 BE 정보가 없으면 floor=1
        // (전역 minimum). max(...) 의 의미: 같은 위젯이 여러 endpoint/target 을
        // 묶으면 가장 느린 BE 주기에 맞춰야 모두 cached 결과를 받게 된다.
        const widget = widgets?.find((w) => w.id === apiId);
        const beFloor = computeWidgetIntervalFloor(
            widget,
            beApiByPath,
            beIntervalsByTargetId,
        );
        const lowerBound = Math.max(1, Number.isFinite(beFloor) ? beFloor : 1);
        const normalizedInterval = clampValue(
            intervalSec,
            lowerBound,
            3600,
            Math.max(DEFAULT_REFRESH_INTERVAL_SEC, lowerBound),
        );

        updateWidget(apiId, {
            refreshIntervalSec: normalizedInterval,
        });
    };

    const handleTableSettingsChange = (apiId, nextSettings) => {
        updateWidget(apiId, {
            tableSettings: nextSettings,
        });
    };

    const handleChartSettingsChange = (apiId, nextSettings) => {
        updateWidget(apiId, {
            chartSettings: nextSettings,
        });
    };

    const handleApplyDashboardSettings = () => {
        const normalizedFontSize = clampValue(
            fontSizeDraft,
            MIN_WIDGET_FONT_SIZE,
            MAX_WIDGET_FONT_SIZE,
            DEFAULT_WIDGET_FONT_SIZE,
        );
        setFontSizeDraft(normalizedFontSize);
        setDashboardSettings({
            widgetFontSize: normalizedFontSize,
        });

        // 일괄 적용: 차트(LineChart/BarChart)는 recharts 축/범례 영역이라
        // 데이터 폰트 개념이 없으니 제외하고, 나머지 위젯의 dataFontSize 를
        // 일괄 override. user_preferences 의 widgets 배열로 자동 persist.
        const currentWidgets = widgets ?? [];
        if (currentWidgets.length === 0) return;
        const nextWidgets = currentWidgets.map((widget) => {
            if (
                widget.type === WIDGET_TYPE_LINE_CHART ||
                widget.type === WIDGET_TYPE_BAR_CHART
            ) {
                return widget;
            }
            if (widget.dataFontSize === normalizedFontSize) return widget;
            return { ...widget, dataFontSize: normalizedFontSize };
        });
        const changed = nextWidgets.some((w, i) => w !== currentWidgets[i]);
        if (changed) {
            setWidgets(nextWidgets);
        }
    };

    const handleApplyApiBaseUrl = async () => {
        const trimmed = apiBaseUrlDraft.trim().replace(/\/+$/, "");
        if (!trimmed) return;
        rememberApiBaseUrl(trimmed);
        setApiBaseUrlSaved(true);
        // Stop new debounced pushes from being scheduled, then flush whatever
        // is already in-flight so the user's most recent layout edits aren't
        // dropped by the impending page reload.
        try {
            disableServerSync();
            await flushPendingPush();
        } catch {
            // flushPendingPush already swallows network errors; reaching here
            // would mean a programming error — fall through and reload anyway
            // rather than trapping the user on the modal.
        }
        window.location.reload();
    };

    const handleExportConfig = () => {
        const exportedConfig = exportDashboardConfig();
        const prettyJson = JSON.stringify(exportedConfig, null, 2);
        setConfigJsonDraft(prettyJson);

        const blob = new Blob([prettyJson], { type: "application/json" });
        const objectUrl = URL.createObjectURL(blob);
        const anchor = document.createElement("a");
        anchor.href = objectUrl;
        anchor.download = `dashboard-config-${new Date().toISOString().slice(0, 19).replace(/:/g, "-")}.json`;
        document.body.appendChild(anchor);
        anchor.click();
        anchor.remove();
        URL.revokeObjectURL(objectUrl);
    };

    const handleImportConfigFromText = () => {
        try {
            const parsed = JSON.parse(configJsonDraft);
            importDashboardConfig(parsed);
            setConfigErrorMessage("");
            setShowDashboardSettings(false);
        } catch (error) {
            setConfigErrorMessage(
                error instanceof Error
                    ? error.message
                    : "설정 JSON 파싱에 실패했습니다.",
            );
        }
    };

    const handleConfigFileChange = (event) => {
        const file = event.target.files?.[0];
        if (!file) return;

        const reader = new FileReader();
        reader.onload = () => {
            const text = String(reader.result ?? "");
            setConfigJsonDraft(text);
        };
        reader.readAsText(file, "utf-8");
        event.target.value = "";
    };

    const handleApiBaseUrlDraftChange = (value) => {
        setApiBaseUrlDraft(value);
        setApiBaseUrlSaved(false);
    };

    const widgetFontSize =
        dashboardSettings?.widgetFontSize ?? DEFAULT_WIDGET_FONT_SIZE;

    return (
        <div className='dashboard-page'>
            <DashboardHeader
                widgetCount={dashboardWidgets.length}
                user={user}
                isAdmin={isAdmin}
                isFullscreen={isFullscreen}
                dashboardTitle={dashboardTitle}
                onToggleFullscreen={handleToggleFullscreen}
                onOpenSettings={() => setShowDashboardSettings(true)}
                onOpenConfigEditor={() => navigate("/admin/config")}
                onOpenAddApi={() => setShowAddApi(true)}
                onOpenUserManagement={() => navigate("/users")}
                onRefreshAll={() => refetchAll()}
                onOpenAlerts={() => navigate("/alerts")}
                onLogout={handleLogout}
            />

            {showAddApi && (
                <AddApiModal
                    form={newApiForm}
                    onChange={setNewApiForm}
                    onSubmit={handleAddApi}
                    onClose={() => setShowAddApi(false)}
                    monitorTargets={monitorTargets}
                    monitorTargetsError={monitorTargetsError}
                />
            )}

            {showDashboardSettings && (
                <DashboardSettingsModal
                    onClose={() => setShowDashboardSettings(false)}
                    apiBaseUrlDraft={apiBaseUrlDraft}
                    apiBaseUrlSaved={apiBaseUrlSaved}
                    onApiBaseUrlDraftChange={handleApiBaseUrlDraftChange}
                    onApplyApiBaseUrl={handleApplyApiBaseUrl}
                    fontSizeDraft={fontSizeDraft}
                    onFontSizeDraftChange={setFontSizeDraft}
                    onApplyDashboardSettings={handleApplyDashboardSettings}
                    alarmSound={alarmSound}
                    soundEnabled={soundEnabled}
                    onSetAlarmSound={setAlarmSound}
                    onSetSoundEnabled={setSoundEnabled}
                    configJsonDraft={configJsonDraft}
                    onConfigJsonDraftChange={setConfigJsonDraft}
                    onConfigFileChange={handleConfigFileChange}
                    configErrorMessage={configErrorMessage}
                    onExportConfig={handleExportConfig}
                    onImportConfigFromText={handleImportConfigFromText}
                />
            )}

            {/* SQL 편집기는 백엔드 설정 → 위젯별 설정 → 데이터 API row 의
                ✏️ 버튼으로 진입한다 (요구 ②). DashboardPage 가 직접 마운트하지
                않는다 — Suspense + lazy 도 ConfigEditorPage 안으로 이전. */}

            <div className='dashboard-content-wrapper'>
                <div className={`dashboard-content${tm.enabled ? " dashboard-content-tm" : ""}`}>
                    {dashboardWidgets.length === 0 ? (
                        <div className='empty-state'>
                            <div className='empty-icon'>📭</div>
                            <h2>위젯을 추가하세요</h2>
                            <p>
                                모니터링할 데이터 API · 서버 리소스 · 네트워크 체크
                                위젯을 추가하여 대시보드를 시작합니다.
                            </p>
                            <button
                                className='primary-btn'
                                onClick={() => setShowAddApi(true)}
                            >
                                위젯 추가
                            </button>
                        </div>
                    ) : (
                        <ResponsiveGridLayout
                            className='api-grid'
                            layouts={responsiveLayouts}
                            breakpoints={{
                                lg: 1200,
                                md: 996,
                                sm: 768,
                                xs: 480,
                                xxs: 0,
                            }}
                            cols={{
                                lg: GRID_COLUMNS,
                                md: 20,
                                sm: 12,
                                xs: 8,
                                xxs: 4,
                            }}
                            rowHeight={56}
                            margin={[20, 20]}
                            containerPadding={[0, 0]}
                            draggableHandle='.api-card-header'
                            resizeHandles={["se"]}
                            isDraggable
                            isResizable
                            onDragStop={handleLayoutCommit}
                            onResizeStop={handleLayoutCommit}
                        >
                            {dashboardWidgets.map((widget) => {
                                const apiResult = results[widget.id];
                                const apiData = apiResult?.data ?? null;
                                const apiError = apiResult?.error;
                                const apiStatus = apiResult?.status ?? "loading";
                                const isLoading =
                                    !!loadingMap[widget.id] && !apiData;
                                const isRefreshing =
                                    !!refreshingMap[widget.id];
                                const currentLayout =
                                    layouts[widget.id] ??
                                    gridLayout.find(
                                        (item) => item.i === widget.id,
                                    );

                                const isWidgetAlarming =
                                    alarmedWidgets.has(widget.id);

                                return (
                                    <div
                                        key={widget.id}
                                        className={`grid-item${isWidgetAlarming ? " widget-alarming" : ""}`}
                                    >
                                        <WidgetRenderer
                                            widget={widget}
                                            currentLayout={currentLayout}
                                            apiData={apiData}
                                            apiError={apiError}
                                            apiStatus={apiStatus}
                                            isLoading={isLoading}
                                            isRefreshing={isRefreshing}
                                            // 위젯별 override 가 있으면 그 값을, 없으면 dashboardSettings 의 글로벌
                                            // 값을 사용. 두 설정 다 user_preferences DB 에 저장됨.
                                            widgetFontSize={widget.dataFontSize ?? widgetFontSize}
                                            onRemoveApi={handleRemoveApi}
                                            onManualRefresh={handleManualRefresh}
                                            onRefetchOne={refetchOne}
                                            onWidgetSizeChange={
                                                handleWidgetSizeChange
                                            }
                                            onRefreshIntervalChange={
                                                handleRefreshIntervalChange
                                            }
                                            onWidgetMetaChange={
                                                handleWidgetMetaChange
                                            }
                                            onTableSettingsChange={
                                                handleTableSettingsChange
                                            }
                                            onChartSettingsChange={
                                                handleChartSettingsChange
                                            }
                                            onStatusListTargetIdsChange={
                                                handleStatusListTargetIdsChange
                                            }
                                            onUpdateWidget={updateWidget}
                                            onReportWidgetStatus={
                                                reportWidgetStatus
                                            }
                                        />
                                    </div>
                                );
                            })}
                        </ResponsiveGridLayout>
                    )}
                </div>
            </div>

            <AlarmBanner />

            <TimemachineControlBar />

            <footer className='dashboard-footer'>
                {!tm.enabled && (
                    <button
                        type="button"
                        className="footer-tm-btn"
                        onClick={() => tm.enable()}
                        title="타임머신 모드 진입"
                        aria-label="타임머신 모드 진입"
                    >
                        <IconHistory size={14} />
                    </button>
                )}
                <span className='footer-copyright'>
                    Copyright © {CURRENT_YEAR} {companyName || COMPANY_NAME}. All rights
                    reserved.
                </span>
                {/* monigrid_settings_kv.version 을 application 버전으로 표시.
                    backend.config.version 이 KV 우선 + build-time __version__ fallback. */}
                {backendVersion && (
                    <span className='footer-version'>v{backendVersion}</span>
                )}
            </footer>
        </div>
    );
};

export default function DashboardPage() {
    return (
        <TimemachineProvider>
            <DashboardPageInner />
        </TimemachineProvider>
    );
}
