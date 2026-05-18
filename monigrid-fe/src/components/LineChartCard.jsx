import { IconClose, IconRefresh, IconSettings } from "./icons";
import { formatInterval } from "./widgetUtils.js";
import {
    useLineChartSettings,
    TIME_RANGES,
} from "../hooks/useLineChartSettings.js";
import LineChartSettingsModal from "./LineChartSettingsModal.jsx";
import LineChartBody from "./LineChartBody.jsx";
import { DEFAULT_REFRESH_INTERVAL_SEC } from "../pages/dashboardConstants";
import "./ApiCard.css";
import "./LineChartCard.css";

/**
 * LineChartCard — composes header / settings modal / chart body.
 *
 * Mirror of BarChartCard's split. State + derived data live in
 * `useLineChartSettings`; modal JSX in `LineChartSettingsModal`; chart
 * rendering in `LineChartBody`. Header keeps the time-range buttons inline
 * because they're used frequently enough that hiding them behind the
 * settings modal would be a UX regression.
 */
const LineChartCard = ({
    title,
    endpoint,
    data,
    loading,
    error,
    apiStatus,
    onRemove,
    onRefresh,
    refreshIntervalSec,
    onRefreshIntervalChange,
    onWidgetMetaChange,
    currentSize,
    sizeBounds,
    onSizeChange,
    chartSettings,
    onChartSettingsChange,
}) => {
    const settings = useLineChartSettings({
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
    });

    const {
        showSettings,
        setShowSettings,
        statusLabel,
        lastUpdatedAt,
        timeRange,
        handleTimeRangeChange,
    } = settings;

    // LineChartSettingsModal renders nothing when showSettings is false; the
    // shared WidgetSettingsModal wrapper handles open/close + portal.

    return (
        <div className='lc-card'>
            {/* Header */}
            <div className='api-card-header lc-header'>
                <div className='api-card-title-section'>
                    <div className='api-card-title-row'>
                        <h4 title={title}>{title}</h4>
                        <span className={`status-pill ${statusLabel}`}>
                            <span className='status-dot' />
                            {statusLabel === "loading"
                                ? "..."
                                : statusLabel === "dead"
                                  ? "DEAD"
                                  : statusLabel === "slow-live"
                                    ? "SLOW"
                                    : "LIVE"}
                        </span>
                        <div className='lc-time-ranges'>
                            {TIME_RANGES.map((r) => (
                                <button
                                    key={r.key}
                                    className={`lc-range-btn${timeRange === r.key ? " active" : ""}`}
                                    onClick={() => handleTimeRangeChange(r.key)}
                                >
                                    {r.label}
                                </button>
                            ))}
                        </div>
                        <div className='title-actions'>
                            <button
                                type='button'
                                className='compact-icon-btn'
                                onClick={(event) => {
                                    event.stopPropagation();
                                    onRefresh();
                                }}
                                title='새로고침'
                            >
                                <IconRefresh size={14} />
                            </button>
                            <button
                                type='button'
                                className='compact-icon-btn'
                                onClick={(event) => {
                                    event.stopPropagation();
                                    setShowSettings((v) => !v);
                                }}
                               
                                title='설정'
                            >
                                <IconSettings size={14} />
                            </button>
                            <button
                                type='button'
                                className='compact-icon-btn remove'
                                onClick={(event) => {
                                    event.stopPropagation();
                                    onRemove();
                                }}
                               
                                title='삭제'
                            >
                                <IconClose size={14} />
                            </button>
                        </div>
                    </div>
                    <div className='api-endpoint-row'>
                        <div className='api-endpoint-info'>
                            <span className='api-endpoint'>{endpoint}</span>
                            <span className='refresh-interval-chip'>
                                ⏱ {formatInterval(refreshIntervalSec ?? DEFAULT_REFRESH_INTERVAL_SEC)}
                            </span>
                        </div>
                        {lastUpdatedAt && (
                            <span className='last-updated-time'>
                                {lastUpdatedAt.toLocaleTimeString("en-GB", {
                                    hour12: false,
                                })}
                            </span>
                        )}
                    </div>
                </div>
            </div>

            <LineChartSettingsModal
                title={title}
                sizeBounds={sizeBounds}
                settings={settings}
            />

            {/* Chart body */}
            <div className='lc-body'>
                <LineChartBody
                    error={error}
                    loading={loading}
                    settings={settings}
                    chartSettings={chartSettings}
                />
            </div>
        </div>
    );
};

export default LineChartCard;
