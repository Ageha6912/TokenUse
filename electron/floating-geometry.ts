// 悬浮图标的纯几何计算：收起态=一枚小图标，展开态=以图标右上角为锚、向左下展开的小面板。
// 不依赖 Electron，便于单元测试（tests/floating-geometry.test.mjs）。

export interface Rect {
  x: number
  y: number
  width: number
  height: number
}

export type Area = Rect

/** 收起态小图标的边长 */
export const ICON_SIZE = 44
/** 展开态面板（顶部一行即图标所在行）的尺寸，floating.html 按铺满窗口布局，不重复定义尺寸 */
export const PANEL_W = 252
export const PANEL_H = 232
/** 与屏幕工作区边缘保持的最小距离 */
export const SCREEN_MARGIN = 8
/** 默认落点距工作区右上角的内缩距离 */
export const DEFAULT_INSET = 14

/** 默认位置：工作区右上角向内缩 */
export function defaultIconRect(wa: Area): Rect {
  return {
    x: wa.x + wa.width - ICON_SIZE - DEFAULT_INSET,
    y: wa.y + DEFAULT_INSET,
    width: ICON_SIZE,
    height: ICON_SIZE,
  }
}

/** 由图标位置推导展开框：图标的右上角点保持不动，向左、向下展开 */
export function expandedRect(icon: Rect): Rect {
  return {
    x: icon.x + ICON_SIZE - PANEL_W,
    y: icon.y,
    width: PANEL_W,
    height: PANEL_H,
  }
}

/** 把图标约束回工作区内（多显示器下以最近工作区为准） */
export function clampIcon(icon: Rect, wa: Area): Rect {
  return {
    x: Math.min(Math.max(icon.x, wa.x + SCREEN_MARGIN), wa.x + wa.width - ICON_SIZE - SCREEN_MARGIN),
    y: Math.min(Math.max(icon.y, wa.y + SCREEN_MARGIN), wa.y + wa.height - ICON_SIZE - SCREEN_MARGIN),
    width: ICON_SIZE,
    height: ICON_SIZE,
  }
}

/** 展开框约束：顶缘尽量保持不动（向下展开），底部放不下才上移；左缘拉回屏幕内 */
export function clampExpanded(rect: Rect, wa: Area): Rect {
  return {
    x: Math.min(Math.max(rect.x, wa.x + SCREEN_MARGIN), wa.x + wa.width - PANEL_W - SCREEN_MARGIN),
    y: Math.min(Math.max(rect.y, wa.y + SCREEN_MARGIN), wa.y + wa.height - PANEL_H - SCREEN_MARGIN),
    width: PANEL_W,
    height: PANEL_H,
  }
}
