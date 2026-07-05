import { useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import {
    Area,
    AreaChart,
    Brush,
    CartesianGrid,
    ResponsiveContainer,
    Tooltip,
    XAxis,
    YAxis,
} from "recharts";
import {
    DETAIL_COLORS,
    MAX_HISTORY,
    formatChartTime,
} from "./serverResourceHelpers";
import { timemachineService } from "../services/api";
import { IconClose } from "./icons";

/**
 * Detail chart modal for a single server (SRP).
 *
 * Two data sources:
 *   - backend mode (sourceId present → snapshot-mode monitor target): fetches
 *     an aggregated numeric trend from the timemachine rollup API for the
 *     selected range (1h ~ 3개월). The server auto-picks raw vs 5-min rollup
 *     resolution, so the browser only needs to be open briefly to see months of
 *     history and zoom/pan into detail. avg line + min/max band per metric.
 *   - legacy mode (no sourceId): falls back to the in-memory `history` points
 *     accumulated while the tab was open (credentials-in-widget servers are not
 *     archived on the backend).
 */

const RANGES = [
    { key: "1h", label: "1시간", ms: 3600_000 },
    { key: "6h", label: "6시간", ms: 6 * 3600_000 },
    { key: "1d", label: "1일", ms: 24 * 3600_000 },
    { key: "1w", label: "1주", ms: 7 * 24 * 3600_000 },
    { key: "1M", label: "1개월", ms: 30 * 24 * 3600_000 },
    { key: "3M", label: "3개월", ms: 90 * 24 * 3600_000 },
];

// backend series {metric: [{ts,avg,min,max}]} → unified rows keyed by ts,
// normalising metric names to the legacy chart keys (cpu / memory / disk_*).
const buildRowsFromSeries = (series) => {
    if (!series || typeof series !== "object") return { data: [], diskKeys: [] };
    const byTs = new Map();
    const put = (metric, key) => {
        for (const p of series[metric] || []) {
            let row = byTs.get(p.ts);
            if (!row) {
                row = { ts: p.ts };
                byTs.set(p.ts, row);
            }
            row[key] = p.avg;
            row[`${key}Band`] =
                p.min != null && p.max != null ? [p.min, p.max] : undefined;
        }
    };
    put("cpu", "cpu");
    put("mem", "memory");
    const diskKeys = [];
    Object.keys(series)
        .filter((m) => m.startsWith("disk:"))
        .sort()
        .forEach((m) => {
            const key = `disk_${m.slice(5).toLowerCase()}`;
            diskKeys.push(key);
            put(m, key);
        });
    const data = [...byTs.values()].sort((a, b) => a.ts - b.ts);
    return { data, diskKeys };
};

// legacy in-memory points already use {ts, cpu, memory, disk_*}.
const buildRowsFromHistory = (history) => {
    const data = history || [];
    const keys = new Set();
    data.forEach((pt) =>
        Object.keys(pt).forEach((k) => {
            if (k.startsWith("disk_")) keys.add(k);
        }),
    );
    return { data, diskKeys: [...keys].sort() };
};

const DetailTooltip = ({ active, payload, label }) => {
    if (!active || !payload?.length) return null;
    // Only show avg lines in the tooltip (skip the *Band range areas).
    const rows = payload.filter((p) => !String(p.dataKey).endsWith("Band"));
    if (!rows.length) return null;
    return (
        <div className='srv-detail-tooltip'>
            <div className='srv-detail-tooltip-time'>{formatChartTime(label)}</div>
            {rows.map((p) => (
                <div key={p.dataKey} className='srv-detail-tooltip-row'>
                    <span
                        className='srv-detail-tooltip-dot'
                        style={{ backgroundColor: p.color }}
                    />
                    <span className='srv-detail-tooltip-name'>{p.name}</span>
                    <span className='srv-detail-tooltip-val'>
                        {p.value != null ? `${Number(p.value).toFixed(1)}%` : "-"}
                    </span>
                </div>
            ))}
        </div>
    );
};

const ServerDetailPopup = ({
    server,
    history,
    sourceId = null,
    sourceType = "monitor:server_resource",
    onClose,
}) => {
    const backendMode = !!sourceId;

    const [rangeKey, setRangeKey] = useState("1h");
    const [series, setSeries] = useState(null);
    const [resolution, setResolution] = useState(null);
    const [bucketMs, setBucketMs] = useState(0);
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState(null);

    useEffect(() => {
        if (!backendMode) return undefined;
        const range = RANGES.find((r) => r.key === rangeKey) || RANGES[0];
        const to = Date.now();
        const from = to - range.ms;
        const ac = new AbortController();
        let cancelled = false;
        setLoading(true);
        setError(null);
        timemachineService
            .queryRangeAgg(
                { sourceType, sourceId, from, to, maxPoints: 600 },
                { signal: ac.signal },
            )
            .then((res) => {
                if (cancelled) return;
                setSeries(res?.series || {});
                setResolution(res?.resolution || null);
                setBucketMs(Number(res?.bucketMs) || 0);
            })
            .catch((e) => {
                if (cancelled) return;
                if (e?.name === "CanceledError" || e?.name === "AbortError") return;
                setError(e?.response?.data?.message || e?.message || "추세 조회 실패");
                setSeries({});
            })
            .finally(() => {
                if (!cancelled) setLoading(false);
            });
        return () => {
            cancelled = true;
            ac.abort();
        };
    }, [backendMode, sourceId, sourceType, rangeKey]);

    const { data, diskKeys } = useMemo(
        () =>
            backendMode
                ? buildRowsFromSeries(series)
                : buildRowsFromHistory(history),
        [backendMode, series, history],
    );

    const latestData = data.length > 0 ? data[data.length - 1] : null;

    const diskLabels = useMemo(() => {
        const map = {};
        diskKeys.forEach((k) => {
            map[k] = k.replace("disk_", "").toUpperCase();
        });
        return map;
    }, [diskKeys]);

    const resolutionLabel = useMemo(() => {
        if (!backendMode) return null;
        if (resolution === "raw") return bucketMs > 0 ? `≈${Math.round(bucketMs / 1000)}초 평균` : "원시 (30초)";
        if (resolution === "rollup") {
            const min = Math.round(bucketMs / 60000);
            return min >= 60 ? `≈${Math.round(min / 60)}시간 평균` : `≈${min}분 평균`;
        }
        return null;
    }, [backendMode, resolution, bucketMs]);

    if (!server) return null;

    // Shared chart renderer for one metric group (avg lines + min/max bands).
    const renderChart = (height, lines) => (
        <ResponsiveContainer width='100%' height={height}>
            <AreaChart data={data} margin={{ top: 4, right: 8, bottom: 0, left: -12 }}>
                <defs>
                    {lines.map((l) => (
                        <linearGradient key={l.key} id={`grad-${l.key}`} x1='0' y1='0' x2='0' y2='1'>
                            <stop offset='5%' stopColor={l.color} stopOpacity={0.3} />
                            <stop offset='95%' stopColor={l.color} stopOpacity={0} />
                        </linearGradient>
                    ))}
                </defs>
                <CartesianGrid strokeDasharray='3 3' stroke='rgba(148,163,184,0.08)' />
                <XAxis
                    dataKey='ts'
                    type='number'
                    scale='time'
                    domain={["dataMin", "dataMax"]}
                    tickFormatter={formatChartTime}
                    tick={{ fontSize: 9, fill: "#64748b" }}
                />
                <YAxis domain={[0, 100]} tick={{ fontSize: 9, fill: "#64748b" }} tickFormatter={(v) => `${v}%`} />
                <Tooltip content={<DetailTooltip />} />
                {/* min/max band (drawn under the avg line) */}
                {lines.map((l) => (
                    <Area
                        key={`${l.key}-band`}
                        type='monotone'
                        dataKey={`${l.key}Band`}
                        name={`${l.name} 범위`}
                        stroke='none'
                        fill={l.color}
                        fillOpacity={0.12}
                        isAnimationActive={false}
                        connectNulls
                        legendType='none'
                    />
                ))}
                {/* avg line */}
                {lines.map((l) => (
                    <Area
                        key={l.key}
                        type='monotone'
                        dataKey={l.key}
                        name={l.name}
                        stroke={l.color}
                        fill={`url(#grad-${l.key})`}
                        strokeWidth={1.5}
                        dot={false}
                        isAnimationActive={false}
                        connectNulls
                    />
                ))}
                {data.length > 2 && (
                    <Brush
                        dataKey='ts'
                        height={14}
                        travellerWidth={8}
                        stroke='#475569'
                        fill='rgba(30,41,59,0.4)'
                        tickFormatter={formatChartTime}
                    />
                )}
            </AreaChart>
        </ResponsiveContainer>
    );

    return createPortal(
        <div className='row-detail-overlay'>
            <div className='srv-detail-popup'>
                <div className='row-detail-header'>
                    <div>
                        <h5>{server.label || server.host}</h5>
                        <p>
                            {server.host}
                            {server.port ? `:${server.port}` : ""}
                        </p>
                    </div>
                    <button type='button' className='close-settings-btn' onClick={onClose}>
                        <IconClose size={14} />
                    </button>
                </div>

                {backendMode && (
                    <div className='srv-detail-range-bar'>
                        <div className='srv-detail-range-btns'>
                            {RANGES.map((r) => (
                                <button
                                    key={r.key}
                                    type='button'
                                    className={`srv-detail-range-btn${r.key === rangeKey ? " active" : ""}`}
                                    onClick={() => setRangeKey(r.key)}
                                >
                                    {r.label}
                                </button>
                            ))}
                        </div>
                        {resolutionLabel && (
                            <span className='srv-detail-resolution'>{resolutionLabel}</span>
                        )}
                    </div>
                )}

                <div className='srv-detail-body'>
                    {loading && data.length === 0 ? (
                        <div className='srv-detail-empty'>추세 불러오는 중…</div>
                    ) : error ? (
                        <div className='srv-detail-empty srv-detail-error'>{error}</div>
                    ) : data.length === 0 ? (
                        <div className='srv-detail-empty'>이 구간에 데이터가 없습니다.</div>
                    ) : (
                        <>
                            {/* CPU */}
                            <div className='srv-detail-chart-section'>
                                <div className='srv-detail-chart-header'>
                                    <span className='srv-detail-chart-title' style={{ color: DETAIL_COLORS.cpu }}>CPU</span>
                                    {latestData?.cpu != null && (
                                        <span className='srv-detail-chart-current' style={{ color: DETAIL_COLORS.cpu }}>
                                            {Number(latestData.cpu).toFixed(1)}%
                                        </span>
                                    )}
                                </div>
                                <div className='srv-detail-chart-wrap'>
                                    {renderChart(130, [{ key: "cpu", name: "CPU", color: DETAIL_COLORS.cpu }])}
                                </div>
                            </div>

                            {/* Memory */}
                            <div className='srv-detail-chart-section'>
                                <div className='srv-detail-chart-header'>
                                    <span className='srv-detail-chart-title' style={{ color: DETAIL_COLORS.memory }}>MEMORY</span>
                                    {latestData?.memory != null && (
                                        <span className='srv-detail-chart-current' style={{ color: DETAIL_COLORS.memory }}>
                                            {Number(latestData.memory).toFixed(1)}%
                                        </span>
                                    )}
                                </div>
                                <div className='srv-detail-chart-wrap'>
                                    {renderChart(130, [{ key: "memory", name: "MEM", color: DETAIL_COLORS.memory }])}
                                </div>
                            </div>

                            {/* Disk(s) */}
                            {diskKeys.length > 0 && (
                                <div className='srv-detail-chart-section'>
                                    <div className='srv-detail-chart-header'>
                                        <span className='srv-detail-chart-title' style={{ color: DETAIL_COLORS.disk[0] }}>DISK</span>
                                        <span className='srv-detail-chart-current-multi'>
                                            {diskKeys.map((k, i) => (
                                                <span key={k} style={{ color: DETAIL_COLORS.disk[i % DETAIL_COLORS.disk.length] }}>
                                                    {diskLabels[k]}: {latestData?.[k] != null ? `${Number(latestData[k]).toFixed(1)}%` : "-"}
                                                </span>
                                            ))}
                                        </span>
                                    </div>
                                    <div className='srv-detail-chart-wrap'>
                                        {renderChart(
                                            diskKeys.length > 1 ? 160 : 130,
                                            diskKeys.map((k, i) => ({
                                                key: k,
                                                name: diskLabels[k],
                                                color: DETAIL_COLORS.disk[i % DETAIL_COLORS.disk.length],
                                            })),
                                        )}
                                    </div>
                                </div>
                            )}
                        </>
                    )}
                </div>

                <div className='row-detail-footer'>
                    {backendMode ? (
                        <span className='row-detail-live-indicator'>
                            <span className='live-dot' />
                            {loading ? "갱신 중…" : "저장된 추세"}
                        </span>
                    ) : (
                        <>
                            <span className='row-detail-live-indicator'>
                                <span className='live-dot' />
                                실시간 반영 중
                            </span>
                            <span className='srv-detail-points'>
                                {data.length} / {MAX_HISTORY} points
                            </span>
                        </>
                    )}
                </div>
            </div>
        </div>,
        document.body,
    );
};

export default ServerDetailPopup;
