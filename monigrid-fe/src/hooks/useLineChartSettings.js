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
 * useLineChartSettings (SRP).
 *
 * Mirror of useBarChartSettings for the line-chart variant: owns drafts,
 * derived rows (filtered + downsampled), threshold management, and the
 * apply-handler that flushes drafts to the parent. Lets LineChartCard,
 * its settings modal, and its chart body share one source of truth.
 */

export const MAX_CHART_POINTS = 500;

export const TIME_RANGES = [
    { label: "전체", key: "all" },
    { label: "1h", key: "1h" },
    { label: "6h", key: "6h" },
    { label: "24h", key: "24h" },
    { label: "7d", key: "7d" },
];

const TIME_RANGE_MS = {
    "1h": 60 * 60 * 1000,
    "6h": 6 * 60 * 60 * 1000,
    "24h": 24 * 60 * 60 * 1000,
    "7d": 7 * 24 * 60 * 60 * 1000,
};

const tryParseDate = (val) => {
    if (val == null || val === "") return null;
    const d = new Date(val);
    return isNaN(d.getTime()) ? null : d;
};

const filterByTimeRange = (rows, xKey, rangeKey) => {
    if (rangeKey === "all" || !xKey || !rows.length) return rows;
    const rangeMs = TIME_RANGE_MS[rangeKey];
    if (!rangeMs) return rows;

    const sample = rows.slice(0, Math.min(10, rows.length));
    const parseableCount = sample.filter(
        (r) => tryParseDate(r[xKey]) !== null,
    ).length;

    if (parseableCount / Math.max(sample.length, 1) >= 0.5) {
        const cutoff = Date.now() - rangeMs;
        return rows.filter((r) => {
            const d = tryParseDate(r[xKey]);
            return d !== null && d.getTime() >= cutoff;
        });
    }

    const rowCounts = { "1h": 60, "6h": 360, "24h": 720, "7d": 2016 };
    const n = rowCounts[rangeKey] ?? rows.length;
    return rows.slice(-n);
};

const downsample = (rows, maxPoints) => {
    if (rows.length <= maxPoints) return rows;
    // Filter out null/undefined slots first so they don't end up in the
    // sampled output as gaps in the line. Math.floor() (instead of round())
    // also stops the same source index from being picked twice in a row.
    const valid = [];
    for (let i = 0; i < rows.length; i += 1) {
        if (rows[i] != null) valid.push(rows[i]);
    }
    if (valid.length <= maxPoints) return valid;
    const step = valid.length / maxPoints;
    const result = new Array(maxPoints);
    for (let i = 0; i < maxPoints; i += 1) {
        const idx = Math.min(valid.length - 1, Math.floor(i * step));
        result[i] = valid[idx];
    }
    return result;
};

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

export const useLineChartSettings = ({
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
    const [timeRange, setTimeRange] = useState(
        chartSettings?.timeRange ?? "all",
    );
    const [xKeyDraft, setXKeyDraft] = useState(chartSettings?.xAxisKey ?? "");
    const [yKeysDraft, setYKeysDraft] = useState(
        chartSettings?.yAxisKeys ?? [],
    );
    const [showLegend, setShowLegend] = useState(
        chartSettings?.showLegend ?? true,
    );
    const [maxPointsDraft, setMaxPointsDraft] = useState(
        chartSettings?.maxPoints ?? MAX_CHART_POINTS,
    );
    const [titleDraft, setTitleDraft] = useState(title);
    const [endpointDraft, setEndpointDraft] = useState(endpoint);
    const [intervalDraft, setIntervalDraft] = useState(refreshIntervalSec ?? DEFAULT_REFRESH_INTERVAL_SEC);
    const [sizeDraft, setSizeDraft] = useState({
        w: currentSize?.w ?? 4,
        h: currentSize?.h ?? 4,
    });
    const [thresholdsDraft, setThresholdsDraft] = useState(() =>
        normalizeThresholds(chartSettings?.thresholds),
    );

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
        if (chartSettings?.timeRange) setTimeRange(chartSettings.timeRange);
    }, [chartSettings?.timeRange]);
    useEffect(() => {
        setShowLegend(chartSettings?.showLegend ?? true);
    }, [chartSettings?.showLegend]);
    useEffect(() => {
        setMaxPointsDraft(chartSettings?.maxPoints ?? MAX_CHART_POINTS);
    }, [chartSettings?.maxPoints]);
    useEffect(() => {
        setThresholdsDraft(normalizeThresholds(chartSettings?.thresholds));
    }, [chartSettings?.thresholds]);

    useEffect(() => {
        if (data != null) setLastUpdatedAt(new Date());
    }, [data]);

    // ── Derived data ──────────────────────────────────────────────────────
    const rows = useMemo(() => normalizeChartData(data), [data]);
    const detectedColumns = useMemo(() => detectColumns(rows), [rows]);

    const xAxisKey =
        chartSettings?.xAxisKey ||
        (detectedColumns.length > 0 ? detectedColumns[0] : "");
    const yAxisKeys =
        chartSettings?.yAxisKeys?.length > 0
            ? chartSettings.yAxisKeys
            : detectedColumns.filter((c) => c !== xAxisKey).slice(0, 4);

    const filteredRows = useMemo(
        () => filterByTimeRange(rows, xAxisKey, timeRange),
        [rows, xAxisKey, timeRange],
    );

    const effectiveMaxPoints = chartSettings?.maxPoints ?? MAX_CHART_POINTS;
    const chartRows = useMemo(
        () => downsample(filteredRows, effectiveMaxPoints),
        [filteredRows, effectiveMaxPoints],
    );
    const isDownsampled = chartRows.length < filteredRows.length;

    const statusLabel = loading
        ? "loading"
        : apiStatus === "dead"
          ? "dead"
          : apiStatus === "slow-live"
            ? "slow-live"
            : "live";

    const effectiveYKeys = yKeysDraft.length > 0 ? yKeysDraft : yAxisKeys;

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
    const handleTimeRangeChange = (key) => {
        setTimeRange(key);
        onChartSettingsChange?.({ timeRange: key });
    };

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

        const nextMaxPoints = Math.min(
            10000,
            Math.max(50, Number(maxPointsDraft) || MAX_CHART_POINTS),
        );
        setMaxPointsDraft(nextMaxPoints);

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
            timeRange,
            showLegend,
            maxPoints: nextMaxPoints,
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
        timeRange,
        setTimeRange,
        xKeyDraft,
        setXKeyDraft,
        yKeysDraft,
        setYKeysDraft,
        showLegend,
        setShowLegend,
        maxPointsDraft,
        setMaxPointsDraft,
        thresholdsDraft,
        setThresholdsDraft,
        // Derived
        lastUpdatedAt,
        rows,
        chartRows,
        filteredRows,
        isDownsampled,
        detectedColumns,
        xAxisKey,
        yAxisKeys,
        effectiveYKeys,
        statusLabel,
        activeThresholds,
        // Handlers
        handleApplySettings,
        handleTimeRangeChange,
        toggleYKey,
        addThreshold,
        updateThreshold,
        removeThreshold,
    };
};
