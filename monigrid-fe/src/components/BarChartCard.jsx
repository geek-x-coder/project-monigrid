import { IconClose, IconRefresh, IconSettings } from "./icons";
import { formatInterval } from "./widgetUtils.js";
import { useBarChartSettings } from "../hooks/useBarChartSettings.js";
import BarChartSettingsModal from "./BarChartSettingsModal.jsx";
import BarChartBody from "./BarChartBody.jsx";
import { DEFAULT_REFRESH_INTERVAL_SEC } from "../pages/dashboardConstants";
import "./ApiCard.css";
import "./BarChartCard.css";

/**
 * BarChartCard — composes header / settings modal / chart body.
 *
 * State + derived data live in `useBarChartSettings`; modal JSX in
 * `BarChartSettingsModal`; chart rendering in `BarChartBody`. This file
 * stays thin so it's easy to scan for layout changes (header buttons,
 * orientation toggle) without scrolling past hundreds of lines of recharts
 * configuration.
 */
const BarChartCard = ({
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
    const settings = useBarChartSettings({
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
        isHorizontal,
        setOrientation,
    } = settings;

    // BarChartSettingsModal renders nothing when showSettings is false, so we
    // render it unconditionally and let the shared WidgetSettingsModal wrapper
    // handle the open/close + portal mounting.

    return (
        <div className='bc-card'>
            {/* Header */}
            <div className='api-card-header bc-header'>
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
                        <div className='title-actions'>
                            <button
                                type='button'
                                className='compact-icon-btn'
                                title={
                                    isHorizontal
                                        ? "가로 막대 (클릭: 세로 전환)"
                                        : "세로 막대 (클릭: 가로 전환)"
                                }
                                onClick={(event) => {
                                    event.stopPropagation();
                                    const next = isHorizontal
                                        ? "vertical"
                                        : "horizontal";
                                    setOrientation(next);
                                    onChartSettingsChange?.({
                                        orientation: next,
                                    });
                                }}
                            >
                                <span
                                    className={`bc-orient-icon${isHorizontal ? "" : " rotated"}`}
                                >
                                    ≡
                                </span>
                            </button>
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

            <BarChartSettingsModal
                title={title}
                sizeBounds={sizeBounds}
                settings={settings}
            />

            {/* Chart body */}
            <div className='bc-body'>
                <BarChartBody
                    error={error}
                    loading={loading}
                    settings={settings}
                />
            </div>
        </div>
    );
};

export default BarChartCard;
