import { useEffect, useMemo, useState } from "react";
import {
    DEFAULT_REFRESH_INTERVAL_SEC,
    MAX_REFRESH_INTERVAL_SEC,
    MAX_WIDGET_H,
    MAX_WIDGET_W,
    MIN_REFRESH_INTERVAL_SEC,
    MIN_WIDGET_H,
    MIN_WIDGET_W,
} from "../pages/dashboardConstants";
import { normalizeChartData } from "../components/widgetUtils.js";
import { normalizeThresholds } from "../utils/chartThresholds.js";

/**
 * useBarChartSettings (SRP).
 *
 * Owns every piece of mutable state that BarChartCard needs to render its
 * settings modal *and* its chart body — drafts (titleDraft/endpointDraft/…),
 * persistent values pulled out of `chartSettings`, derived collections
 * (rows / chartRows / detectedColumns / labelToIndex), and the
 * `handleApplySettings` callback that flushes drafts back to the parent.
 *
 * Why a hook instead of inlining: the original BarChartCard kept ~16 useState
 * hooks plus their useEffects and a 60-line apply handler interleaved with
 * 850 lines of JSX. Extracting the data layer keeps the JSX file focused on
 * presentation and lets the chart body and the settings modal share derived
 * data without redoing the work.
 */

// 개별 Cell 컬러링을 적용할 최대 row 수 — 초과 시 단일 색상으로 전환
const CELL_COLOR_THRESHOLD = 30;
// 애니메이션을 비활성화할 최대 row 수
const ANIMATION_THRESHOLD = 100;
// 기본 최대 표시 막대 수
const MAX_BARS_DEFAULT = 200;

const detectColumns = (rows) => {
    const cols = new Set();
    rows.slice(0, 20).forEach((r) => {
        if (r && typeof r === "object") {
            Object.keys(r)
                .filter((k) => !k.startsWith("_"))
                .forEach((k) => cols.add(k));
        }
    });
    return Array.from(cols);
};

export const useBarChartSettings = ({
    title,
    endpoint,
    data,
    apiStatus,
    loading,
    refreshIntervalSec,
    currentSize,
    sizeBounds,
    chartSettings,
    onChartSettingsChange,
    onWidgetMetaChange,
    onRefreshIntervalChange,
    onSizeChange,
}) => {
    const [showSettings, setShowSettings] = useState(false);
    const [lastUpdatedAt, setLastUpdatedAt] = useState(null);
    // "vertical" = 세로 막대(기본), "horizontal" = 가로 막대
    const [orientation, setOrientation] = useState(
        chartSettings?.orientation ?? "vertical",
    );
    const [xKeyDraft, setXKeyDraft] = useState(chartSettings?.xAxisKey ?? "");
    const [yKeysDraft, setYKeysDraft] = useState(
        chartSettings?.yAxisKeys ?? [],
    );
    const [titleDraft, setTitleDraft] = useState(title);
    const [endpointDraft, setEndpointDraft] = useState(endpoint);
    const [intervalDraft, setIntervalDraft] = useState(refreshIntervalSec ?? DEFAULT_REFRESH_INTERVAL_SEC);
    const [sizeDraft, setSizeDraft] = useState({
        w: currentSize?.w ?? 4,
        h: currentSize?.h ?? 4,
    });
    const [maxBars, setMaxBars] = useState(
        chartSettings?.maxBars ?? MAX_BARS_DEFAULT,
    );
    const [maxBarsDraft, setMaxBarsDraft] = useState(
        chartSettings?.maxBars ?? MAX_BARS_DEFAULT,
    );
    const [thresholdsDraft, setThresholdsDraft] = useState(() =>
        normalizeThresholds(chartSettings?.thresholds),
    );
    // recharts 3.8.1: <Cell>/activeBar 경로의 tooltip payload 가 첫 row 로 고정되는
    // 버그가 있어, 마우스 이동 이벤트에서 활성 index 를 직접 추적해
    // chartRows 로부터 올바른 row 를 룩업한다.
    const [activeIdx, setActiveIdx] = useState(null);

    // ── Sync drafts with prop changes ─────────────────────────────────────
    useEffect(() => setTitleDraft(title), [title]);
    useEffect(() => setEndpointDraft(endpoint), [endpoint]);
    useEffect(
        () => setIntervalDraft(refreshIntervalSec ?? DEFAULT_REFRESH_INTERVAL_SEC),
        [refreshIntervalSec],
    );
    useEffect(
        () => setSizeDraft({ w: currentSize?.w ?? 4, h: currentSize?.h ?? 4 }),
        [currentSize?.w, currentSize?.h],
    );
    useEffect(() => {
        if (chartSettings?.orientation)
            setOrientation(chartSettings.orientation);
    }, [chartSettings?.orientation]);
    useEffect(() => {
        if (chartSettings?.maxBars != null) {
            setMaxBars(chartSettings.maxBars);
            setMaxBarsDraft(chartSettings.maxBars);
        }
    }, [chartSettings?.maxBars]);
    useEffect(() => {
        setThresholdsDraft(normalizeThresholds(chartSettings?.thresholds));
    }, [chartSettings?.thresholds]);

    useEffect(() => {
        if (data != null) setLastUpdatedAt(new Date());
    }, [data]);

    // ── Derived data ──────────────────────────────────────────────────────
    const rows = useMemo(() => normalizeChartData(data), [data]);
    const detectedColumns = useMemo(() => detectColumns(rows), [rows]);

    // 최대 표시 개수 제한 — 초과분은 잘라내어 렌더링 부하 방지
    const chartRows = useMemo(
        () => (rows.length > maxBars ? rows.slice(0, maxBars) : rows),
        [rows, maxBars],
    );
    const truncated = rows.length > maxBars;

    const xAxisKey =
        chartSettings?.xAxisKey ||
        (detectedColumns.length > 0 ? detectedColumns[0] : "");
    const yAxisKeys =
        chartSettings?.yAxisKeys?.length > 0
            ? chartSettings.yAxisKeys
            : detectedColumns.filter((c) => c !== xAxisKey).slice(0, 4);

    // O(1) lookup for the tooltip path. Without this every mousemove ran
    // chartRows.findIndex(...) — at 60fps over a 1k-row chart that's 60k
    // string comparisons per second per visible chart.
    const labelToIndex = useMemo(() => {
        const map = new Map();
        if (!xAxisKey) return map;
        for (let i = 0; i < chartRows.length; i += 1) {
            const key = String(chartRows[i]?.[xAxisKey] ?? "");
            if (!map.has(key)) map.set(key, i);
        }
        return map;
    }, [chartRows, xAxisKey]);

    const isHorizontal = orientation === "horizontal";
    // recharts convention: layout="vertical" → horizontal bars,
    //                      layout="horizontal" → vertical bars
    const rechartsLayout = isHorizontal ? "vertical" : "horizontal";

    const statusLabel = loading
        ? "loading"
        : apiStatus === "dead"
          ? "dead"
          : apiStatus === "slow-live"
            ? "slow-live"
            : "live";

    const effectiveYKeys = yKeysDraft.length > 0 ? yKeysDraft : yAxisKeys;

    const singleYMode = yAxisKeys.length === 1;
    // 대량 데이터에서 개별 Cell 컬러링은 수백 개의 React 컴포넌트를 생성하므로
    // 임계값 초과 시 단일 색상으로 전환
    const useCellColors =
        singleYMode && chartRows.length <= CELL_COLOR_THRESHOLD;
    // 대량 데이터에서 입장/퇴장 애니메이션은 렌더링 비용이 높으므로 비활성화
    const animationActive = chartRows.length <= ANIMATION_THRESHOLD;

    const activeThresholds = useMemo(
        () =>
            (chartSettings?.thresholds ?? []).filter(
                (t) =>
                    t?.enabled !== false &&
                    t?.key &&
                    Number.isFinite(Number(t?.value)),
            ),
        [chartSettings?.thresholds],
    );

    // ── Handlers ──────────────────────────────────────────────────────────
    const toggleYKey = (col) => {
        setYKeysDraft((prev) =>
            prev.includes(col) ? prev.filter((c) => c !== col) : [...prev, col],
        );
    };

    const addThreshold = () => {
        const firstKey = effectiveYKeys[0] || yAxisKeys[0] || "";
        setThresholdsDraft((prev) => [
            ...prev,
            {
                key: firstKey,
                operator: ">=",
                value: "",
                enabled: true,
                label: "",
            },
        ]);
    };

    const updateThreshold = (index, patch) => {
        setThresholdsDraft((prev) =>
            prev.map((t, i) => (i === index ? { ...t, ...patch } : t)),
        );
    };

    const removeThreshold = (index) => {
        setThresholdsDraft((prev) => prev.filter((_, i) => i !== index));
    };

    const handleApplySettings = () => {
        const resolvedX = xKeyDraft || xAxisKey;
        const resolvedY =
            yKeysDraft.length > 0
                ? yKeysDraft
                : detectedColumns.filter((c) => c !== resolvedX).slice(0, 4);

        const clampedMaxBars = Math.min(
            5000,
            Math.max(10, Math.floor(Number(maxBarsDraft) || MAX_BARS_DEFAULT)),
        );
        setMaxBars(clampedMaxBars);
        setMaxBarsDraft(clampedMaxBars);

        const cleanThresholds = thresholdsDraft
            .map((t) => ({
                key: String(t.key || "").trim(),
                operator: t.operator || ">=",
                value: t.value === "" || t.value == null ? "" : Number(t.value),
                enabled: t.enabled !== false,
                label: (t.label || "").trim(),
            }))
            .filter(
                (t) =>
                    t.key && Number.isFinite(Number(t.value)) && t.value !== "",
            );

        onChartSettingsChange?.({
            xAxisKey: resolvedX,
            yAxisKeys: resolvedY,
            orientation,
            maxBars: clampedMaxBars,
            thresholds: cleanThresholds,
        });

        const metaPatch = {};
        if (titleDraft.trim() && titleDraft.trim() !== title) {
            metaPatch.title = titleDraft.trim();
        }
        if (endpointDraft.trim() && endpointDraft.trim() !== endpoint) {
            metaPatch.endpoint = endpointDraft.trim();
        }
        if (Object.keys(metaPatch).length > 0) {
            onWidgetMetaChange?.(metaPatch);
        }

        const nextInterval = Math.min(
            MAX_REFRESH_INTERVAL_SEC,
            Math.max(
                MIN_REFRESH_INTERVAL_SEC,
                Number(intervalDraft) || MIN_REFRESH_INTERVAL_SEC,
            ),
        );
        setIntervalDraft(nextInterval);
        onRefreshIntervalChange?.(nextInterval);

        const minW = sizeBounds?.minW ?? MIN_WIDGET_W;
        const maxW = sizeBounds?.maxW ?? MAX_WIDGET_W;
        const minH = sizeBounds?.minH ?? MIN_WIDGET_H;
        const maxH = sizeBounds?.maxH ?? MAX_WIDGET_H;
        const nw = Math.min(
            maxW,
            Math.max(minW, Math.floor(Number(sizeDraft.w) || minW)),
        );
        const nh = Math.min(
            maxH,
            Math.max(minH, Math.floor(Number(sizeDraft.h) || minH)),
        );
        setSizeDraft({ w: nw, h: nh });
        onSizeChange?.(nw, nh);

        setShowSettings(false);
    };

    return {
        // Drafts + setters
        showSettings,
        setShowSettings,
        titleDraft,
        setTitleDraft,
        endpointDraft,
        setEndpointDraft,
        intervalDraft,
        setIntervalDraft,
        sizeDraft,
        setSizeDraft,
        orientation,
        setOrientation,
        xKeyDraft,
        setXKeyDraft,
        yKeysDraft,
        setYKeysDraft,
        maxBars,
        maxBarsDraft,
        setMaxBarsDraft,
        thresholdsDraft,
        setThresholdsDraft,
        activeIdx,
        setActiveIdx,
        // Derived
        lastUpdatedAt,
        rows,
        chartRows,
        truncated,
        detectedColumns,
        xAxisKey,
        yAxisKeys,
        effectiveYKeys,
        labelToIndex,
        isHorizontal,
        rechartsLayout,
        statusLabel,
        singleYMode,
        useCellColors,
        animationActive,
        activeThresholds,
        // Handlers
        handleApplySettings,
        toggleYKey,
        addThreshold,
        updateThreshold,
        removeThreshold,
    };
};
