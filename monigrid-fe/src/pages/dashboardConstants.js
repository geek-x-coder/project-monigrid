/**
 * Constants extracted from DashboardPage.jsx (SRP).
 *
 * Pure module — no React imports — so it can be reused by every
 * dashboard sub-component (modals, widget renderer, etc.) without
 * forming a circular dependency on the page module itself.
 */

// Internal grid resolution. We use 2× the visible "user unit" so widgets can
// be sized in 0.5-unit steps — react-grid-layout itself only supports integer
// cells, so doubling the column count is the cheapest way to expose finer
// sizing without rewriting layout math. UI inputs convert via SIZE_UNIT_SCALE.
export const SIZE_UNIT_SCALE = 2;
export const SIZE_STEP = 1 / SIZE_UNIT_SCALE;

export const MIN_WIDGET_W = 1;
export const MAX_WIDGET_W = 24;
export const MIN_WIDGET_H = 2;
export const MAX_WIDGET_H = 24;
export const LAYOUT_SCALE_VERSION = 2;
// 신규 위젯의 기본 폴링 주기. BE 캐시/모니터 갱신 주기 (10~60s 가 일반적) 와
// 정합성을 맞춰 60s 로 둔다. 위젯별로 더 짧게 줄이려면 settings 모달에서 조정.
// 단 BE 가 해당 endpoint/target 에 지정한 주기 (max) 보다 작게 둘 수는 없다
// (handleRefreshIntervalChange 에서 floor 적용).
export const DEFAULT_REFRESH_INTERVAL_SEC = 60;
export const MIN_REFRESH_INTERVAL_SEC =
    Math.max(1, Number(import.meta.env.VITE_MIN_REFRESH_INTERVAL_SEC) || 5);
export const MAX_REFRESH_INTERVAL_SEC =
    Math.max(MIN_REFRESH_INTERVAL_SEC, Number(import.meta.env.VITE_MAX_REFRESH_INTERVAL_SEC) || 3600);
export const DEFAULT_WIDGET_FONT_SIZE = 13;
// 신규 데이터 표시 위젯(table / status-list / server-resource) 의 초기
// dataFontSize. 전역 DEFAULT_WIDGET_FONT_SIZE 와 분리해, 표 형태 위젯은
// 정보 밀도를 우선해 더 작은 기본값을 사용한다. 기존 위젯에는 영향 없음.
export const DEFAULT_DATA_WIDGET_FONT_SIZE = 10;
export const MIN_WIDGET_FONT_SIZE = 6;
export const MAX_WIDGET_FONT_SIZE = 24;
export const GRID_COLUMNS = 24;

export const WIDGET_TYPE_TABLE = "table";
export const WIDGET_TYPE_HEALTH_CHECK = "health-check";
export const WIDGET_TYPE_LINE_CHART = "line-chart";
export const WIDGET_TYPE_BAR_CHART = "bar-chart";
export const WIDGET_TYPE_STATUS_LIST = "status-list";
export const WIDGET_TYPE_NETWORK_TEST = "network-test";
export const WIDGET_TYPE_SERVER_RESOURCE = "server-resource";

export const DEFAULT_WIDGET_LAYOUT = {
    x: 0,
    y: 0,
    w: 8,
    h: 4,
    minW: MIN_WIDGET_W,
    minH: MIN_WIDGET_H,
};
