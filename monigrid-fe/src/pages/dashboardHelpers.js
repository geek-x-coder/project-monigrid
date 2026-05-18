/**
 * Pure helpers extracted from DashboardPage.jsx (SRP).
 *
 * No React imports — can be unit tested without rendering and reused by
 * dashboard sub-components.
 */

import {
    DEFAULT_DATA_WIDGET_FONT_SIZE,
    DEFAULT_REFRESH_INTERVAL_SEC,
    DEFAULT_WIDGET_LAYOUT,
    MIN_WIDGET_H,
    MIN_WIDGET_W,
    WIDGET_TYPE_STATUS_LIST,
    WIDGET_TYPE_TABLE,
} from "./dashboardConstants";

export const clampValue = (value, min, max, fallback) => {
    const numericValue = Number(value);
    if (!Number.isFinite(numericValue)) {
        return fallback;
    }
    return Math.min(max, Math.max(min, Math.floor(numericValue)));
};

export const normalizeWidgetLayout = (widget, savedLayout) => {
    const fallbackLayout = widget.defaultLayout ?? DEFAULT_WIDGET_LAYOUT;

    return {
        i: widget.id,
        ...fallbackLayout,
        ...savedLayout,
        minW:
            savedLayout?.minW ??
            fallbackLayout.minW ??
            DEFAULT_WIDGET_LAYOUT.minW,
        minH:
            savedLayout?.minH ??
            fallbackLayout.minH ??
            DEFAULT_WIDGET_LAYOUT.minH,
    };
};

export const layoutArrayToMap = (layoutItems, previousLayouts = {}) => {
    return layoutItems.reduce((accumulator, item) => {
        accumulator[item.i] = {
            x: item.x,
            y: item.y,
            w: item.w,
            h: item.h,
            minW: previousLayouts[item.i]?.minW ?? MIN_WIDGET_W,
            minH: previousLayouts[item.i]?.minH ?? MIN_WIDGET_H,
        };
        return accumulator;
    }, {});
};

// Default status-list widget seeded on first dashboard load. Targets are now
// owned by the BE settings DB (`monigrid_monitor_targets`, type=http_status),
// so the widget starts empty — the admin must register targets in the
// "API 상태" config tab and then pick them in the widget's settings.
export const createStatusListWidget = () => ({
    id: "api-status-list",
    type: WIDGET_TYPE_STATUS_LIST,
    title: "API Status List",
    targetIds: [],
    defaultLayout: {
        x: 0,
        y: 5,
        w: 8,
        h: 5,
        minW: MIN_WIDGET_W,
        minH: MIN_WIDGET_H,
    },
    refreshIntervalSec: DEFAULT_REFRESH_INTERVAL_SEC,
    dataFontSize: DEFAULT_DATA_WIDGET_FONT_SIZE,
});

/**
 * BE 갱신 주기를 floor 로 사용해 위젯별 최소 폴링 주기를 계산한다.
 *
 *   - table / health-check  → endpoint URL 경로에 매칭되는 BE 캐시의
 *                              refreshIntervalSec
 *   - status-list           → 위젯이 묶은 http_status 모니터 타겟들의
 *                              interval_sec 중 max
 *   - server-resource       → serverConfig.targetIds 의 interval_sec max
 *   - network-test          → networkConfig.targetIds 의 interval_sec max
 *
 * 매칭 정보가 하나도 없으면 null 을 반환해, 호출 측이 전역 MIN_REFRESH_INTERVAL_SEC
 * 으로 대체할 수 있게 한다. "여러 endpoint" 케이스는 max 를 취해 가장 느린
 * BE 주기에 맞춘다 — FE 폴링이 BE 주기보다 잦으면 모두 cached 결과를 받게
 * 되므로 의미가 없고, BE 부하만 증가한다.
 *
 * @param {object} widget                       위젯 객체 (id, type, endpoint, ...)
 * @param {Record<string, number>} beApiByPath  endpoint path → BE refresh_interval_sec
 * @param {Record<string, number>} beIntervalsByTargetId  monitor target id → interval_sec
 * @returns {number|null}                       floor seconds 또는 null
 */
export const computeWidgetIntervalFloor = (
    widget,
    beApiByPath,
    beIntervalsByTargetId,
) => {
    if (!widget || typeof widget !== "object") return null;
    const apiMap = beApiByPath || {};
    const targetMap = beIntervalsByTargetId || {};

    const lookupByTargets = (ids) => {
        if (!Array.isArray(ids) || ids.length === 0) return null;
        let maxSec = null;
        for (const id of ids) {
            const sec = Number(targetMap[id]);
            if (Number.isFinite(sec) && sec > 0) {
                maxSec = maxSec == null ? sec : Math.max(maxSec, sec);
            }
        }
        return maxSec;
    };

    switch (widget.type) {
        case "status-list":
            return lookupByTargets(widget.targetIds);
        case "server-resource":
            return lookupByTargets(widget.serverConfig?.targetIds);
        case "network-test":
            return lookupByTargets(widget.networkConfig?.targetIds);
        default: {
            // table / health-check / line-chart / bar-chart 모두 widget.endpoint
            // 를 본다. apiMap 은 BE 측 정규화된 path 키 기준이므로 host 제거 후
            // pathname 만으로 매칭.
            const ep = String(widget.endpoint || "").trim();
            if (!ep) return null;
            let path = ep;
            try {
                // 절대 URL 이면 pathname 만, 상대 경로면 그대로.
                if (/^https?:\/\//i.test(ep)) {
                    path = new URL(ep).pathname;
                }
            } catch {
                /* 잘못된 URL → path 를 그대로 사용 */
            }
            const sec = Number(apiMap[path] ?? apiMap[ep]);
            return Number.isFinite(sec) && sec > 0 ? sec : null;
        }
    }
};

export const createDefaultApis = (baseUrl) => [
    {
        id: "api-1",
        type: WIDGET_TYPE_TABLE,
        title: "CoinTrader Status",
        endpoint: `${baseUrl}/api/status`,
        defaultLayout: {
            x: 0,
            y: 0,
            w: 8,
            h: 4,
            minW: MIN_WIDGET_W,
            minH: MIN_WIDGET_H,
        },
        refreshIntervalSec: DEFAULT_REFRESH_INTERVAL_SEC,
        dataFontSize: DEFAULT_DATA_WIDGET_FONT_SIZE,
        tableSettings: {
            visibleColumns: [],
            columnWidths: {},
            criteria: {},
        },
    },
    {
        id: "api-2",
        type: WIDGET_TYPE_TABLE,
        title: "Application Alerts",
        endpoint: `${baseUrl}/api/alerts`,
        defaultLayout: {
            x: 8,
            y: 0,
            w: 8,
            h: 4,
            minW: MIN_WIDGET_W,
            minH: MIN_WIDGET_H,
        },
        refreshIntervalSec: DEFAULT_REFRESH_INTERVAL_SEC,
        dataFontSize: DEFAULT_DATA_WIDGET_FONT_SIZE,
        tableSettings: {
            visibleColumns: [],
            columnWidths: {},
            criteria: {},
        },
    },
    {
        id: "api-3",
        type: WIDGET_TYPE_TABLE,
        title: "System Metrics",
        endpoint: `${baseUrl}/api/metrics`,
        defaultLayout: {
            x: 16,
            y: 0,
            w: 8,
            h: 5,
            minW: MIN_WIDGET_W,
            minH: MIN_WIDGET_H,
        },
        refreshIntervalSec: DEFAULT_REFRESH_INTERVAL_SEC,
        dataFontSize: DEFAULT_DATA_WIDGET_FONT_SIZE,
        tableSettings: {
            visibleColumns: [],
            columnWidths: {},
            criteria: {},
        },
    },
];
