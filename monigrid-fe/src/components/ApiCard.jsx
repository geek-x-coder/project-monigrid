import { useEffect, useMemo, useState, useRef, useCallback } from "react";
import {
    doesRowMatchCriteria,
    doesRowMatchThresholds,
    getEnabledCriteriaColumns,
} from "../utils/helpers";
import DynamicTable from "./DynamicTable";
import {
    clamp,
    formatInterval,
    formatLocalTime,
    getAllColumns,
    getDefaultColumnWidth,
    normalizeData,
    reorderItems,
} from "./apiCardHelpers";
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
} from "../pages/dashboardConstants";
import ApiCardRowDetailModal from "./ApiCardRowDetailModal";
import ApiCardSettingsModal from "./ApiCardSettingsModal";
import { IconClose, IconRefresh, IconSettings } from "./icons";
import "./ApiCard.css";

/**
 * Lazy draft buffer for ApiCardSettingsModal.
 *
 * Lifts size / interval / title / endpoint drafts + their 4 sync effects
 * out of ApiCard so they only mount while the modal is open. ApiCard still
 * owns column / criteria / widths state because those are tied to the
 * table render and have to live in the parent regardless.
 */
const ApiCardSettingsContainer = ({
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
    // Column / criteria props are forwarded through unchanged; their state
    // lives in the parent.
    orderedColumns,
    visibleColumns,
    localColumnWidths,
    draggingColumn,
    dragOverColumn,
    onColumnToggle,
    onColumnWidthChange,
    onColumnDragStart,
    onColumnDragEnd,
    onColumnDragOver,
    onColumnDropEvent,
    availableColumns,
    criteriaMap,
    onCriteriaChange,
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
        setSizeDraft({ w: currentSize?.w ?? 4, h: currentSize?.h ?? 4 });
    }, [currentSize?.w, currentSize?.h]);
    useEffect(() => { setIntervalDraft(refreshIntervalSec ?? DEFAULT_REFRESH_INTERVAL_SEC); }, [refreshIntervalSec]);
    useEffect(() => { setTitleDraft(title); }, [title]);
    useEffect(() => { setEndpointDraft(endpoint); }, [endpoint]);
    useEffect(() => {
        setFontSizeDraft(widgetFontSize ?? DEFAULT_WIDGET_FONT_SIZE);
    }, [widgetFontSize]);

    const handleSizeApply = () => {
        const minW = sizeBounds?.minW ?? MIN_WIDGET_W;
        const maxW = sizeBounds?.maxW ?? MAX_WIDGET_W;
        const minH = sizeBounds?.minH ?? MIN_WIDGET_H;
        const maxH = sizeBounds?.maxH ?? MAX_WIDGET_H;
        const nextWidth = clamp(sizeDraft.w, minW, maxW, currentSize?.w ?? minW);
        const nextHeight = clamp(sizeDraft.h, minH, maxH, currentSize?.h ?? minH);
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

    const handleWidgetMetaApply = () => {
        const nextTitle = titleDraft.trim();
        const nextEndpoint = endpointDraft.trim();
        if (!nextTitle || !nextEndpoint) return;
        if (nextTitle === title && nextEndpoint === endpoint) return;
        onWidgetMetaChange?.({ title: nextTitle, endpoint: nextEndpoint });
    };

    const handleFontSizeApply = () => {
        const nextSize = clamp(
            fontSizeDraft,
            MIN_WIDGET_FONT_SIZE,
            MAX_WIDGET_FONT_SIZE,
            DEFAULT_WIDGET_FONT_SIZE,
        );
        setFontSizeDraft(nextSize);
        // dataFontSize 는 widget 객체에 직접 저장 → user_preferences DB 의
        // widgets 배열로 자동 persist (handleWidgetMetaChange → updateWidget).
        onWidgetMetaChange?.({ dataFontSize: nextSize });
    };

    return (
        <ApiCardSettingsModal
            open={open}
            title={title}
            onClose={onClose}
            titleDraft={titleDraft}
            endpointDraft={endpointDraft}
            onTitleDraftChange={setTitleDraft}
            onEndpointDraftChange={setEndpointDraft}
            onWidgetMetaApply={handleWidgetMetaApply}
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
            orderedColumns={orderedColumns}
            visibleColumns={visibleColumns}
            localColumnWidths={localColumnWidths}
            draggingColumn={draggingColumn}
            dragOverColumn={dragOverColumn}
            onColumnToggle={onColumnToggle}
            onColumnWidthChange={onColumnWidthChange}
            onColumnDragStart={onColumnDragStart}
            onColumnDragEnd={onColumnDragEnd}
            onColumnDragOver={onColumnDragOver}
            onColumnDropEvent={onColumnDropEvent}
            availableColumns={availableColumns}
            criteriaMap={criteriaMap}
            onCriteriaChange={onCriteriaChange}
        />
    );
};

const ApiCard = ({
    title,
    endpoint,
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
    onRefreshIntervalChange,
    onWidgetMetaChange,
    widgetFontSize,
    tableSettings,
    onTableSettingsChange,
}) => {
    const [showSettings, setShowSettings] = useState(false);
    const [lastUpdatedAt, setLastUpdatedAt] = useState(null);
    const [selectedRow, setSelectedRow] = useState(null);
    const [clipboardRow, setClipboardRow] = useState(null);
    const [showAlertsOnly, setShowAlertsOnly] = useState(false);
    const [draggingColumn, setDraggingColumn] = useState(null);
    const [dragOverColumn, setDragOverColumn] = useState(null);

    const dataRows = useMemo(() => normalizeData(data), [data]);
    const detectedColumns = useMemo(() => getAllColumns(data), [data]);

    // 컬럼 순서/표시 여부는 사용자 개인화 데이터로 user_preferences 에 영속화한다.
    //   tableSettings.columnOrder    — 감지된 모든 컬럼의 사용자 선호 순서
    //   tableSettings.visibleColumns — 표시 ON 인 컬럼의 부분 집합
    // BE 응답에 새 컬럼이 등장하면 orderedColumns 끝에 append, 기존 저장 컬럼이
    // 더 이상 BE 응답에 없으면 자연 탈락 (detectedColumns 에서 빠짐).
    const savedColumnOrder = tableSettings?.columnOrder;
    const savedVisibleColumns = tableSettings?.visibleColumns;

    const availableColumns = detectedColumns;

    const orderedColumns = useMemo(() => {
        const detectedSet = new Set(detectedColumns);
        let basis = [];
        if (Array.isArray(savedColumnOrder) && savedColumnOrder.length > 0) {
            basis = savedColumnOrder.filter((c) => detectedSet.has(c));
        } else if (Array.isArray(savedVisibleColumns) && savedVisibleColumns.length > 0) {
            // legacy: columnOrder 없던 시절 저장된 visibleColumns 를 순서 정보로 활용.
            basis = savedVisibleColumns.filter((c) => detectedSet.has(c));
        }
        const seen = new Set(basis);
        const newCols = detectedColumns.filter((c) => !seen.has(c));
        return [...basis, ...newCols];
    }, [detectedColumns, savedColumnOrder, savedVisibleColumns]);

    const visibleColumns = useMemo(() => {
        if (Array.isArray(savedVisibleColumns) && savedVisibleColumns.length > 0) {
            const visibleSet = new Set(savedVisibleColumns);
            return orderedColumns.filter((c) => visibleSet.has(c));
        }
        return orderedColumns;
    }, [orderedColumns, savedVisibleColumns]);

    useEffect(() => {
        if (data != null) {
            setLastUpdatedAt(new Date());
        }
    }, [data]);

    const columnWidths = tableSettings?.columnWidths ?? {};
    const [localColumnWidths, setLocalColumnWidths] = useState(columnWidths);
    const cardRef = useRef(null);
    const columnWidthTimerRef = useRef(null);

    // Sync local widths when external tableSettings change (e.g., from store load)
    useEffect(() => {
        setLocalColumnWidths(tableSettings?.columnWidths ?? {});
    }, [tableSettings?.columnWidths]);

    const criteriaMap = tableSettings?.criteria ?? {};
    const rowCount = dataRows.length;
    const enabledCriteriaColumns = useMemo(
        () => getEnabledCriteriaColumns(criteriaMap),
        [criteriaMap],
    );

    // BE 임계치 (widget_configs.thresholds) 가 단일 출처. 레거시 user-side
    // criteriaMap 도 정의돼 있으면 합쳐서 카운트 — 둘 중 하나라도 매칭되는 row.
    const beThresholds = tableSettings?._beThresholds;
    const alertCount = useMemo(() => {
        if (dataRows.length === 0) return 0;
        const hasCriteria = enabledCriteriaColumns.length > 0;
        const hasBeThresholds = Array.isArray(beThresholds) && beThresholds.length > 0;
        if (!hasCriteria && !hasBeThresholds) return 0;
        let count = 0;
        for (const row of dataRows) {
            if (hasCriteria && doesRowMatchCriteria(row, criteriaMap)) {
                count += 1;
                continue;
            }
            if (hasBeThresholds && doesRowMatchThresholds(row, beThresholds)) {
                count += 1;
            }
        }
        return count;
    }, [criteriaMap, dataRows, enabledCriteriaColumns.length, beThresholds]);

    useEffect(() => {
        if (alertCount === 0) {
            setShowAlertsOnly(false);
        }
    }, [alertCount]);

    useEffect(() => {
        const hasBeThresholds = Array.isArray(beThresholds) && beThresholds.length > 0;
        if (enabledCriteriaColumns.length === 0 && !hasBeThresholds) {
            setShowAlertsOnly(false);
        }
    }, [enabledCriteriaColumns.length, beThresholds]);

    const statusLabel = loading
        ? "loading"
        : apiStatus === "dead"
          ? "dead"
          : apiStatus === "slow-live"
            ? "slow-live"
            : "live";

    const statusText = statusLabel === "slow-live" ? "live" : statusLabel;

    const handleColumnToggle = (column) => {
        const isCurrentlyVisible = visibleColumns.includes(column);
        let nextVisibleColumns;
        if (isCurrentlyVisible) {
            nextVisibleColumns = visibleColumns.filter((item) => item !== column);
        } else {
            // 토글 ON 시 orderedColumns 의 원래 자리로 복귀 (끝에 단순 append X).
            const nextVisibleSet = new Set([...visibleColumns, column]);
            nextVisibleColumns = orderedColumns.filter((c) => nextVisibleSet.has(c));
        }
        onTableSettingsChange({ visibleColumns: nextVisibleColumns });
    };

    const handleColumnDragStart = (event, column) => {
        if (event.dataTransfer) {
            event.dataTransfer.effectAllowed = "move";
            event.dataTransfer.setData("text/plain", column);
        }
        setDraggingColumn(column);
        setDragOverColumn(column);
    };

    const handleColumnDrop = (targetColumn) => {
        if (!draggingColumn || draggingColumn === targetColumn) {
            setDraggingColumn(null);
            setDragOverColumn(null);
            return;
        }

        const fromIndex = orderedColumns.indexOf(draggingColumn);
        const toIndex = orderedColumns.indexOf(targetColumn);
        const reorderedAll = reorderItems(orderedColumns, fromIndex, toIndex);
        const visibleSet = new Set(visibleColumns);
        const nextVisibleColumns = reorderedAll.filter((c) => visibleSet.has(c));

        // columnOrder 는 숨김 컬럼 포함 전체 순서, visibleColumns 는 그 부분집합.
        // 두 필드 모두 user_preferences 로 영속화.
        onTableSettingsChange({
            columnOrder: reorderedAll,
            visibleColumns: nextVisibleColumns,
        });
        setDraggingColumn(null);
        setDragOverColumn(null);
    };

    const handleColumnDragEnd = () => {
        setDraggingColumn(null);
        setDragOverColumn(null);
    };

    const handleColumnDragOver = (event, column) => {
        event.preventDefault();

        if (event.dataTransfer) {
            event.dataTransfer.dropEffect = "move";
        }

        if (dragOverColumn !== column) {
            setDragOverColumn(column);
        }
    };

    const handleColumnDropEvent = (event, column) => {
        event.preventDefault();
        handleColumnDrop(column);
    };

    const handleColumnWidthChange = useCallback((column, width) => {
        const nextWidth = Number(width);
        const resolvedWidth = Number.isNaN(nextWidth)
            ? getDefaultColumnWidth(column)
            : nextWidth;

        // Update local state immediately for responsive UI
        setLocalColumnWidths((prev) => ({ ...prev, [column]: resolvedWidth }));

        // Debounce the store update to avoid flooding API calls
        if (columnWidthTimerRef.current) {
            clearTimeout(columnWidthTimerRef.current);
        }
        columnWidthTimerRef.current = setTimeout(() => {
            onTableSettingsChange({
                columnWidths: {
                    ...columnWidths,
                    [column]: resolvedWidth,
                },
            });
            columnWidthTimerRef.current = null;
        }, 300);
    }, [columnWidths, onTableSettingsChange]);

    // stable key: 컬럼 set 이 동일하면 같은 문자열 → 폴링마다 새 배열 ref 가 와도 effect 재실행 방지
    const availableColumnsKey = useMemo(
        () => availableColumns.slice().sort().join("|"),
        [availableColumns],
    );

    useEffect(() => {
        if (availableColumns.length === 0) {
            return;
        }

        const nextWidths = { ...columnWidths };
        let changed = false;

        availableColumns.forEach((column) => {
            if (!Number.isFinite(Number(nextWidths[column]))) {
                nextWidths[column] = getDefaultColumnWidth(column);
                changed = true;
            }
        });

        if (changed) {
            setLocalColumnWidths(nextWidths);
            onTableSettingsChange({ columnWidths: nextWidths });
        }
    // Intentional: availableColumnsKey 는 availableColumns 의 안정적인 동일성 키
    // (폴링마다 새 배열 ref 가 와도 ref churn 없음). columnWidths 는 누락 항목 초기값
    // 스냅샷용으로만 읽히며, 이 effect 는 *없는* 항목만 추가하므로 stale 위험 없음;
    // 사용자가 직접 설정한 값은 절대 덮어쓰지 않는다. onTableSettingsChange 는
    // store 콜백(안정적)이므로 deps 에 포함해도 동작은 동일하다.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [availableColumnsKey]);

    const criteriaTimerRef = useRef(null);

    // 디바운스 setTimeout — 위젯이 디바운스 윈도우 안에서 언마운트되면
    // 콜백이 살아남아 unmounted 컴포넌트에 setState를 호출하므로 정리한다.
    useEffect(() => {
        return () => {
            if (columnWidthTimerRef.current) {
                clearTimeout(columnWidthTimerRef.current);
                columnWidthTimerRef.current = null;
            }
            if (criteriaTimerRef.current) {
                clearTimeout(criteriaTimerRef.current);
                criteriaTimerRef.current = null;
            }
        };
    }, []);

    const handleCriteriaChange = useCallback((column, patch) => {
        const nextCriteria = {
            ...criteriaMap,
            [column]: {
                enabled: criteriaMap[column]?.enabled ?? false,
                operator: criteriaMap[column]?.operator ?? ">=",
                value: criteriaMap[column]?.value ?? "",
                ...patch,
            },
        };

        if (criteriaTimerRef.current) {
            clearTimeout(criteriaTimerRef.current);
        }
        criteriaTimerRef.current = setTimeout(() => {
            onTableSettingsChange({ criteria: nextCriteria });
            criteriaTimerRef.current = null;
        }, 300);
    }, [criteriaMap, onTableSettingsChange]);

    // Ctrl+C: 단일 클릭으로 선택된 행을 헤더 포함 TSV로 클립보드에 복사.
    // document 전역 대신 카드 root 의 onKeyDown 으로 등록해 N개 위젯 × 전역 listener 제거.
    const handleKeyDown = useCallback((e) => {
        if ((e.ctrlKey || e.metaKey) && e.key === "c" && clipboardRow) {
            const headers = visibleColumns.filter(
                (c) => !c.startsWith("_"),
            );
            const values = headers.map((h) => {
                const v = clipboardRow[h];
                if (v === null || v === undefined) return "";
                if (typeof v === "object") return JSON.stringify(v);
                return String(v);
            });
            const tsv = headers.join("\t") + "\n" + values.join("\t");
            navigator.clipboard.writeText(tsv).catch(() => {});
            e.preventDefault();
        }
    }, [clipboardRow, visibleColumns]);

    // 선택된 행의 최신 데이터를 실시간으로 추적.
    // 매칭 우선순위: _key (in 연산자, null/0도 안전) → id → 스칼라 필드만
    // 비교한 결과. Object.keys().every(...) 의 깊은 비교는 metadata 같은
    // 객체 필드의 참조가 매 폴링마다 바뀌어 항상 false 가 떨어졌고,
    // 그 결과 selectedRow 가 stale 한 채로 화면에 남는 버그가 있었다.
    const liveSelectedRow = useMemo(() => {
        if (!selectedRow) return null;
        if ("_key" in selectedRow) {
            const found = dataRows.find((r) => r?._key === selectedRow._key);
            if (found) return found;
        }
        if ("id" in selectedRow) {
            const found = dataRows.find((r) => r?.id === selectedRow.id);
            if (found) return found;
        }
        const scalarKeys = Object.keys(selectedRow).filter((k) => {
            const v = selectedRow[k];
            return v === null || (typeof v !== "object" && typeof v !== "function");
        });
        const idx = dataRows.findIndex(
            (r) => r && scalarKeys.every((k) => r[k] === selectedRow[k]),
        );
        return idx >= 0 ? dataRows[idx] : selectedRow;
    }, [selectedRow, dataRows]);

    return (
        <div ref={cardRef} className='api-card' tabIndex={-1} onKeyDown={handleKeyDown}>
            <div className='api-card-header'>
                <div className='api-card-title-section'>
                    <div className='api-card-title-row'>
                        <h4 title={title}>{title}</h4>
                        <span className='title-meta title-meta-rows'>
                            {rowCount} rows
                        </span>
                        <span className={`status-pill ${statusLabel}`}>
                            <span className='status-dot' />
                            {statusText}
                        </span>
                        {(enabledCriteriaColumns.length > 0
                            || (Array.isArray(beThresholds) && beThresholds.length > 0)) && (
                            <button
                                type='button'
                                className={`alert-pill ${alertCount > 0 ? "has-alert" : "no-alert"}`}
                                title={`알람 임계치 충족 row: ${alertCount}`}
                                onClick={() => {
                                    if (alertCount > 0) {
                                        setShowAlertsOnly(
                                            (previous) => !previous,
                                        );
                                    }
                                }}
                                aria-pressed={showAlertsOnly}
                                disabled={alertCount === 0}
                            >
                                ALERT {alertCount}
                                {showAlertsOnly ? " · ON" : ""}
                            </button>
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
                                aria-label='새로고침'
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
                                aria-label='설정'
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
                                aria-label='제거'
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
                <ApiCardSettingsContainer
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
                    orderedColumns={orderedColumns}
                    visibleColumns={visibleColumns}
                    localColumnWidths={localColumnWidths}
                    draggingColumn={draggingColumn}
                    dragOverColumn={dragOverColumn}
                    onColumnToggle={handleColumnToggle}
                    onColumnWidthChange={handleColumnWidthChange}
                    onColumnDragStart={handleColumnDragStart}
                    onColumnDragEnd={handleColumnDragEnd}
                    onColumnDragOver={handleColumnDragOver}
                    onColumnDropEvent={handleColumnDropEvent}
                    availableColumns={availableColumns}
                    criteriaMap={criteriaMap}
                    onCriteriaChange={handleCriteriaChange}
                />
            )}
            <ApiCardRowDetailModal
                row={liveSelectedRow}
                title={title}
                onClose={() => setSelectedRow(null)}
            />

            <div className='api-card-content'>
                <DynamicTable
                    data={data}
                    title=''
                    columns={visibleColumns}
                    columnWidths={columnWidths}
                    criteria={criteriaMap}
                    thresholds={tableSettings?._beThresholds}
                    showAlertsOnly={showAlertsOnly}
                    fontSize={widgetFontSize}
                    loading={loading}
                    error={error}
                    maxRows={20}
                    showHeader={false}
                    onRowClick={(row) => {
                        setClipboardRow(row);
                        cardRef.current?.focus();
                    }}
                    onRowDoubleClick={(row) => setSelectedRow(row)}
                />
            </div>
        </div>
    );
};

export default ApiCard;
