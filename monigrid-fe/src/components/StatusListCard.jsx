import React, { useEffect, useMemo, useRef, useState } from "react";
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
import { useAutoScrollTopOnDataChange } from "../utils/widgetListHelpers";
import { IconClose, IconRefresh, IconSettings } from "./icons";
import MonitorTargetPicker from "./MonitorTargetPicker.jsx";
import {
    clamp,
    formatInterval,
    formatLocalTime,
    toGridSize,
    toUserSize,
} from "./widgetUtils.js";

const STATUS_LIST_COMPACT_THRESHOLD_USER = 3;
const STATUS_LIST_NORMAL_THRESHOLD_USER = 6;
import WidgetSettingsModal from "./WidgetSettingsModal.jsx";
import "./ApiCard.css";
import "./StatusListCard.css";

const MAX_TARGETS = 50;

const StatusListCard = ({
    title,
    targetIds,
    data,
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
    onTargetIdsChange,
}) => {
    const [showSettings, setShowSettings] = useState(false);
    const [sizeDraft, setSizeDraft] = useState({ w: 4, h: 5 });
    const [intervalDraft, setIntervalDraft] = useState(refreshIntervalSec ?? DEFAULT_REFRESH_INTERVAL_SEC);
    const [titleDraft, setTitleDraft] = useState(title);
    const [fontSizeDraft, setFontSizeDraft] = useState(
        widgetFontSize ?? DEFAULT_WIDGET_FONT_SIZE,
    );
    const safeTargetIds = useMemo(
        () => (Array.isArray(targetIds) ? targetIds.filter(Boolean) : []),
        [targetIds],
    );
    const [targetIdsDraft, setTargetIdsDraft] = useState(safeTargetIds);
    const [lastUpdatedAt, setLastUpdatedAt] = useState(null);
    // 갱신 주기마다 목록 스크롤을 상단으로 리셋
    const scrollRef = useRef(null);
    useAutoScrollTopOnDataChange(scrollRef, data);

    useEffect(() => {
        // 부모(useWidgetApiData)가 새 결과를 내려줄 때마다 갱신 시각을 저장.
        if (data != null) {
            setLastUpdatedAt(new Date());
        }
    }, [data]);

    const items = useMemo(() => {
        const raw = data?.items || [];
        return [...raw].sort((a, b) => {
            const aFail = a.ok ? 1 : 0;
            const bFail = b.ok ? 1 : 0;
            return aFail - bFail; // NG(ok=false) first
        });
    }, [data]);
    const okCount = Number(data?.okCount || 0);
    const failCount = Number(data?.failCount || 0);

    // NetworkTestCard와 동일한 폭 기반 모드 분기.
    // compact(≤3 user units)에서는 URL/latency 라벨을 숨겨 한 줄 텍스트만 남긴다.
    // 그리드 해상도가 12→24 로 doubling 되었으므로 비교는 user-unit 기준으로 한다.
    const userW = toUserSize(currentSize?.w ?? 8);
    const displayMode =
        userW <= STATUS_LIST_COMPACT_THRESHOLD_USER
            ? "compact"
            : userW <= STATUS_LIST_NORMAL_THRESHOLD_USER
              ? "normal"
              : "wide";

    useEffect(() => {
        setSizeDraft({
            w: currentSize?.w ?? 4,
            h: currentSize?.h ?? 5,
        });
    }, [currentSize?.w, currentSize?.h]);

    useEffect(() => {
        setIntervalDraft(refreshIntervalSec ?? DEFAULT_REFRESH_INTERVAL_SEC);
    }, [refreshIntervalSec]);

    useEffect(() => {
        setTitleDraft(title);
    }, [title]);

    useEffect(() => {
        setTargetIdsDraft(safeTargetIds);
    }, [safeTargetIds]);

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
        const nextInterval = clamp(intervalDraft, MIN_REFRESH_INTERVAL_SEC, MAX_REFRESH_INTERVAL_SEC, MIN_REFRESH_INTERVAL_SEC);
        setIntervalDraft(nextInterval);
        onRefreshIntervalChange(nextInterval);
    };

    const handleWidgetMetaApply = () => {
        const nextTitle = titleDraft.trim();
        if (!nextTitle) {
            return;
        }

        onWidgetMetaChange?.({ title: nextTitle });
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

    const handleTargetIdsApply = () => {
        if (targetIdsDraft.length > MAX_TARGETS) {
            window.alert(`최대 ${MAX_TARGETS}개까지 선택할 수 있습니다. (현재 ${targetIdsDraft.length}개)`);
            return;
        }
        onTargetIdsChange?.(targetIdsDraft);
    };

    const hasNoTargets = safeTargetIds.length === 0;

    // Sections each have their own apply button, so no global footer.
    const settingsPopup = (
        <WidgetSettingsModal
            open={showSettings}
            onClose={() => setShowSettings(false)}
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
                        <h6>
                            API 상태 대상
                            <span className={`status-list-count${targetIdsDraft.length > MAX_TARGETS ? " over-limit" : ""}`}>
                                {targetIdsDraft.length} / {MAX_TARGETS}
                            </span>
                        </h6>
                        <p className='status-list-picker-hint'>
                            백엔드 설정 → "API 상태" 탭에서 등록한 대상 중에서 표시할 항목을 선택합니다.
                        </p>
                        <MonitorTargetPicker
                            targetType='http_status'
                            selectedIds={targetIdsDraft}
                            onChange={(ids) => setTargetIdsDraft(ids)}
                        />
                        {targetIdsDraft.length > MAX_TARGETS && (
                            <p className="status-list-limit-warn">
                                최대 {MAX_TARGETS}개까지 선택 가능합니다. ({targetIdsDraft.length - MAX_TARGETS}개 초과)
                            </p>
                        )}
                        <button
                            type='button'
                            className={`size-preset-btn status-list-apply-btn${targetIdsDraft.length > MAX_TARGETS ? " disabled" : ""}`}
                            onClick={handleTargetIdsApply}
                            disabled={targetIdsDraft.length > MAX_TARGETS}
                        >
                            대상 적용
                        </button>
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
                                <label>화면 갱신 주기 (초)</label>
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
                        <p className='status-list-picker-hint'>
                            실제 HTTP 점검 주기는 백엔드 설정에서 대상별로 관리됩니다.
                        </p>
                    </div>

                    <button
                        type='button'
                        className='size-preset-btn status-list-reconnect-btn'
                        onClick={onRefresh}
                    >
                        스냅샷 새로고침
                    </button>
        </WidgetSettingsModal>
    );

    return (
        <div className='api-card'>
            <div className='api-card-header'>
                <div className='api-card-title-section'>
                    <div className='api-card-title-row'>
                        <h4 title={title}>{title}</h4>
                        <span className='status-pill live'>
                            <span className='status-dot' />
                            OK {okCount}
                        </span>
                        {failCount > 0 && (
                            <span className='status-pill dead'>
                                <span className='status-dot' />
                                NG {failCount}
                            </span>
                        )}
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
                                    if (window.confirm(`"${title}" 위젯을 대시보드에서 제거하시겠습니까?`)) {
                                        onRemove();
                                    }
                                }}
                               
                                title='제거'
                            >
                                <IconClose size={14} />
                            </button>
                        </div>
                    </div>

                    <div className='api-endpoint-row'>
                        <div className='api-endpoint-info'>
                            <span className='api-endpoint'>
                                {safeTargetIds.length} targets
                            </span>
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

            {settingsPopup}

            <div className='api-card-content'>
                {error && <div className='status-list-error'>{error}</div>}

                {hasNoTargets ? (
                    <div className='status-list-empty'>
                        선택된 API 상태 대상이 없습니다. 설정에서 대상을 추가하세요.
                    </div>
                ) : items.length === 0 && !loading ? (
                    <div className='status-list-empty'>
                        백엔드에서 수집된 상태가 아직 없습니다.
                    </div>
                ) : (
                    <div
                        className={`status-list-items status-list-${displayMode}`}
                        ref={scrollRef}
                        style={{ fontSize: `${widgetFontSize ?? DEFAULT_WIDGET_FONT_SIZE}px` }}
                    >
                        {items.map((item) => (
                            <div
                                key={item.id}
                                className={`status-list-item mode-${displayMode}`}
                                title={`${item.label}\n${item.url}${item.responseTimeMs != null ? `\n${item.responseTimeMs} ms` : ""}${item.error ? `\n${item.error}` : ""}`}
                            >
                                <span
                                    className={`status-pill ${item.ok ? "live" : "dead"} status-list-pill`}
                                >
                                    <span className='status-dot' />
                                    {item.ok
                                        ? "OK"
                                        : item.httpStatus
                                          ? `${item.httpStatus}`
                                          : "ERR"}
                                </span>
                                <strong className='status-list-label'>
                                    {item.label}
                                </strong>
                                {displayMode !== "compact" && (
                                    <span className='status-list-url'>
                                        {item.url}
                                    </span>
                                )}
                                <span className='status-list-latency'>
                                    {item.responseTimeMs != null
                                        ? `${item.responseTimeMs} ms`
                                        : item.error || "-"}
                                </span>
                            </div>
                        ))}
                    </div>
                )}
            </div>
        </div>
    );
};

export default StatusListCard;
