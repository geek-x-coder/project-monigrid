import React, { useEffect, useMemo, useState } from "react";
import {
    DEFAULT_REFRESH_INTERVAL_SEC,
    DEFAULT_WIDGET_FONT_SIZE,
    MAX_REFRESH_INTERVAL_SEC,
    MAX_WIDGET_FONT_SIZE,
    MAX_WIDGET_H,
    MAX_WIDGET_W,
    MIN_REFRESH_INTERVAL_SEC,
    MIN_WIDGET_FONT_SIZE,
    MIN_WIDGET_H,
    MIN_WIDGET_W,
    SIZE_STEP,
} from "../pages/dashboardConstants";
import { IconClose, IconRefresh, IconSettings } from "./icons";
import { clamp, toGridSize, toUserSize } from "./widgetUtils.js";
import WidgetSettingsModal from "./WidgetSettingsModal.jsx";
import "./ApiCard.css";
import "./HealthCheckCard.css";

// Lifted out of HealthCheckCard so the draft state + sync effects only mount
// while the modal is open. With 30+ widgets on the dashboard, the previous
// design ran 4 useStates and 4 sync effects per card on every poll re-render
// even though no modal was visible.
const HealthCheckSettingsModal = ({
    open,
    onClose,
    title,
    endpoint,
    currentSize,
    sizeBounds,
    refreshIntervalSec,
    widgetFontSize,
    onSizeChange,
    onRefreshIntervalChange,
    onWidgetMetaChange,
}) => {
    const [sizeDraft, setSizeDraft] = useState({
        w: currentSize?.w ?? 4,
        h: currentSize?.h ?? 4,
    });
    const [intervalDraft, setIntervalDraft] = useState(refreshIntervalSec ?? DEFAULT_REFRESH_INTERVAL_SEC);
    const [titleDraft, setTitleDraft] = useState(title);
    const [endpointDraft, setEndpointDraft] = useState(endpoint);
    const [fontSizeDraft, setFontSizeDraft] = useState(
        widgetFontSize ?? DEFAULT_WIDGET_FONT_SIZE,
    );

    useEffect(() => {
        setSizeDraft({
            w: currentSize?.w ?? 4,
            h: currentSize?.h ?? 4,
        });
    }, [currentSize?.w, currentSize?.h]);

    useEffect(() => {
        setIntervalDraft(refreshIntervalSec ?? DEFAULT_REFRESH_INTERVAL_SEC);
    }, [refreshIntervalSec]);

    useEffect(() => {
        setTitleDraft(title);
    }, [title]);

    useEffect(() => {
        setEndpointDraft(endpoint);
    }, [endpoint]);

    useEffect(() => {
        setFontSizeDraft(widgetFontSize ?? DEFAULT_WIDGET_FONT_SIZE);
    }, [widgetFontSize]);

    const handleSizeApply = () => {
        const minW = sizeBounds?.minW ?? MIN_WIDGET_W;
        const maxW = sizeBounds?.maxW ?? MAX_WIDGET_W;
        const minH = sizeBounds?.minH ?? MIN_WIDGET_H;
        const maxH = sizeBounds?.maxH ?? MAX_WIDGET_H;

        const nextWidth = clamp(
            sizeDraft.w,
            minW,
            maxW,
            currentSize?.w ?? minW,
        );
        const nextHeight = clamp(
            sizeDraft.h,
            minH,
            maxH,
            currentSize?.h ?? minH,
        );

        setSizeDraft({ w: nextWidth, h: nextHeight });
        onSizeChange(nextWidth, nextHeight);
    };

    const handleIntervalApply = () => {
        const nextInterval = clamp(
            intervalDraft,
            MIN_REFRESH_INTERVAL_SEC,
            MAX_REFRESH_INTERVAL_SEC,
            MIN_REFRESH_INTERVAL_SEC,
        );
        setIntervalDraft(nextInterval);
        onRefreshIntervalChange(nextInterval);
    };

    const handleFontSizeApply = () => {
        const nextSize = clamp(
            fontSizeDraft,
            MIN_WIDGET_FONT_SIZE,
            MAX_WIDGET_FONT_SIZE,
            DEFAULT_WIDGET_FONT_SIZE,
        );
        setFontSizeDraft(nextSize);
        onWidgetMetaChange?.({ dataFontSize: nextSize });
    };

    const handleWidgetMetaApply = () => {
        const nextTitle = titleDraft.trim();
        const nextEndpoint = endpointDraft.trim();
        if (!nextTitle || !nextEndpoint) {
            return;
        }
        // 상위(DashboardPage)에서 resolveEndpointWithBase 정규화를 거치므로
        // 입력값이 prop과 동일해 보여도 항상 콜백을 호출해 변경을 보장한다.
        onWidgetMetaChange?.({
            title: nextTitle,
            endpoint: nextEndpoint,
        });
        onClose?.();
    };

    return (
        <WidgetSettingsModal
            open={open}
            onClose={onClose}
            title='위젯 설정'
            subtitle={title}
        >
            <div className='settings-section'>
                <h6>위젯 정보</h6>
                <div className='size-editor widget-meta-editor'>
                    <label>
                        Title
                        <input
                            type='text'
                            value={titleDraft}
                            onChange={(event) =>
                                setTitleDraft(event.target.value)
                            }
                        />
                    </label>
                    <label>
                        Endpoint
                        <input
                            type='text'
                            value={endpointDraft}
                            onChange={(event) =>
                                setEndpointDraft(event.target.value)
                            }
                        />
                    </label>
                    <button
                        type='button'
                        className='size-preset-btn'
                        onClick={handleWidgetMetaApply}
                    >
                        적용
                    </button>
                </div>
            </div>

            <div className='settings-section'>
                <h6>위젯 동작</h6>
                <div className='widget-action-row'>
                    <div className='widget-action-cell'>
                        <label>크기 (W × H)</label>
                        <div className='widget-action-size'>
                            <input
                                type='number'
                                min={toUserSize(sizeBounds?.minW ?? MIN_WIDGET_W)}
                                max={toUserSize(sizeBounds?.maxW ?? MAX_WIDGET_W)}
                                step={SIZE_STEP}
                                value={toUserSize(sizeDraft.w)}
                                onChange={(event) =>
                                    setSizeDraft((previousDraft) => ({
                                        ...previousDraft,
                                        w: toGridSize(event.target.value),
                                    }))
                                }
                            />
                            <span className='widget-action-size-sep'>×</span>
                            <input
                                type='number'
                                min={sizeBounds?.minH ?? MIN_WIDGET_H}
                                max={sizeBounds?.maxH ?? MAX_WIDGET_H}
                                value={sizeDraft.h}
                                onChange={(event) =>
                                    setSizeDraft((previousDraft) => ({
                                        ...previousDraft,
                                        h: event.target.value,
                                    }))
                                }
                            />
                        </div>
                    </div>
                    <div className='widget-action-cell'>
                        <label>체크 주기 (초)</label>
                        <input
                            type='number'
                            min={MIN_REFRESH_INTERVAL_SEC}
                            max={MAX_REFRESH_INTERVAL_SEC}
                            value={intervalDraft}
                            onChange={(event) =>
                                setIntervalDraft(event.target.value)
                            }
                        />
                    </div>
                    <div className='widget-action-cell'>
                        <label>폰트 크기 (px)</label>
                        <input
                            type='number'
                            min={MIN_WIDGET_FONT_SIZE}
                            max={MAX_WIDGET_FONT_SIZE}
                            value={fontSizeDraft}
                            onChange={(event) =>
                                setFontSizeDraft(event.target.value)
                            }
                        />
                    </div>
                    <button
                        type='button'
                        className='size-preset-btn'
                        onClick={() => {
                            handleSizeApply();
                            handleIntervalApply();
                            handleFontSizeApply();
                        }}
                    >
                        적용
                    </button>
                </div>
            </div>
        </WidgetSettingsModal>
    );
};

const HealthCheckCard = ({
    title,
    endpoint,
    healthData,
    loading,
    error,
    apiStatus,
    onRemove,
    onRefresh,
    currentSize,
    sizeBounds,
    onSizeChange,
    refreshIntervalSec,
    widgetFontSize,
    onRefreshIntervalChange,
    onWidgetMetaChange,
}) => {
    const [showSettings, setShowSettings] = useState(false);
    const [lastUpdatedAt, setLastUpdatedAt] = useState(null);

    useEffect(() => {
        if (healthData != null) {
            setLastUpdatedAt(new Date());
        }
    }, [healthData]);

    const formatInterval = (sec) => {
        if (sec >= 3600) return `every ${Math.floor(sec / 3600)}h`;
        if (sec >= 60) return `every ${Math.floor(sec / 60)}m`;
        return `every ${sec}s`;
    };

    const formatLocalTime = (date) =>
        date ? date.toLocaleTimeString("en-GB", { hour12: false }) : null;

    const statusLabel = loading
        ? "loading"
        : apiStatus === "dead"
          ? "dead"
          : apiStatus === "slow-live"
            ? "slow-live"
            : "live";

    const statusText = useMemo(() => {
        if (loading) {
            return "Checking...";
        }

        if (error) {
            return error;
        }

        if (!healthData) {
            return "No response";
        }

        if (healthData.ok) {
            return "HTTP 200 OK";
        }

        return `HTTP ${healthData.httpStatus}`;
    }, [error, healthData, loading]);

    return (
        <div className='api-card'>
            <div className='api-card-header'>
                <div className='api-card-title-section'>
                    <div className='api-card-title-row'>
                        <h4 title={title}>{title}</h4>
                        <span className={`status-pill ${statusLabel}`}>
                            <span className='status-dot' />
                            {statusLabel}
                        </span>
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
                                    setShowSettings(true);
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
                               
                                title='제거'
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
                                {formatLocalTime(lastUpdatedAt)}
                            </span>
                        )}
                    </div>
                </div>
            </div>

            {showSettings && (
                <HealthCheckSettingsModal
                    open
                    onClose={() => setShowSettings(false)}
                    title={title}
                    endpoint={endpoint}
                    currentSize={currentSize}
                    sizeBounds={sizeBounds}
                    refreshIntervalSec={refreshIntervalSec}
                    widgetFontSize={widgetFontSize}
                    onSizeChange={onSizeChange}
                    onRefreshIntervalChange={onRefreshIntervalChange}
                    onWidgetMetaChange={onWidgetMetaChange}
                />
            )}

            <div className='api-card-content'>
                <div
                    className='health-widget-content'
                    style={{ fontSize: `${widgetFontSize ?? DEFAULT_WIDGET_FONT_SIZE}px` }}
                >
                    <div
                        className={`health-summary-chip ${healthData?.ok ? "ok" : "fail"}`}
                    >
                        {statusText}
                    </div>

                    <div className='health-meta-grid'>
                        <div className='health-meta-item'>
                            <span className='health-meta-label'>HTTP</span>
                            <span className='health-meta-value'>
                                {healthData?.httpStatus ?? "-"}
                            </span>
                        </div>
                        <div className='health-meta-item'>
                            <span className='health-meta-label'>Latency</span>
                            <span className='health-meta-value'>
                                {healthData?.responseTimeMs != null
                                    ? `${healthData.responseTimeMs} ms`
                                    : "-"}
                            </span>
                        </div>
                    </div>

                    {healthData?.body !== undefined && (
                        <pre className='health-body-preview'>
                            {JSON.stringify(healthData.body, null, 2)}
                        </pre>
                    )}
                </div>
            </div>
        </div>
    );
};

export default HealthCheckCard;
