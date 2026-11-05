import {
  forwardRef,
  memo,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from "react";
import {
  createChart,
  ColorType,
  type IChartApi,
  type ISeriesApi,
  type UTCTimestamp,
} from "lightweight-charts";
import type { PriceEngine, Candle } from "../engine/priceEngine";
import type {
  ChartDrawing,
  DraftOrder,
  DrawingTool,
  OrderKind,
  PendingOrder,
  Position,
  Side,
  Speed,
} from "../types";
import { DRAFT_ORDER_ID } from "../types";
import {
  vwap,
  ema,
  rsi,
  atr,
  type IndicatorPoint,
} from "../indicators/compute";
import {
  buildIndicatorCache,
  updateLastIndicator,
  type IncrementalIndicatorCache,
} from "../indicators/incremental";
import {
  INDICATOR_DEFS,
  defaultIndicatorState,
  type IndicatorState,
} from "../indicators/types";
import {
  calculateSessionLevels,
  DEFAULT_SESSION_SETTINGS,
  loadSessionLevelsSettings,
  type SessionLevelsSettings,
} from "../indicators/sessionLevels";
import OscillatorPane, { type OscillatorHandle } from "./OscillatorPane";
import DrawingToolbar, { DEFAULT_FIB_LEVELS } from "./DrawingToolbar";
import IndicatorMenu from "./IndicatorMenu";
import { SYMBOL_MAP, type SymbolId } from "../symbols";

type Props = {
  engine: PriceEngine;
  playing: boolean;
  speed: Speed;
  onPlayToggle: () => void;
  onSpeedChange: (speed: Speed) => void;
  onJump: (time: number) => void;
  onSaveProgress: (simTime: number) => void;
  symbol: SymbolId;
  positions: Position[];
  pendingOrders: PendingOrder[];
  draft: DraftOrder;
  onOrderLineChange: (
    id: number,
    kind: "sl" | "tp" | "trigger",
    price: number,
  ) => void;
  quickLot: number;
  onQuickLotChange: (lot: number) => void;
  riskSizingEnabled: boolean;
  riskPercent: number;
  quickStopDistance: number;
  onRiskSizingChange: (enabled: boolean) => void;
  onRiskPercentChange: (percent: number) => void;
  onQuickStopDistanceChange: (distance: number) => void;
  draftLot: number | null;
  canConfirmDraft: boolean;
  onConfirmDraft: () => void;
  onCancelDraft: () => void;
  onMarketOrder: (
    side: Side,
    lot: number,
    risk: { percent: number; stopDistance: number } | null,
  ) => boolean;
  onLimitOrder: (
    side: Side,
    price: number,
    lot: number,
    risk: { percent: number; stopDistance: number } | null,
  ) => boolean;
};

type OrderLineKind = "sl" | "tp" | "trigger";
type ChartPoint = { time: number; price: number };
type NoteEditorState = {
  drawingId: string | null;
  point: ChartPoint;
  left: number;
  top: number;
  text: string;
};
type OverlayRendererHandle = { refresh: () => void };
type OverlayRendererProps = { render: () => ReactNode };

const OverlayRenderer = memo(
  forwardRef<OverlayRendererHandle, OverlayRendererProps>(
    function OverlayRenderer({ render }, ref) {
      const [, setRevision] = useState(0);
      useImperativeHandle(
        ref,
        () => ({
          refresh: () => setRevision((revision) => revision + 1),
        }),
        [],
      );
      return <>{render()}</>;
    },
  ),
);

/** Unifies filled positions, pending stop/limit orders, and the in-progress
 *  draft into one shape so the SL/TP (and, for pending/draft, trigger) drag
 *  handles can be rendered/updated with a single code path. */
type OrderLineTarget = {
  id: number;
  side: Side;
  anchorPrice: number; // position entry, or pending/draft trigger price
  sl: number | null;
  tp: number | null;
  orderKind?: OrderKind; // present only for pending/draft — used to label the trigger handle
};

const formatRiskReward = (
  side: Side,
  entry: number,
  sl: number | null,
  tp: number | null,
): string | null => {
  if (sl == null || tp == null) return null;
  const risk = side === "buy" ? entry - sl : sl - entry;
  const reward = side === "buy" ? tp - entry : entry - tp;
  if (risk <= 0 || reward <= 0) return null;
  return `1:${(reward / risk).toFixed(2)}`;
};

type Timeframe = "M1" | "M5" | "M15" | "H1" | "H4" | "D1" | "W1";

const TF_SECONDS: Record<Timeframe, number> = {
  M1: 60,
  M5: 5 * 60,
  M15: 15 * 60,
  H1: 60 * 60,
  H4: 4 * 60 * 60,
  D1: 24 * 60 * 60,
  W1: 7 * 24 * 60 * 60,
};
const TIMEFRAMES: Timeframe[] = ["M1", "M5", "M15", "H1", "H4", "D1", "W1"];

const PLAYBACK_STEPS = [
  { id: "M1", label: "1 min", candles: 1 },
  { id: "M5", label: "5 min", candles: 5 },
  { id: "M15", label: "15 min", candles: 15 },
  { id: "M30", label: "30 min", candles: 30 },
  { id: "H1", label: "1 hour", candles: 60 },
  { id: "H4", label: "4 hours", candles: 4 * 60 },
  { id: "D1", label: "1 day", candles: 24 * 60 },
  { id: "W1", label: "1 week", candles: 7 * 24 * 60 },
];

const SPEED_OPTIONS: { value: Speed; label: string }[] = [
  { value: 1, label: "1x" },
  { value: 2, label: "2x" },
  { value: 5, label: "5x" },
  { value: 10, label: "10x" },
  { value: 30, label: "30x" },
  { value: 60, label: "60x" },
  { value: 300, label: "300x" },
  { value: 900, label: "900x" },
  { value: 3600, label: "3600x" },
];

function bucketStart(timeSec: number, tfSec: number) {
  if (tfSec === 7 * 24 * 60 * 60) {
    // Unix epoch 1970-01-01 was a Thursday (+4 days).
    // Week start on Monday 00:00:00 UTC:
    // Day index = Math.floor(timeSec / 86400)
    // Monday epoch day index mod 7 is 4
    const day = Math.floor(timeSec / 86400);
    const monday = day - ((day + 3) % 7);
    return monday * 86400;
  }
  return Math.floor(timeSec / tfSec) * tfSec;
}

/** Resample the engine's native M1 candles up into a coarser timeframe. */
function aggregate(m1: Candle[], tfSec: number): Candle[] {
  if (tfSec <= 60) return m1;
  const out: Candle[] = [];
  let cur: Candle | null = null;
  for (const c of m1) {
    const bStart = bucketStart(c.time, tfSec);
    if (!cur || cur.time !== bStart) {
      if (cur) out.push(cur);
      cur = {
        time: bStart,
        open: c.open,
        high: c.high,
        low: c.low,
        close: c.close,
      };
    } else {
      cur.high = Math.max(cur.high, c.high);
      cur.low = Math.min(cur.low, c.low);
      cur.close = c.close;
    }
  }
  if (cur) out.push(cur);
  return out;
}

function wrapNoteText(text: string, maxChars = 26): string[] {
  const lines: string[] = [];
  for (const paragraph of text.split("\n")) {
    const words = paragraph.split(/\s+/).filter(Boolean);
    if (!words.length) {
      lines.push("");
      continue;
    }
    let line = "";
    for (const word of words) {
      if (line && `${line} ${word}`.length > maxChars) {
        lines.push(line);
        line = word;
      } else {
        line = line ? `${line} ${word}` : word;
      }
    }
    lines.push(line);
  }
  return lines.length ? lines : [""];
}

function toLwc(points: IndicatorPoint[]) {
  return points.map((p) => ({ time: p.time as UTCTimestamp, value: p.value }));
}

function formatFibLevel(level: number) {
  return Number(level.toPrecision(6)).toString();
}

function clipRayToBounds(
  x: number,
  y: number,
  dx: number,
  dy: number,
  width: number,
  height: number,
): [number, number, number, number] | null {
  let minT = 0;
  let maxT = Number.POSITIVE_INFINITY;
  for (const [origin, direction, limit] of [
    [x, dx, width],
    [y, dy, height],
  ]) {
    if (Math.abs(direction) < 1e-8) {
      if (origin < 0 || origin > limit) return null;
      continue;
    }
    const a = -origin / direction;
    const b = (limit - origin) / direction;
    minT = Math.max(minT, Math.min(a, b));
    maxT = Math.min(maxT, Math.max(a, b));
  }
  if (maxT < minT || maxT < 0 || !Number.isFinite(maxT)) return null;
  const startT = Math.max(0, minT);
  return [x + dx * startT, y + dy * startT, x + dx * maxT, y + dy * maxT];
}

function formatCountdown(remainingSec: number) {
  const s = Math.max(0, Math.ceil(remainingSec));
  const pad = (n: number) => String(n).padStart(2, "0");
  if (s >= 3600) {
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    return `${h}:${pad(m)}:${pad(s % 60)}`;
  }
  return `${pad(Math.floor(s / 60))}:${pad(s % 60)}`;
}

function formatHMS(ms: number) {
  const d = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`;
}

type ChartAppearance = {
  background: string;
  textColor: string;
  gridColor: string;
  horizontalGrid: boolean;
  verticalGrid: boolean;
  axisColor: string;
  upCandle: string;
  downCandle: string;
};

const CHART_APPEARANCE_KEY = "fps_chart_appearance_v1";
const DEFAULT_CHART_APPEARANCE: ChartAppearance = {
  background: "#0f1115",
  textColor: "#c7ccd6",
  gridColor: "#252a33",
  horizontalGrid: false,
  verticalGrid: false,
  axisColor: "#2a2f3a",
  upCandle: "#26a69a",
  downCandle: "#ef5350",
};

function loadChartAppearance(): ChartAppearance {
  try {
    const saved = JSON.parse(
      localStorage.getItem(CHART_APPEARANCE_KEY) ?? "null",
    ) as Partial<ChartAppearance> | null;
    if (!saved) return DEFAULT_CHART_APPEARANCE;
    const color = (value: unknown, fallback: string) =>
      typeof value === "string" && /^#[0-9a-f]{6}$/i.test(value)
        ? value
        : fallback;
    return {
      background: color(saved.background, DEFAULT_CHART_APPEARANCE.background),
      textColor: color(saved.textColor, DEFAULT_CHART_APPEARANCE.textColor),
      gridColor: color(saved.gridColor, DEFAULT_CHART_APPEARANCE.gridColor),
      horizontalGrid:
        typeof saved.horizontalGrid === "boolean"
          ? saved.horizontalGrid
          : DEFAULT_CHART_APPEARANCE.horizontalGrid,
      verticalGrid:
        typeof saved.verticalGrid === "boolean"
          ? saved.verticalGrid
          : DEFAULT_CHART_APPEARANCE.verticalGrid,
      axisColor: color(saved.axisColor, DEFAULT_CHART_APPEARANCE.axisColor),
      upCandle: color(saved.upCandle, DEFAULT_CHART_APPEARANCE.upCandle),
      downCandle: color(saved.downCandle, DEFAULT_CHART_APPEARANCE.downCandle),
    };
  } catch {
    return DEFAULT_CHART_APPEARANCE;
  }
}

let drawingIdSequence = 0;

function createDrawingId(existing: readonly ChartDrawing[] = []) {
  const usedIds = new Set(existing.map((drawing) => drawing.id));
  let id = "";
  do {
    drawingIdSequence += 1;
    id = `draw_${Date.now().toString(36)}_${drawingIdSequence.toString(36)}`;
  } while (usedIds.has(id));
  return id;
}

function normalizeDrawingIds(drawings: ChartDrawing[]) {
  const usedIds = new Set<string>();
  return drawings.map((drawing) => {
    let id = drawing.id;
    if (!id || usedIds.has(id)) {
      id = createDrawingId();
      while (usedIds.has(id)) id = createDrawingId();
      drawing = { ...drawing, id };
    }
    usedIds.add(id);
    return drawing;
  });
}

function drawingsStorageKey(symbol: SymbolId) {
  return `fps_chart_drawings_v3_${symbol}`;
}

function loadDrawings(symbol: SymbolId): ChartDrawing[] {
  try {
    const key = drawingsStorageKey(symbol);
    const saved = localStorage.getItem(key);
    const legacy =
      !saved && symbol === "XAUUSD"
        ? localStorage.getItem("fps_chart_drawings_v2")
        : null;
    const raw = saved ?? legacy;
    if (!raw) return [];

    const parsed = JSON.parse(raw) as ChartDrawing[];
    const normalized = normalizeDrawingIds(parsed);
    const changed = normalized.some(
      (drawing, index) => drawing.id !== parsed[index]?.id,
    );
    if (changed || legacy) {
      try {
        localStorage.setItem(key, JSON.stringify(normalized));
      } catch {
        // Keep the normalized IDs in memory if storage is unavailable.
      }
    }
    return normalized;
  } catch {
    // Ignore invalid persisted drawings and start with an empty set.
  }
  return [];
}

function PriceChart({
  engine,
  playing,
  speed,
  onPlayToggle,
  onSpeedChange,
  onJump,
  onSaveProgress,
  symbol,
  positions,
  pendingOrders,
  draft,
  onOrderLineChange,
  quickLot,
  onQuickLotChange,
  riskSizingEnabled,
  riskPercent,
  quickStopDistance,
  onRiskSizingChange,
  onRiskPercentChange,
  onQuickStopDistanceChange,
  draftLot,
  canConfirmDraft,
  onConfirmDraft,
  onCancelDraft,
  onMarketOrder,
  onLimitOrder,
}: Props) {
  const pricePrecision = SYMBOL_MAP[symbol].pricePrecision;
  const containerRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const seriesRef = useRef<ISeriesApi<"Candlestick"> | null>(null);
  const vwapSeriesRef = useRef<ISeriesApi<"Line"> | null>(null);
  const emaSeriesRef = useRef<ISeriesApi<"Line"> | null>(null);
  const rsiHandleRef = useRef<OscillatorHandle | null>(null);
  const atrHandleRef = useRef<OscillatorHandle | null>(null);
  const priceLinesRef = useRef<
    Map<number, ReturnType<ISeriesApi<"Candlestick">["createPriceLine"]>>
  >(new Map());
  const priceLabelRef = useRef<HTMLDivElement>(null);
  const priceLabelPriceRef = useRef<HTMLDivElement>(null);
  const priceLabelTimeRef = useRef<HTMLDivElement>(null);
  const priceLineRef = useRef<HTMLDivElement>(null);
  const clockRef = useRef<HTMLDivElement>(null);
  const lastBarCloseSecRef = useRef(0);
  const orderLineRefs = useRef<Map<string, HTMLDivElement>>(new Map());
  const orderHandleRefs = useRef<Map<string, HTMLDivElement>>(new Map());
  const orderPriceTagRefs = useRef<Map<string, HTMLDivElement>>(new Map());

  const orderLineTargets: OrderLineTarget[] = [
    ...positions
      .filter((p) => p.symbol === symbol)
      .map((p) => ({
        id: p.id,
        side: p.side,
        anchorPrice: p.openPrice,
        sl: p.sl,
        tp: p.tp,
      })),
    ...pendingOrders
      .filter((o) => o.symbol === symbol)
      .map((o) => ({
        id: o.id,
        side: o.side,
        anchorPrice: o.triggerPrice,
        sl: o.sl,
        tp: o.tp,
        orderKind: o.kind,
      })),
    ...(draft
      ? [
          {
            id: DRAFT_ORDER_ID,
            side: draft.side,
            anchorPrice: draft.price,
            sl: draft.sl,
            tp: draft.tp,
            orderKind: draft.kind === "market" ? undefined : draft.kind,
          },
        ]
      : []),
  ];
  const orderLineTargetsRef = useRef<OrderLineTarget[]>(orderLineTargets);
  orderLineTargetsRef.current = orderLineTargets;

  const draggingRef = useRef<{
    id: number;
    kind: OrderLineKind;
    price: number;
  } | null>(null);
  const [playbackStepTf, setPlaybackStepTf] = useState("M1");
  const playbackStepCandles =
    PLAYBACK_STEPS.find((step) => step.id === playbackStepTf)?.candles ?? 1;
  const [timeframe, setTimeframe] = useState<Timeframe>("M1");
  const timeframeRef = useRef(timeframe);
  timeframeRef.current = timeframe;

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.repeat || (e.key !== "ArrowLeft" && e.key !== "ArrowRight")) return;
      const target = e.target as HTMLElement | null;
      const tag = target?.tagName;
      if (
        target?.isContentEditable ||
        tag === "INPUT" ||
        tag === "TEXTAREA" ||
        tag === "SELECT"
      )
        return;
      e.preventDefault();
      engine.stepCandles(
        e.key === "ArrowRight" ? playbackStepCandles : -playbackStepCandles,
      );
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [engine, playbackStepCandles]);

  const lastM1HistoryRef = useRef<Candle[]>([]);
  const displayedRef = useRef<Candle[]>([]);
  const [chartReady, setChartReady] = useState(false);
  const [chartAppearance, setChartAppearance] =
    useState<ChartAppearance>(loadChartAppearance);
  const [appearanceOpen, setAppearanceOpen] = useState(false);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [progressSaved, setProgressSaved] = useState(false);
  const progressSaveTimerRef = useRef<ReturnType<typeof window.setTimeout> | null>(null);
  const [limitPlacementSide, setLimitPlacementSide] = useState<Side | null>(
    null,
  );
  const [limitPlacementError, setLimitPlacementError] = useState("");

  useEffect(() => {
    if (draft) setLimitPlacementSide(null);
  }, [draft]);

  const [drawingTool, setDrawingTool] = useState<DrawingTool>("cursor");
  const lastDrawingToolRef = useRef<DrawingTool | null>(null);
  const [drawingColor, setDrawingColor] = useState("#e8c94a");
  const [drawingLineStyle, setDrawingLineStyle] =
    useState<NonNullable<ChartDrawing["lineStyle"]>>("solid");
  const [drawingLineWidth, setDrawingLineWidth] = useState(1);
  const [selectedDrawingId, setSelectedDrawingId] = useState<string | null>(
    null,
  );
  const [styleOpenRequest, setStyleOpenRequest] = useState(0);
  const [drawings, setDrawings] = useState<ChartDrawing[]>(() =>
    loadDrawings(symbol),
  );
  const drawingsRef = useRef<ChartDrawing[]>(drawings);
  drawingsRef.current = drawings;
  const drawingsSymbolRef = useRef(symbol);

  useEffect(() => {
    if (drawingsSymbolRef.current === symbol) return;
    drawingsSymbolRef.current = symbol;
    const next = loadDrawings(symbol);
    drawingsRef.current = next;
    setDrawings(next);
    setSelectedDrawingId(null);
  }, [symbol]);
  const [fibLevels, setFibLevels] = useState<number[]>(() => {
    try {
      const raw = localStorage.getItem("fps_fib_levels_v1");
      const parsed = raw ? JSON.parse(raw) : null;
      if (
        Array.isArray(parsed) &&
        parsed.length &&
        parsed.every((n) => Number.isFinite(n))
      ) {
        return parsed;
      }
    } catch {
      // fall through to defaults
    }
    return DEFAULT_FIB_LEVELS;
  });
  const fibLevelsRef = useRef(fibLevels);
  fibLevelsRef.current = fibLevels;
  const activeDrawingStartRef = useRef<{ time: number; price: number } | null>(
    null,
  );
  const [previewPoint, setPreviewPoint] = useState<{
    time: number;
    price: number;
  } | null>(null);
  const [noteEditor, setNoteEditor] = useState<NoteEditorState | null>(null);
  const svgOverlayRef = useRef<SVGSVGElement>(null);
  const overlayRendererRef = useRef<OverlayRendererHandle | null>(null);
  const overlayScaleProbeRef = useRef<[number, number] | null>(null);
  const overlayScalePixelsRef = useRef<[number, number] | null>(null);

  const saveDrawings = (next: ChartDrawing[]) => {
    setDrawings(next);
    drawingsRef.current = next;
    try {
      localStorage.setItem(drawingsStorageKey(symbol), JSON.stringify(next));
    } catch (e) {
      console.error(e);
    }
  };

  const deleteDrawing = (id: string) => {
    saveDrawings(drawingsRef.current.filter((d) => d.id !== id));
    setSelectedDrawingId(null);
  };

  const clearAllDrawings = () => {
    saveDrawings([]);
    activeDrawingStartRef.current = null;
    clearDrawingPreview();
    setDrawingTool("cursor");
    setSelectedDrawingId(null);
  };

  const [sessionRevision, setSessionRevision] = useState(0);
  const [sessionSettings, setSessionSettings] = useState<SessionLevelsSettings>(
    loadSessionLevelsSettings,
  );
  const lastSessionSourceTimeRef = useRef(-1);

  const updateSessionRevision = (timeSec: number) => {
    if (
      !Number.isFinite(timeSec) ||
      timeSec === lastSessionSourceTimeRef.current
    )
      return;
    lastSessionSourceTimeRef.current = timeSec;
    setSessionRevision((revision) => revision + 1);
  };

  const clearDrawingPreview = () => {
    pendingPreviewRef.current = null;
    if (previewFrameRef.current != null) {
      cancelAnimationFrame(previewFrameRef.current);
      previewFrameRef.current = null;
    }
    setPreviewPoint(null);
  };

  useEffect(
    () => () => {
      if (anchorDragFrameRef.current != null)
        cancelAnimationFrame(anchorDragFrameRef.current);
      if (drawingDragFrameRef.current != null)
        cancelAnimationFrame(drawingDragFrameRef.current);
      if (previewFrameRef.current != null)
        cancelAnimationFrame(previewFrameRef.current);
      if (progressSaveTimerRef.current != null)
        window.clearTimeout(progressSaveTimerRef.current);
    },
    [],
  );

  // Keyboard shortcut to delete selected drawing
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      const tag = target?.tagName;
      const editing =
        target?.isContentEditable ||
        tag === "INPUT" ||
        tag === "TEXTAREA" ||
        tag === "SELECT";
      if (editing) return;

      if ((e.key === "Delete" || e.key === "Backspace") && selectedDrawingId) {
        deleteDrawing(selectedDrawingId);
      } else if (e.key === "Escape") {
        activeDrawingStartRef.current = null;
        clearDrawingPreview();
        setDrawingTool("cursor");
        setSelectedDrawingId(null);
      } else if (
        !e.repeat &&
        (e.key.toLowerCase() === "v" ||
          (e.altKey && ["t", "h", "j"].includes(e.key.toLowerCase())))
      ) {
        const key = e.key.toLowerCase();
        const tool: DrawingTool =
          key === "v"
            ? "cursor"
            : key === "t"
              ? "trendline"
              : key === "h"
                ? "horizontal"
                : "horizontal_ray";
        activeDrawingStartRef.current = null;
        setPreviewPoint(null);
        setSelectedDrawingId(null);
        setDrawingTool(tool);
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [selectedDrawingId]);

  const [draggingHandle, setDraggingHandle] = useState<{
    drawingId: string;
    pointIndex: "p1" | "p2" | "tp";
  } | null>(null);
  const draggingHandleRef = useRef<{
    drawingId: string;
    pointIndex: "p1" | "p2" | "tp";
  } | null>(null);
  draggingHandleRef.current = draggingHandle;
  const pendingAnchorDragRef = useRef<{
    drawingId: string;
    pointIndex: "p1" | "p2" | "tp";
    point: { time: number; price: number };
  } | null>(null);
  const anchorDragFrameRef = useRef<number | null>(null);
  const pendingPreviewRef = useRef<{ time: number; price: number } | null>(
    null,
  );
  const previewFrameRef = useRef<number | null>(null);
  const panDragRef = useRef<{
    startX: number;
    from: number;
    to: number;
    barSpacing: number;
  } | null>(null);
  const lastDrawingClickRef = useRef<{
    id: string;
    time: number;
    x: number;
    y: number;
  } | null>(null);
  const drawingDragRef = useRef<{
    drawing: ChartDrawing;
    start: ChartPoint;
  } | null>(null);
  const pendingDrawingDragRef = useRef<ChartDrawing[] | null>(null);
  const drawingDragFrameRef = useRef<number | null>(null);

  const updateDrawingStyle = (
    id: string,
    updates: Partial<
      Pick<
        ChartDrawing,
        "color" | "lineWidth" | "lineStyle" | "levels" | "text"
      >
    >,
  ) => {
    saveDrawings(
      drawingsRef.current.map((d) => (d.id === id ? { ...d, ...updates } : d)),
    );
  };

  const applyAnchorPoint = (
    current: ChartDrawing[],
    drag: NonNullable<typeof pendingAnchorDragRef.current>,
  ) =>
    current.map((drawing) => {
      if (drawing.id !== drag.drawingId) return drawing;
      if (drag.pointIndex === "p1") return { ...drawing, p1: drag.point };
      if (drag.pointIndex === "tp") {
        return drawing.type === "long_position" || drawing.type === "short_position"
          ? { ...drawing, tp: drag.point }
          : drawing;
      }
      switch (drawing.type) {
        case "trendline":
        case "ray":
        case "rectangle":
        case "measure":
        case "fib":
          return { ...drawing, p2: drag.point };
        case "long_position":
        case "short_position":
          return {
            ...drawing,
            p2: drag.point,
            ...(drawing.tp ? { tp: { ...drawing.tp, time: drag.point.time } } : {}),
          };
        default:
          return drawing;
      }
    });

  const finishAnchorDrag = () => {
    if (panDragRef.current) {
      panDragRef.current = null;
      return;
    }
    if (drawingDragRef.current) {
      if (drawingDragFrameRef.current != null) {
        cancelAnimationFrame(drawingDragFrameRef.current);
        drawingDragFrameRef.current = null;
      }
      if (pendingDrawingDragRef.current)
        saveDrawings(pendingDrawingDragRef.current);
      drawingDragRef.current = null;
      pendingDrawingDragRef.current = null;
      return;
    }
    if (anchorDragFrameRef.current != null) {
      cancelAnimationFrame(anchorDragFrameRef.current);
      anchorDragFrameRef.current = null;
    }
    const pending = pendingAnchorDragRef.current;
    if (pending) saveDrawings(applyAnchorPoint(drawingsRef.current, pending));
    pendingAnchorDragRef.current = null;
    draggingHandleRef.current = null;
    setDraggingHandle(null);
  };

  const updateSessionSettings = (updates: Partial<SessionLevelsSettings>) => {
    setSessionSettings((current) => {
      const next = { ...current, ...updates };
      try {
        localStorage.setItem(
          "fps_session_levels_settings_v1",
          JSON.stringify(next),
        );
      } catch {
        // Keep the current session settings for this chart if storage is unavailable.
      }
      return next;
    });
  };

  const updateFibLevels = (levels: number[]) => {
    setFibLevels(levels);
    fibLevelsRef.current = levels;
    try {
      localStorage.setItem("fps_fib_levels_v1", JSON.stringify(levels));
    } catch (e) {
      console.error(e);
    }
    if (
      selectedDrawingId &&
      drawingsRef.current.some(
        (d) => d.id === selectedDrawingId && d.type === "fib",
      )
    ) {
      updateDrawingStyle(selectedDrawingId, { levels });
    }
  };

  /** Snap an absolute timestamp to the candle containing it on this timeframe.
   * Drawings keep their original timestamp, so returning to a finer timeframe
   * restores the original anchor instead of permanently rounding the model. */
  const timeToX = (timeSec: number): number | null => {
    const chart = chartRef.current;
    const candles = displayedRef.current;
    if (!chart || !candles.length) return null;
    const ts = chart.timeScale();
    const tfSec = TF_SECONDS[timeframeRef.current];
    const first = candles[0];
    const last = candles[candles.length - 1];
    if (timeSec < first.time) return null;

    const exact = ts.timeToCoordinate(timeSec as UTCTimestamp);
    if (exact != null) return exact;

    const bucket = bucketStart(timeSec, tfSec);
    const bucketCoordinate = ts.timeToCoordinate(bucket as UTCTimestamp);
    if (bucketCoordinate != null) return bucketCoordinate;

    if (timeSec >= last.time + tfSec) {
      const lastCoordinate = ts.timeToCoordinate(last.time as UTCTimestamp);
      if (lastCoordinate != null) {
        return (
          lastCoordinate +
          ((timeSec - last.time) / tfSec) * ts.options().barSpacing
        );
      }
    }

    let lo = 0;
    let hi = candles.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (candles[mid].time < bucket) lo = mid + 1;
      else hi = mid;
    }
    const after = candles[lo];
    const before = candles[lo - 1];
    const nearest = !before
      ? after
      : !after
        ? before
        : bucket - before.time <= after.time - bucket
          ? before
          : after;
    return nearest ? ts.timeToCoordinate(nearest.time as UTCTimestamp) : null;
  };

  const sessionTimeToX = (timeSec: number): number | null => {
    const chart = chartRef.current;
    const candles = displayedRef.current;
    if (!chart || !candles.length || timeSec < candles[0].time) return null;

    const timeScale = chart.timeScale();
    const tfSec = TF_SECONDS[timeframeRef.current];
    const barSpacing = timeScale.options().barSpacing;
    const bucket = bucketStart(timeSec, tfSec);
    let lo = 0;
    let hi = candles.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (candles[mid].time < bucket) lo = mid + 1;
      else hi = mid;
    }

    if (lo < candles.length && candles[lo].time === bucket) {
      const candleX = timeScale.timeToCoordinate(bucket as UTCTimestamp);
      if (candleX != null)
        return candleX + ((timeSec - bucket) / tfSec) * barSpacing;
    }

    const last = candles[candles.length - 1];
    if (timeSec >= last.time + tfSec) {
      const lastX = timeScale.timeToCoordinate(last.time as UTCTimestamp);
      if (lastX != null)
        return lastX + ((timeSec - last.time) / tfSec) * barSpacing;
    }

    // Session timestamps can land in a market gap; fall back to the nearest
    // real candle coordinate only when there is no candle bucket to interpolate.
    return timeToX(timeSec);
  };

  const pointAtClient = (
    clientX: number,
    clientY: number,
    clamp = false,
  ): ChartPoint | null => {
    const overlay = svgOverlayRef.current;
    const container = containerRef.current;
    const chart = chartRef.current;
    const series = seriesRef.current;
    if (!overlay || !container || !chart || !series) return null;
    const rect = overlay.getBoundingClientRect();
    const plotWidth = container.clientWidth - chart.priceScale("right").width();
    let x = clientX - rect.left;
    let y = clientY - rect.top;
    if (clamp) {
      x = Math.max(0, Math.min(plotWidth - 1, x));
      y = Math.max(0, Math.min(container.clientHeight - 1, y));
    } else if (
      x < 0 ||
      x >= plotWidth ||
      y < 0 ||
      y >= container.clientHeight
    ) {
      return null;
    }
    const price = series.coordinateToPrice(y);
    const timeScale = chart.timeScale();
    const coordinateTime = timeScale.coordinateToTime(x);
    let time: number | null =
      typeof coordinateTime === "number" ? coordinateTime : null;
    const candles = displayedRef.current;
    const logical = timeScale.coordinateToLogical(x);
    if (
      candles.length &&
      typeof logical === "number" &&
      logical > candles.length - 1
    ) {
      const tfSec = TF_SECONDS[timeframeRef.current];
      time =
        candles[candles.length - 1].time +
        (logical - (candles.length - 1)) * tfSec;
    }
    return price == null || typeof time !== "number" ? null : { time, price };
  };

  const beginDrawingBodyDrag = (
    e: ReactPointerEvent<SVGSVGElement>,
    drawing: ChartDrawing,
  ) => {
    if (
      drawingTool !== "cursor" ||
      e.button !== 0 ||
      selectedDrawingId !== drawing.id
    )
      return;
    const point = pointAtClient(e.clientX, e.clientY);
    if (!point) return;
    e.stopPropagation();
    drawingDragRef.current = { drawing, start: point };
    try {
      svgOverlayRef.current?.setPointerCapture(e.pointerId);
    } catch {
      drawingDragRef.current = null;
    }
  };

  const beginDrawingAnchorDrag = (
    e: ReactPointerEvent<SVGCircleElement>,
    drawingId: string,
    pointIndex: "p1" | "p2" | "tp",
  ) => {
    e.stopPropagation();
    const drag = { drawingId, pointIndex };
    draggingHandleRef.current = drag;
    setDraggingHandle(drag);
    setSelectedDrawingId(drawingId);
    try {
      e.currentTarget.setPointerCapture(e.pointerId);
    } catch {
      try {
        svgOverlayRef.current?.setPointerCapture(e.pointerId);
      } catch {
        // Keep the active drag state; pointer events may still reach the chart overlay.
      }
    }
  };

  const selectedDrawing = drawings.find((d) => d.id === selectedDrawingId);

  const openNoteEditor = (
    point: ChartPoint,
    clientX: number,
    clientY: number,
    drawingId: string | null = null,
    text = "",
  ) => {
    const rect = svgOverlayRef.current?.getBoundingClientRect();
    if (!rect) return;
    setNoteEditor({
      drawingId,
      point,
      left: Math.max(8, Math.min(rect.width - 260, clientX - rect.left)),
      top: Math.max(8, Math.min(rect.height - 190, clientY - rect.top)),
      text,
    });
  };

  const editSelectedNote = () => {
    if (selectedDrawing?.type !== "note") return;
    const x = timeToX(selectedDrawing.p1.time);
    const y = seriesRef.current?.priceToCoordinate(selectedDrawing.p1.price);
    const rect = svgOverlayRef.current?.getBoundingClientRect();
    if (x == null || y == null || !rect) return;
    openNoteEditor(
      selectedDrawing.p1,
      rect.left + x,
      rect.top + y,
      selectedDrawing.id,
      selectedDrawing.text ?? "",
    );
  };

  const cancelNoteEditor = () => {
    if (!noteEditor?.drawingId) setDrawingTool("cursor");
    setNoteEditor(null);
  };

  const saveNote = () => {
    if (!noteEditor) return;
    const text = noteEditor.text.trim();
    if (!text) {
      cancelNoteEditor();
      return;
    }
    if (noteEditor.drawingId) {
      updateDrawingStyle(noteEditor.drawingId, { text });
      setSelectedDrawingId(noteEditor.drawingId);
    } else {
      const drawing: ChartDrawing = {
        id: createDrawingId(drawingsRef.current),
        type: "note",
        p1: noteEditor.point,
        color: drawingColor,
        text,
        lineStyle: drawingLineStyle,
        lineWidth: drawingLineWidth,
      };
      saveDrawings([...drawingsRef.current, drawing]);
      setSelectedDrawingId(drawing.id);
    }
    setNoteEditor(null);
    setDrawingTool("cursor");
  };

  const [indicatorState, setIndicatorState] = useState<IndicatorState>(
    defaultIndicatorState,
  );
  const indicatorStateRef = useRef(indicatorState);
  const indicatorCachesRef = useRef<
    Partial<Record<"vwap" | "ema" | "rsi" | "atr", IncrementalIndicatorCache>>
  >({});
  const sessionLevels = useMemo(() => {
    if (!indicatorState.sessions.enabled) return null;
    return calculateSessionLevels(
      engine.getBars(),
      engine.getBarIntervalMs(),
      engine.getSimTime(),
      sessionSettings,
    );
  }, [
    engine,
    indicatorState.sessions.enabled,
    sessionRevision,
    sessionSettings,
  ]);
  indicatorStateRef.current = indicatorState;

  const resetOverlayScaleProbe = (candles: Candle[]) => {
    const close = candles[candles.length - 1]?.close;
    if (!Number.isFinite(close)) {
      overlayScaleProbeRef.current = null;
      overlayScalePixelsRef.current = null;
      return;
    }
    const step = Math.max(Math.abs(close!) * 0.01, 1e-6);
    overlayScaleProbeRef.current = [close!, close! + step];
    overlayScalePixelsRef.current = null;
  };

  const overlayScaleChanged = () => {
    const series = seriesRef.current;
    const probe = overlayScaleProbeRef.current;
    if (!series || !probe) return true;
    const y1 = series.priceToCoordinate(probe[0]);
    const y2 = series.priceToCoordinate(probe[1]);
    if (y1 == null || y2 == null) return true;
    const previous = overlayScalePixelsRef.current;
    overlayScalePixelsRef.current = [y1, y2];
    return (
      !previous ||
      Math.abs(y1 - previous[0]) > 0.25 ||
      Math.abs(y2 - previous[1]) > 0.25
    );
  };

  const recomputeIndicators = (full: boolean) => {
    const candles = displayedRef.current;
    const st = indicatorStateRef.current;
    const caches = indicatorCachesRef.current;

    if (st.vwap.enabled && vwapSeriesRef.current) {
      let cache = caches.vwap;
      if (
        full ||
        !cache ||
        cache.kind !== "vwap" ||
        cache.inputLength < candles.length - 1
      ) {
        cache = buildIndicatorCache("vwap", candles);
        caches.vwap = cache;
        vwapSeriesRef.current.setData(toLwc(cache.points));
      } else {
        const point = updateLastIndicator(cache, candles);
        if (point) vwapSeriesRef.current.update(toLwc([point])[0]);
      }
    } else {
      caches.vwap = undefined;
    }

    if (st.ema.enabled && emaSeriesRef.current) {
      let cache = caches.ema;
      if (
        full ||
        !cache ||
        cache.kind !== "ema" ||
        cache.period !== st.ema.period ||
        cache.inputLength < candles.length - 1
      ) {
        cache = buildIndicatorCache("ema", candles, st.ema.period);
        caches.ema = cache;
        emaSeriesRef.current.setData(toLwc(cache.points));
      } else {
        const point = updateLastIndicator(cache, candles);
        if (point) emaSeriesRef.current.update(toLwc([point])[0]);
      }
    } else {
      caches.ema = undefined;
    }

    if (st.rsi.enabled && rsiHandleRef.current) {
      let cache = caches.rsi;
      if (
        full ||
        !cache ||
        cache.kind !== "rsi" ||
        cache.period !== st.rsi.period ||
        cache.inputLength < candles.length - 1
      ) {
        cache = buildIndicatorCache("rsi", candles, st.rsi.period);
        caches.rsi = cache;
        rsiHandleRef.current.setAll(cache.points);
      } else {
        const point = updateLastIndicator(cache, candles);
        if (point) rsiHandleRef.current.updateLast(point);
      }
    } else {
      caches.rsi = undefined;
    }

    if (st.atr.enabled && atrHandleRef.current) {
      let cache = caches.atr;
      if (
        full ||
        !cache ||
        cache.kind !== "atr" ||
        cache.period !== st.atr.period ||
        cache.inputLength < candles.length - 1
      ) {
        cache = buildIndicatorCache("atr", candles, st.atr.period);
        caches.atr = cache;
        atrHandleRef.current.setAll(cache.points);
      } else {
        const point = updateLastIndicator(cache, candles);
        if (point) atrHandleRef.current.updateLast(point);
      }
    } else {
      caches.atr = undefined;
    }
  };

  const zoom = (factor: number) => {
    const chart = chartRef.current;
    if (!chart) return;
    const current = chart.timeScale().options().barSpacing;
    const next = Math.min(60, Math.max(1, current * factor));
    chart.timeScale().applyOptions({ barSpacing: next });
  };

  const saveProgress = () => {
    onSaveProgress(engine.getSimTime());
    setProgressSaved(true);
    if (progressSaveTimerRef.current != null) window.clearTimeout(progressSaveTimerRef.current);
    progressSaveTimerRef.current = window.setTimeout(() => {
      progressSaveTimerRef.current = null;
      setProgressSaved(false);
    }, 1400);
  };

  const jumpToNext0600 = () => {
    const nextDay = new Date(engine.getSimTime());
    nextDay.setUTCDate(nextDay.getUTCDate() + 1);
    nextDay.setUTCHours(6, 0, 0, 0);
    const bars = engine.getBars();
    let targetMs: number | null = null;

    for (let offset = 0; offset < 7 && targetMs == null; offset++) {
      const candidate = nextDay.getTime() + offset * 24 * 60 * 60 * 1000;
      let low = 0;
      let high = bars.length;
      while (low < high) {
        const mid = (low + high) >>> 1;
        if (bars[mid].time < candidate) low = mid + 1;
        else high = mid;
      }
      if (bars[low]?.time === candidate) targetMs = candidate;
    }

    if (targetMs == null) {
      window.alert(
        "No future 06:00 UTC candle is available in the loaded data.",
      );
      return;
    }

    const label = `${new Date(targetMs).toISOString().slice(0, 16).replace("T", " ")} UTC`;
    if (window.confirm(`Jump to the next 06:00 UTC time point (${label})?`)) {
      onJump(targetMs);
    }
  };

  // Custom current-price line + label (price on top, countdown to this bar's
  // close below) — replaces lightweight-charts' own last-price label, which
  // has no way to show a second line of text.
  const updatePriceIndicator = (barCloseSec: number) => {
    if (clockRef.current)
      clockRef.current.textContent = formatHMS(engine.getSimTime());

    const chart = chartRef.current;
    const series = seriesRef.current;
    const bar = displayedRef.current[displayedRef.current.length - 1];
    if (!chart || !series || !bar) return;
    if (
      !priceLabelRef.current ||
      !priceLineRef.current ||
      !priceLabelPriceRef.current ||
      !priceLabelTimeRef.current
    )
      return;

    const y = series.priceToCoordinate(bar.close);
    if (y == null) return;
    const axisWidth = chart.priceScale("right").width();
    const remainingSec = barCloseSec - engine.getSimTime() / 1000;
    const bullish = bar.close >= bar.open;

    priceLineRef.current.style.display = "block";
    priceLineRef.current.style.top = `${y}px`;
    priceLineRef.current.style.right = `${axisWidth}px`;
    priceLineRef.current.style.borderTopColor = bullish ? "#26a69a" : "#ef5350";

    priceLabelRef.current.style.display = "flex";
    priceLabelRef.current.style.top = `${y}px`;
    priceLabelRef.current.style.width = `${Math.max(axisWidth, 1)}px`;
    priceLabelRef.current.style.background = bullish ? "#26a69a" : "#ef5350";
    priceLabelPriceRef.current.textContent = bar.close.toFixed(pricePrecision);
    priceLabelTimeRef.current.textContent = formatCountdown(remainingSec);
  };

  // Draggable SL/TP/trigger lines, rendered as DOM overlays (like the price label
  // above) rather than lightweight-charts' native price lines, which have no drag
  // support. Every position/pending-order/draft always gets SL+TP handles, even
  // before set — an unset one shows as a dim "+ SL"/"+ TP" ghost sitting just off
  // the anchor price, ready to be dragged out. Pending orders and the draft also
  // get a "trigger" handle (always solid, since it always has a real price).
  const GHOST_OFFSET_PX = 26;

  const updateOrderLines = () => {
    const series = seriesRef.current;
    const chart = chartRef.current;
    if (!series || !chart) return;
    const axisWidth = chart.priceScale("right").width();
    const dragging = draggingRef.current;
    orderLineTargetsRef.current.forEach((t) => {
      const riskReward = formatRiskReward(t.side, t.anchorPrice, t.sl, t.tp);
      const anchorY = series.priceToCoordinate(t.anchorPrice);
      const dir = t.side === "buy" ? 1 : -1;
      const kinds: OrderLineKind[] = t.orderKind
        ? ["sl", "tp", "trigger"]
        : ["sl", "tp"];
      kinds.forEach((kind) => {
        const key = `${t.id}-${kind}`;
        const el = orderLineRefs.current.get(key);
        const label = orderHandleRefs.current.get(key);
        const priceTag = orderPriceTagRefs.current.get(key);
        if (!el || !label || !priceTag) return;
        // don't fight the user's own in-progress drag with a stale reposition
        if (dragging && dragging.id === t.id && dragging.kind === kind) return;

        let price: number | null;
        let isSet: boolean;
        if (kind === "trigger") {
          price = t.anchorPrice;
          isSet = true;
        } else {
          price = kind === "sl" ? t.sl : t.tp;
          isSet = price != null;
        }

        let y: number | null;
        if (isSet && price != null) {
          y = series.priceToCoordinate(price);
        } else if (anchorY != null) {
          const offset =
            kind === "sl" ? dir * GHOST_OFFSET_PX : -dir * GHOST_OFFSET_PX;
          y = anchorY + offset;
        } else {
          y = null;
        }
        if (y == null) {
          el.style.display = "none";
          priceTag.style.display = "none";
          return;
        }
        el.style.display = "block";
        el.style.top = `${y}px`;
        el.classList.toggle("sltp-drag-ghost", !isSet);
        priceTag.style.display = isSet ? "block" : "none";
        priceTag.style.top = `${y}px`;
        priceTag.style.right = `${axisWidth + 4}px`;
        if (kind === "trigger") {
          const sideLabel = t.side === "buy" ? "BUY" : "SELL";
          const text = `ENTRY ${sideLabel} ${t.orderKind!.toUpperCase()} ${t.anchorPrice.toFixed(pricePrecision)}`;
          label.textContent = text;
          priceTag.textContent = text;
        } else {
          const text = isSet
            ? `${kind.toUpperCase()} ${price!.toFixed(pricePrecision)}`
            : `+ ${kind.toUpperCase()}`;
          label.textContent = text;
          priceTag.textContent =
            kind === "tp" && riskReward
              ? `${text} · R:R ${riskReward}`
              : text;
        }
      });
    });
  };

  const startOrderLineDrag = (
    e: ReactPointerEvent<HTMLDivElement>,
    id: number,
    kind: OrderLineKind,
    initialPrice: number,
  ) => {
    e.preventDefault();
    e.stopPropagation();
    const container = containerRef.current;
    const series = seriesRef.current;
    if (!container || !series) return;
    draggingRef.current = { id, kind, price: initialPrice };

    const onMove = (ev: PointerEvent) => {
      const drag = draggingRef.current;
      if (!drag) return;
      const rect = container.getBoundingClientRect();
      const y = ev.clientY - rect.top;
      const price = series.coordinateToPrice(y);
      if (price == null) return;
      drag.price = price;
      const key = `${drag.id}-${drag.kind}`;
      const el = orderLineRefs.current.get(key);
      const label = orderHandleRefs.current.get(key);
      const priceTag = orderPriceTagRefs.current.get(key);
      const target = orderLineTargetsRef.current.find(
        (item) => item.id === drag.id,
      );
      if (el) {
        el.style.display = "block";
        el.style.top = `${y}px`;
        el.classList.remove("sltp-drag-ghost");
      }
      if (label) {
        if (drag.kind === "trigger" && target?.orderKind) {
          const sideLabel = target.side === "buy" ? "BUY" : "SELL";
          label.textContent = `ENTRY ${sideLabel} ${target.orderKind.toUpperCase()} ${price.toFixed(pricePrecision)}`;
        } else {
          label.textContent = `${drag.kind.toUpperCase()} ${price.toFixed(pricePrecision)}`;
        }
      }
      if (priceTag) {
        priceTag.style.display = "block";
        priceTag.style.top = `${y}px`;
        priceTag.style.right = `${(chartRef.current?.priceScale("right").width() ?? 0) + 4}px`;
        if (drag.kind === "trigger" && target?.orderKind) {
          const sideLabel = target.side === "buy" ? "BUY" : "SELL";
          priceTag.textContent = `ENTRY ${sideLabel} ${target.orderKind.toUpperCase()} ${price.toFixed(pricePrecision)}`;
        } else {
          priceTag.textContent = `${drag.kind.toUpperCase()} ${price.toFixed(pricePrecision)}`;
        }
      }
      if (target) {
        const entry = drag.kind === "trigger" ? price : target.anchorPrice;
        const sl = drag.kind === "sl" ? price : target.sl;
        const tp = drag.kind === "tp" ? price : target.tp;
        const riskReward = formatRiskReward(target.side, entry, sl, tp);
        const tpKey = `${drag.id}-tp`;
        const tpLabel = orderHandleRefs.current.get(tpKey);
        const tpPriceTag = orderPriceTagRefs.current.get(tpKey);
        if (tp != null) {
          const tpText = `TP ${tp.toFixed(pricePrecision)}`;
          if (tpLabel) tpLabel.textContent = tpText;
          if (tpPriceTag) {
            tpPriceTag.style.display = "block";
            tpPriceTag.textContent = riskReward
              ? `${tpText} · R:R ${riskReward}`
              : tpText;
          }
        }
      }
    };
    const onUp = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      const drag = draggingRef.current;
      draggingRef.current = null;
      if (!drag) return;
      onOrderLineChange(drag.id, drag.kind, drag.price);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  };

  useEffect(() => {
    if (!containerRef.current) return;
    const chart = createChart(containerRef.current, {
      layout: {
        background: { type: ColorType.Solid, color: "#0f1115" },
        textColor: "#c7ccd6",
      },
      grid: {
        vertLines: { visible: false },
        horzLines: { visible: false },
      },
      rightPriceScale: { borderColor: "#2a2f3a", autoScale: true },
      timeScale: {
        borderColor: "#2a2f3a",
        timeVisible: true,
        secondsVisible: true,
        rightOffset: 8,
      },
      handleScale: { axisPressedMouseMove: { price: true, time: false } },
      crosshair: { mode: 0 },
      width: containerRef.current.clientWidth,
      height: containerRef.current.clientHeight,
    });
    const series = chart.addCandlestickSeries({
      upColor: "#26a69a",
      downColor: "#ef5350",
      borderVisible: false,
      wickUpColor: "#26a69a",
      wickDownColor: "#ef5350",
      // replaced by our own price+countdown-to-close label below
      priceLineVisible: false,
      lastValueVisible: false,
    });
    const vwapSeries = chart.addLineSeries({
      color: "#e8c94a",
      lineWidth: 2,
      priceLineVisible: false,
      visible: false,
    });
    const emaSeries = chart.addLineSeries({
      color: "#ff7043",
      lineWidth: 2,
      priceLineVisible: false,
      visible: false,
    });
    chartRef.current = chart;
    seriesRef.current = series;
    vwapSeriesRef.current = vwapSeries;
    emaSeriesRef.current = emaSeries;
    setChartReady(true);
    setHistoryLoading(true);

    // Coalesce viewport/crosshair invalidations to at most one React render per frame.
    let drawingFrame: number | null = null;
    let historyTimer: ReturnType<typeof window.setTimeout> | null = null;
    const renderDrawingsNow = () => {
      if (drawingFrame != null) {
        cancelAnimationFrame(drawingFrame);
        drawingFrame = null;
      }
      overlayScaleChanged();
      overlayRendererRef.current?.refresh();
    };
    const refreshDrawings = () => {
      if (drawingFrame != null) return;
      drawingFrame = requestAnimationFrame(() => {
        drawingFrame = null;
        overlayScaleChanged();
        overlayRendererRef.current?.refresh();
      });
    };
    chart.timeScale().subscribeVisibleLogicalRangeChange(refreshDrawings);
    let overlayFrame: number | null = null;
    const syncOverlays = (event: PointerEvent | WheelEvent) => {
      const container = containerRef.current;
      const currentChart = chartRef.current;
      if (!container || !currentChart) return;
      const rect = container.getBoundingClientRect();
      const priceAxisLeft =
        rect.right - currentChart.priceScale("right").width();
      if (event.clientX < priceAxisLeft || overlayFrame != null) return;
      overlayFrame = requestAnimationFrame(() => {
        overlayFrame = null;
        updatePriceIndicator(lastBarCloseSecRef.current);
        updateOrderLines();
        renderDrawingsNow();
      });
    };
    window.addEventListener("pointermove", syncOverlays, {
      passive: true,
      capture: true,
    });
    window.addEventListener("pointerup", syncOverlays, {
      passive: true,
      capture: true,
    });
    window.addEventListener("wheel", syncOverlays, {
      passive: true,
      capture: true,
    });

    const resize = () => {
      if (!containerRef.current) return;
      chart.applyOptions({
        width: containerRef.current.clientWidth,
        height: containerRef.current.clientHeight,
      });
      updatePriceIndicator(lastBarCloseSecRef.current);
      updateOrderLines();
      refreshDrawings();
    };
    const ro = new ResizeObserver(resize);
    ro.observe(containerRef.current);

    const applyReset = (candles: Candle[]) => {
      const previousRange = chart.timeScale().getVisibleLogicalRange();
      const hadChartData = displayedRef.current.length > 0;
      lastM1HistoryRef.current = candles;
      lastSessionSourceTimeRef.current =
        candles[candles.length - 1]?.time ?? -1;
      setSessionRevision((revision) => revision + 1);
      const tfSec = TF_SECONDS[timeframeRef.current];
      const agg = aggregate(candles, tfSec);
      displayedRef.current = agg;
      series.setData(agg.map((c) => ({ ...c, time: c.time as UTCTimestamp })));
      resetOverlayScaleProbe(agg);
      overlayScaleChanged();
      // re-enable autoscale in case the user manually dragged the price axis before
      // jumping — otherwise the y-range stays pinned to wherever it was and the new
      // candles can land off-screen until scrolled/zoomed by hand
      series.priceScale().applyOptions({ autoScale: true });
      if (hadChartData && previousRange && agg.length) {
        const visibleBars = previousRange.to - previousRange.from;
        const rightEdge = agg.length - 1 + chart.timeScale().options().rightOffset;
        chart.timeScale().setVisibleLogicalRange({
          from: Math.max(0, rightEdge - visibleBars),
          to: rightEdge,
        });
      } else {
        chart.timeScale().fitContent();
      }
      recomputeIndicators(true);
      const lastBar = agg[agg.length - 1];
      if (lastBar) {
        lastBarCloseSecRef.current = lastBar.time + tfSec;
        updatePriceIndicator(lastBarCloseSecRef.current);
        updateOrderLines();
      }
      refreshDrawings();
    };

    const offReset = engine.onReset(applyReset);

    // Fold one new M1 candle into the currently displayed (possibly aggregated)
    // series, returning the bar that changed. Shared by live playback and bulk
    // playback steps.
    const pushCandle = (candle: Candle): { bar: Candle; isNew: boolean } => {
      const tfSec = TF_SECONDS[timeframeRef.current];
      const bStart = bucketStart(candle.time, tfSec);
      const arr = displayedRef.current;
      const last = arr[arr.length - 1];
      if (!last || last.time !== bStart) {
        const bar: Candle = {
          time: bStart,
          open: candle.open,
          high: candle.high,
          low: candle.low,
          close: candle.close,
        };
        arr.push(bar);
        return { bar, isNew: true };
      }
      last.high = Math.max(last.high, candle.high);
      last.low = Math.min(last.low, candle.low);
      last.close = candle.close;
      return { bar: last, isNew: false };
    };

    const finishCandleUpdate = (lastBar: Candle, full = false) => {
      recomputeIndicators(full);
      const tfSec = TF_SECONDS[timeframeRef.current];
      lastBarCloseSecRef.current = lastBar.time + tfSec;
      updatePriceIndicator(lastBarCloseSecRef.current);
      updateOrderLines();
      if (overlayScaleChanged()) overlayRendererRef.current?.refresh();
    };

    const offCandle = engine.onCandle((candle: Candle) => {
      updateSessionRevision(candle.time);
      const { bar } = pushCandle(candle);
      series.update({ ...bar, time: bar.time as UTCTimestamp });
      finishCandleUpdate(bar);
    });

    // A playback step (Next/Previous) skips many M1 candles at once — append
    // them all, then update the chart in one pass instead of flooding the
    // lightweight-charts instance with thousands of individual updates.
    const offBulk = engine.onCandlesBulk((candles: Candle[]) => {
      const previousRange = chart.timeScale().getVisibleLogicalRange();
      const previousLastIndex = displayedRef.current.length - 1;
      const wasAtRightEdge =
        previousRange != null && previousRange.to >= previousLastIndex + 3;
      if (candles.length)
        updateSessionRevision(candles[candles.length - 1].time);
      const newBars: Candle[] = [];
      let touched: Candle | null = null;
      for (const candle of candles) {
        const res = pushCandle(candle);
        touched = res.bar;
        if (res.isNew) newBars.push(res.bar);
      }
      if (!touched) return;
      if (newBars.length > 80) {
        series.setData(
          displayedRef.current.map((c) => ({
            ...c,
            time: c.time as UTCTimestamp,
          })),
        );
        const newLastIndex = displayedRef.current.length - 1;
        const shift = wasAtRightEdge ? newLastIndex - previousLastIndex : 0;
        if (previousRange) {
          chart.timeScale().setVisibleLogicalRange({
            from: previousRange.from + shift,
            to: previousRange.to + shift,
          });
        }
      } else {
        newBars.forEach((b) =>
          series.update({ ...b, time: b.time as UTCTimestamp }),
        );
        if (newBars[newBars.length - 1] !== touched) {
          series.update({ ...touched, time: touched.time as UTCTimestamp });
        }
      }
      finishCandleUpdate(touched, true);
    });

    // Give the loading overlay a paint before replaying potentially large
    // history into the chart on slower devices.
    historyTimer = window.setTimeout(() => {
      historyTimer = null;
      try {
        engine.replay();
      } finally {
        setHistoryLoading(false);
      }
    }, 32);

    return () => {
      offReset();
      offCandle();
      offBulk();
      ro.disconnect();
      if (drawingFrame != null) cancelAnimationFrame(drawingFrame);
      if (overlayFrame != null) cancelAnimationFrame(overlayFrame);
      if (historyTimer != null) window.clearTimeout(historyTimer);
      window.removeEventListener("pointermove", syncOverlays, true);
      window.removeEventListener("pointerup", syncOverlays, true);
      window.removeEventListener("wheel", syncOverlays, true);
      chart.remove();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [engine]);

  useEffect(() => {
    try {
      localStorage.setItem(CHART_APPEARANCE_KEY, JSON.stringify(chartAppearance));
    } catch {
      // Keep the current appearance in memory if browser storage is unavailable.
    }
  }, [chartAppearance]);

  useEffect(() => {
    const chart = chartRef.current;
    const series = seriesRef.current;
    if (!chart || !series) return;
    chart.applyOptions({
      layout: {
        background: { type: ColorType.Solid, color: chartAppearance.background },
        textColor: chartAppearance.textColor,
      },
      grid: {
        vertLines: {
          visible: chartAppearance.verticalGrid,
          color: chartAppearance.gridColor,
        },
        horzLines: {
          visible: chartAppearance.horizontalGrid,
          color: chartAppearance.gridColor,
        },
      },
      rightPriceScale: { borderColor: chartAppearance.axisColor },
      timeScale: { borderColor: chartAppearance.axisColor },
    });
    series.applyOptions({
      upColor: chartAppearance.upCandle,
      borderUpColor: chartAppearance.upCandle,
      wickUpColor: chartAppearance.upCandle,
      downColor: chartAppearance.downCandle,
      borderDownColor: chartAppearance.downCandle,
      wickDownColor: chartAppearance.downCandle,
    });
  }, [chartAppearance, chartReady]);

  // re-render the already-loaded history at the newly selected timeframe
  useEffect(() => {
    const series = seriesRef.current;
    const chart = chartRef.current;
    if (!series || !chart) return;
    const tfSec = TF_SECONDS[timeframe];
    const agg = aggregate(lastM1HistoryRef.current, tfSec);
    displayedRef.current = agg;
    series.setData(agg.map((c) => ({ ...c, time: c.time as UTCTimestamp })));
    resetOverlayScaleProbe(agg);
    overlayScaleChanged();
    series.priceScale().applyOptions({ autoScale: true });
    chart.timeScale().fitContent();
    recomputeIndicators(true);
    overlayRendererRef.current?.refresh();
    const lastBar = agg[agg.length - 1];
    if (lastBar) {
      lastBarCloseSecRef.current = lastBar.time + tfSec;
      updatePriceIndicator(lastBarCloseSecRef.current);
      updateOrderLines();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [timeframe]);

  // VWAP: overlay series already exists on the main chart — just show/hide + (re)compute
  useEffect(() => {
    const s = vwapSeriesRef.current;
    if (!s) return;
    s.applyOptions({ visible: indicatorState.vwap.enabled });
    if (indicatorState.vwap.enabled)
      s.setData(toLwc(vwap(displayedRef.current)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [indicatorState.vwap.enabled, chartReady]);

  // EMA: overlay series on the main chart
  useEffect(() => {
    const s = emaSeriesRef.current;
    if (!s) return;
    s.applyOptions({ visible: indicatorState.ema.enabled });
    if (indicatorState.ema.enabled)
      s.setData(toLwc(ema(displayedRef.current, indicatorState.ema.period)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [indicatorState.ema.enabled, indicatorState.ema.period, chartReady]);

  // RSI / ATR panes mount/unmount via JSX below; once mounted, keep them in sync
  // with period changes made from the menu
  useEffect(() => {
    if (indicatorState.rsi.enabled && rsiHandleRef.current) {
      rsiHandleRef.current.setAll(
        rsi(displayedRef.current, indicatorState.rsi.period),
      );
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [indicatorState.rsi.enabled, indicatorState.rsi.period]);

  useEffect(() => {
    if (indicatorState.atr.enabled && atrHandleRef.current) {
      atrHandleRef.current.setAll(
        atr(displayedRef.current, indicatorState.atr.period),
      );
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [indicatorState.atr.enabled, indicatorState.atr.period]);

  // draw open-position entry lines (native price lines — just a marker, not draggable)
  useEffect(() => {
    const series = seriesRef.current;
    if (!series) return;
    priceLinesRef.current.forEach((line) => series.removePriceLine(line));
    priceLinesRef.current.clear();

    // positions belonging to a different symbol have prices on a totally different
    // scale (e.g. an EURUSD entry at 1.08 drawn on the XAUUSD chart) — only the
    // current chart's own symbol gets price lines
    positions
      .filter((p) => p.symbol === symbol)
      .forEach((p) => {
        const entryLine = series.createPriceLine({
          price: p.openPrice,
          color: p.side === "buy" ? "#26a69a" : "#ef5350",
          lineWidth: 1,
          lineStyle: 2,
          axisLabelVisible: true,
          title: `${p.side.toUpperCase()} ${p.lot}`,
        });
        priceLinesRef.current.set(p.id, entryLine);
      });
  }, [positions, symbol]);

  // reposition the draggable SL/TP/trigger DOM overlays whenever the underlying
  // orders change (dragging itself keeps them in sync during the drag, and the
  // tick-driven update sites above keep them in sync with price/zoom)
  useEffect(() => {
    updateOrderLines();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [positions, pendingOrders, draft, symbol]);

  const renderOverlayItems = () => (
    <>
      {sessionLevels &&
        (() => {
          const series = seriesRef.current;
          const chart = chartRef.current;
          const container = containerRef.current;
          const candles = displayedRef.current;
          if (!series || !chart || !container || !candles.length) return null;
          const firstTime = candles[0].time;
          const last = candles[candles.length - 1];
          const tfSec = TF_SECONDS[timeframeRef.current];
          const plotWidth = Math.max(
            0,
            container.clientWidth - chart.priceScale("right").width(),
          );
          const height = container.clientHeight;
          const clipId = `session-level-clip-${symbol}`;
          const clipTime = (from: number, to: number) => {
            const clippedFrom = Math.max(from, firstTime);
            if (to <= clippedFrom) return null;
            const x1 = sessionTimeToX(clippedFrom / 1000);
            const x2 = sessionTimeToX((to - 1) / 1000);
            return x1 == null || x2 == null ? null : { x1, x2 };
          };
          return (
            <g className="session-level-layer" pointerEvents="none">
              <defs>
                <clipPath id={clipId}>
                  <rect x="0" y="0" width={plotWidth} height={height} />
                </clipPath>
              </defs>
              <g clipPath={`url(#${clipId})`}>
                {sessionLevels.bands.map((band) => {
                  const span = clipTime(band.from, band.to);
                  if (!span) return null;
                  return (
                    <rect
                      key={band.id}
                      x={span.x1}
                      y="0"
                      width={Math.max(0, span.x2 - span.x1)}
                      height={height}
                      fill={band.color}
                      fillOpacity={band.opacity}
                    />
                  );
                })}
                {sessionLevels.verticals.map((line) => {
                  if (line.time < firstTime) return null;
                  const x = sessionTimeToX(line.time / 1000);
                  if (x == null) return null;
                  return (
                    <line
                      key={line.id}
                      x1={x}
                      y1="0"
                      x2={x}
                      y2={height}
                      stroke={line.color}
                      strokeWidth="1"
                      strokeDasharray="4 4"
                      opacity="0.75"
                    />
                  );
                })}
                {sessionLevels.segments.map((segment) => {
                  const span = clipTime(segment.from, segment.to);
                  if (!span) return null;
                  const y = series.priceToCoordinate(segment.price);
                  if (y == null) return null;
                  const labelX =
                    segment.labelAt == null
                      ? null
                      : sessionTimeToX(segment.labelAt / 1000);
                  return (
                    <g key={segment.id}>
                      <line
                        x1={span.x1}
                        y1={y}
                        x2={span.x2}
                        y2={y}
                        stroke={segment.color}
                        strokeWidth={segment.width}
                        strokeDasharray={segment.dashed ? "6 4" : undefined}
                      />
                      {labelX != null && (
                        <text
                          x={Math.min(labelX, plotWidth - 4)}
                          y={y - 3}
                          fill={segment.color}
                          textAnchor="end"
                          fontSize={sessionLevels.labelFontSize}
                          fontWeight="700"
                          style={{
                            paintOrder: "stroke",
                            stroke: "rgba(11,13,17,0.85)",
                            strokeWidth: 3,
                          }}
                        >
                          {segment.name}
                        </text>
                      )}
                    </g>
                  );
                })}
              </g>
            </g>
          );
        })()}
      {/* Render completed drawings */}
      {drawings.map((d) => {
        const series = seriesRef.current;
        const chart = chartRef.current;
        if (!series || !chart) return null;

        const y1 = series.priceToCoordinate(d.p1.price);
        const isSelected = selectedDrawingId === d.id;
        if (y1 == null) return null;

        if (d.type === "horizontal") {
          return (
            <g
              key={d.id}
              data-drawing-id={d.id}
              onClick={(e) => {
                e.stopPropagation();
                setSelectedDrawingId(d.id);
              }}
              style={{ cursor: "pointer", pointerEvents: "auto" }}
            >
              <line
                x1="0"
                y1={y1}
                x2="100%"
                y2={y1}
                stroke="transparent"
                strokeWidth="14"
                pointerEvents="stroke"
              />
              <line
                x1="0"
                y1={y1}
                x2="100%"
                y2={y1}
                stroke={d.color}
                strokeWidth={d.lineWidth || (isSelected ? 2.5 : 1.5)}
                strokeDasharray={
                  d.lineStyle === "dashed"
                    ? "6 4"
                    : d.lineStyle === "dotted"
                      ? "2 2"
                      : undefined
                }
              />
              {isSelected && (
                <circle
                  cx="60"
                  cy={y1}
                  r="6"
                  fill="#fff"
                  stroke={d.color}
                  strokeWidth="2"
                  style={{ cursor: "ns-resize", pointerEvents: "auto" }}
                  onPointerDown={(e) => beginDrawingAnchorDrag(e, d.id, "p1")}
                />
              )}
            </g>
          );
        }

        if (d.type === "horizontal_ray") {
          const x1 = timeToX(d.p1.time);
          if (x1 == null) return null;
          return (
            <g
              key={d.id}
              data-drawing-id={d.id}
              onClick={(e) => {
                e.stopPropagation();
                setSelectedDrawingId(d.id);
              }}
              style={{ cursor: "pointer", pointerEvents: "auto" }}
            >
              <line
                x1={x1}
                y1={y1}
                x2="100%"
                y2={y1}
                stroke="transparent"
                strokeWidth="14"
                pointerEvents="stroke"
              />
              <line
                x1={x1}
                y1={y1}
                x2="100%"
                y2={y1}
                stroke={d.color}
                strokeWidth={d.lineWidth || (isSelected ? 2.5 : 1.5)}
                strokeDasharray={
                  d.lineStyle === "dashed"
                    ? "6 4"
                    : d.lineStyle === "dotted"
                      ? "2 2"
                      : undefined
                }
              />
              <circle
                cx={x1}
                cy={y1}
                r={isSelected ? 6 : 0}
                opacity={isSelected ? 1 : 0}
                fill={isSelected ? "#fff" : d.color}
                stroke={d.color}
                strokeWidth="2"
                style={{
                  cursor: "move",
                  pointerEvents: isSelected ? "auto" : "none",
                }}
                onPointerDown={(e) => beginDrawingAnchorDrag(e, d.id, "p1")}
              />
            </g>
          );
        }

        if (d.type === "note") {
          const x1 = timeToX(d.p1.time);
          if (x1 == null) return null;
          const lines = wrapNoteText(d.text ?? "");
          const boxWidth = 220;
          const boxHeight = Math.max(42, lines.length * 16 + 20);
          const overlay = svgOverlayRef.current;
          const overlayWidth = overlay?.clientWidth ?? 0;
          const overlayHeight = overlay?.clientHeight ?? 0;
          const placeRight = x1 + boxWidth + 30 <= overlayWidth;
          const boxX = placeRight
            ? Math.min(overlayWidth - boxWidth - 8, x1 + 24)
            : Math.max(8, x1 - boxWidth - 24);
          const boxY = Math.max(
            8,
            Math.min(overlayHeight - boxHeight - 8, y1 - boxHeight / 2),
          );
          const attachY = Math.max(
            boxY + 10,
            Math.min(boxY + boxHeight - 10, y1),
          );
          const tipPath = placeRight
            ? `M ${boxX} ${attachY - 8} L ${x1} ${y1} L ${boxX} ${attachY + 8} Z`
            : `M ${boxX + boxWidth} ${attachY - 8} L ${x1} ${y1} L ${boxX + boxWidth} ${attachY + 8} Z`;
          return (
            <g
              key={d.id}
              data-drawing-id={d.id}
              onClick={(e) => {
                e.stopPropagation();
                setSelectedDrawingId(d.id);
              }}
              onDoubleClick={(e) => {
                e.stopPropagation();
                openNoteEditor(d.p1, e.clientX, e.clientY, d.id, d.text ?? "");
              }}
              style={{ cursor: "move", pointerEvents: "auto" }}
            >
              <path
                d={tipPath}
                fill="#141820"
                stroke={d.color}
                strokeWidth={isSelected ? 2 : 1}
              />
              <rect
                x={boxX}
                y={boxY}
                width={boxWidth}
                height={boxHeight}
                rx="6"
                fill="#141820"
                stroke={d.color}
                strokeWidth={isSelected ? 2 : 1}
              />
              <circle cx={x1} cy={y1} r="3" fill={d.color} />
              <text
                x={boxX + 10}
                y={boxY + 20}
                fill="#fff"
                fontSize="12"
                pointerEvents="none"
              >
                {lines.map((line, index) => (
                  <tspan
                    key={`${d.id}-note-${index}`}
                    x={boxX + 10}
                    dy={index === 0 ? 0 : 16}
                  >
                    {line}
                  </tspan>
                ))}
              </text>
            </g>
          );
        }

        if (d.p2) {
          const x1 = timeToX(d.p1.time);
          const y2 = series.priceToCoordinate(d.p2.price);
          const x2 = timeToX(d.p2.time);
          if (x1 == null || x2 == null || y2 == null) return null;

          const strokeDasharray =
            d.lineStyle === "dashed"
              ? "6 4"
              : d.lineStyle === "dotted"
                ? "2 2"
                : undefined;

          if (d.type === "trendline") {
            return (
              <g
                key={d.id}
                data-drawing-id={d.id}
                onClick={(e) => {
                  e.stopPropagation();
                  setSelectedDrawingId(d.id);
                }}
                style={{ cursor: "pointer", pointerEvents: "auto" }}
              >
                <line
                  x1={x1}
                  y1={y1}
                  x2={x2}
                  y2={y2}
                  stroke="transparent"
                  strokeWidth="14"
                  pointerEvents="stroke"
                />
                <line
                  x1={x1}
                  y1={y1}
                  x2={x2}
                  y2={y2}
                  stroke={d.color}
                  strokeWidth={d.lineWidth || (isSelected ? 3 : 2)}
                  strokeDasharray={strokeDasharray}
                />
                <circle
                  cx={x1}
                  cy={y1}
                  r={isSelected ? 6 : 0}
                  opacity={isSelected ? 1 : 0}
                  fill="#fff"
                  stroke={d.color}
                  strokeWidth="2"
                  style={{
                    cursor: "move",
                    pointerEvents: isSelected ? "auto" : "none",
                  }}
                  onPointerDown={(e) => beginDrawingAnchorDrag(e, d.id, "p1")}
                />
                <circle
                  cx={x2}
                  cy={y2}
                  r={isSelected ? 6 : 0}
                  opacity={isSelected ? 1 : 0}
                  fill="#fff"
                  stroke={d.color}
                  strokeWidth="2"
                  style={{
                    cursor: "move",
                    pointerEvents: isSelected ? "auto" : "none",
                  }}
                  onPointerDown={(e) => beginDrawingAnchorDrag(e, d.id, "p2")}
                />
              </g>
            );
          }

          if (d.type === "ray") {
            const container = containerRef.current;
            const width = container
              ? container.clientWidth - chart.priceScale("right").width()
              : 0;
            const height = container?.clientHeight ?? 0;
            const clipped = clipRayToBounds(
              x1,
              y1,
              x2 - x1,
              y2 - y1,
              width,
              height,
            );
            if (!clipped) return null;
            const [rayX1, rayY1, rayX2, rayY2] = clipped;
            return (
              <g
                key={d.id}
                data-drawing-id={d.id}
                onClick={(e) => {
                  e.stopPropagation();
                  setSelectedDrawingId(d.id);
                }}
                style={{ cursor: "pointer", pointerEvents: "auto" }}
              >
                <line
                  x1={rayX1}
                  y1={rayY1}
                  x2={rayX2}
                  y2={rayY2}
                  stroke="transparent"
                  strokeWidth="14"
                  pointerEvents="stroke"
                />
                <line
                  x1={rayX1}
                  y1={rayY1}
                  x2={rayX2}
                  y2={rayY2}
                  stroke={d.color}
                  strokeWidth={d.lineWidth || (isSelected ? 3 : 2)}
                  strokeDasharray={strokeDasharray}
                />
                <circle
                  cx={x1}
                  cy={y1}
                  r={isSelected ? 6 : 0}
                  opacity={isSelected ? 1 : 0}
                  fill="#fff"
                  stroke={d.color}
                  strokeWidth="2"
                  style={{
                    cursor: "move",
                    pointerEvents: isSelected ? "auto" : "none",
                  }}
                  onPointerDown={(e) => beginDrawingAnchorDrag(e, d.id, "p1")}
                />
                <circle
                  cx={x2}
                  cy={y2}
                  r={isSelected ? 6 : 0}
                  opacity={isSelected ? 1 : 0}
                  fill="#fff"
                  stroke={d.color}
                  strokeWidth="2"
                  style={{
                    cursor: "move",
                    pointerEvents: isSelected ? "auto" : "none",
                  }}
                  onPointerDown={(e) => beginDrawingAnchorDrag(e, d.id, "p2")}
                />
              </g>
            );
          }

          if (d.type === "rectangle") {
            const rx = Math.min(x1, x2);
            const ry = Math.min(y1, y2);
            const rw = Math.abs(x2 - x1);
            const rh = Math.abs(y2 - y1);
            return (
              <g
                key={d.id}
                data-drawing-id={d.id}
                onClick={(e) => {
                  e.stopPropagation();
                  setSelectedDrawingId(d.id);
                }}
                style={{ cursor: "pointer", pointerEvents: "auto" }}
              >
                <rect
                  x={rx}
                  y={ry}
                  width={rw}
                  height={rh}
                  fill={`${d.color}26`}
                  stroke={d.color}
                  strokeWidth={d.lineWidth || (isSelected ? 2 : 1)}
                  strokeDasharray={strokeDasharray}
                />
                {isSelected && (
                  <>
                    <circle
                      cx={x1}
                      cy={y1}
                      r="5"
                      fill="#fff"
                      stroke={d.color}
                      strokeWidth="2"
                      style={{ cursor: "nwse-resize", pointerEvents: "auto" }}
                      onPointerDown={(e) =>
                        beginDrawingAnchorDrag(e, d.id, "p1")
                      }
                    />
                    <circle
                      cx={x2}
                      cy={y2}
                      r="5"
                      fill="#fff"
                      stroke={d.color}
                      strokeWidth="2"
                      style={{ cursor: "nwse-resize", pointerEvents: "auto" }}
                      onPointerDown={(e) =>
                        beginDrawingAnchorDrag(e, d.id, "p2")
                      }
                    />
                  </>
                )}
              </g>
            );
          }

          if (d.type === "long_position" || d.type === "short_position") {
            const boxLeft = Math.min(x1, x2);
            const boxRight = Math.max(x1, x2);
            const boxWidth = boxRight - boxLeft;
            const isLong = d.type === "long_position";
            const risk = isLong
              ? d.p1.price - d.p2.price
              : d.p2.price - d.p1.price;
            const defaultRiskReward = d.riskReward ?? 2;
            if (risk <= 0) return null;
            const targetPrice =
              d.tp?.price ??
              d.p1.price + (isLong ? risk : -risk) * defaultRiskReward;
            const targetX = timeToX(d.tp?.time ?? d.p2.time);
            const targetY = series.priceToCoordinate(targetPrice);
            if (targetX == null || targetY == null) return null;
            const riskReward =
              ((targetPrice - d.p1.price) * (isLong ? 1 : -1)) / risk;
            const labelX = Math.min(boxRight - 4, boxLeft + 8);
            return (
              <g
                key={d.id}
                data-drawing-id={d.id}
                onClick={(e) => {
                  e.stopPropagation();
                  setSelectedDrawingId(d.id);
                }}
                style={{ cursor: "pointer", pointerEvents: "auto" }}
              >
                <rect
                  x={boxLeft}
                  y={Math.min(y1, targetY)}
                  width={boxWidth}
                  height={Math.abs(y1 - targetY)}
                  fill="#26a69a"
                  fillOpacity="0.18"
                />
                <rect
                  x={boxLeft}
                  y={Math.min(y1, y2)}
                  width={boxWidth}
                  height={Math.abs(y1 - y2)}
                  fill="#ef5350"
                  fillOpacity="0.2"
                />
                <line x1={x1} y1={y1} x2={x2} y2={y1} stroke="#e8c94a" strokeWidth="1.5" />
                <line x1={x1} y1={targetY} x2={targetX} y2={targetY} stroke="#26a69a" strokeWidth="1" strokeDasharray="5 4" />
                <line x1={x1} y1={y2} x2={x2} y2={y2} stroke="#ef5350" strokeWidth="1" strokeDasharray="5 4" />
                <text
                  x={labelX}
                  y={y1 - 7}
                  fill="#fff"
                  fontSize="11"
                  fontWeight="700"
                  style={{ paintOrder: "stroke", stroke: "rgba(11,13,17,0.9)", strokeWidth: 3 }}
                >
                  {isLong ? "LONG" : "SHORT"} · R:R 1:{riskReward.toFixed(1)}
                </text>
                <text x={targetX - 5} y={targetY - 4} fill="#26a69a" textAnchor="end" fontSize="10" fontWeight="700">TP · {targetPrice.toFixed(pricePrecision)}</text>
                <text x={boxRight - 5} y={y2 - 4} fill="#ef5350" textAnchor="end" fontSize="10" fontWeight="700">SL · {d.p2.price.toFixed(pricePrecision)}</text>
                {isSelected && (
                  <>
                    <circle cx={x1} cy={y1} r="5" fill="#fff" stroke="#e8c94a" strokeWidth="2" onPointerDown={(e) => beginDrawingAnchorDrag(e, d.id, "p1")} />
                    <circle cx={x2} cy={y2} r="5" fill="#fff" stroke="#ef5350" strokeWidth="2" onPointerDown={(e) => beginDrawingAnchorDrag(e, d.id, "p2")} />
                    <circle cx={targetX} cy={targetY} r="5" fill="#fff" stroke="#26a69a" strokeWidth="2" style={{ cursor: "ns-resize" }} onPointerDown={(e) => beginDrawingAnchorDrag(e, d.id, "tp")} />
                  </>
                )}
              </g>
            );
          }

          if (d.type === "fib") {
            const levels =
              d.levels && d.levels.length ? d.levels : DEFAULT_FIB_LEVELS;
            const left = Math.min(x1, x2);
            const right = Math.max(x1, x2);
            const diff = d.p2.price - d.p1.price;
            return (
              <g
                key={d.id}
                data-drawing-id={d.id}
                onClick={(e) => {
                  e.stopPropagation();
                  setSelectedDrawingId(d.id);
                }}
                style={{ cursor: "pointer", pointerEvents: "auto" }}
              >
                <line
                  x1={x1}
                  y1={y1}
                  x2={x2}
                  y2={y2}
                  stroke={d.color}
                  strokeWidth={d.lineWidth ?? 1}
                  strokeOpacity="0.55"
                  strokeDasharray={
                    d.lineStyle === "dashed"
                      ? "6 4"
                      : d.lineStyle === "dotted"
                        ? "2 2"
                        : "4 3"
                  }
                />
                {levels.map((level, i) => {
                  const price = d.p1.price - diff * level;
                  const y = series.priceToCoordinate(price);
                  if (y == null) return null;
                  const isAnchor = level === 0 || level === 1;
                  return (
                    <g key={`${d.id}-fib-${i}`}>
                      <line
                        x1={left}
                        y1={y}
                        x2={right}
                        y2={y}
                        stroke={d.color}
                        strokeWidth={d.lineWidth ?? (isAnchor ? 2 : 1.25)}
                        strokeOpacity={isAnchor ? 0.95 : 0.75}
                        strokeDasharray={
                          d.lineStyle === "dashed"
                            ? "6 4"
                            : d.lineStyle === "dotted"
                              ? "2 2"
                              : undefined
                        }
                      />
                      <text
                        x={right - 4}
                        y={y - 3}
                        fill={d.color}
                        fontSize="10.5"
                        fontWeight="700"
                        textAnchor="end"
                        style={{
                          pointerEvents: "none",
                          paintOrder: "stroke",
                          stroke: "rgba(11,13,17,0.85)",
                          strokeWidth: 3,
                        }}
                      >
                        {formatFibLevel(level)}
                      </text>
                    </g>
                  );
                })}
                {isSelected && (
                  <>
                    <circle
                      cx={x1}
                      cy={y1}
                      r="5"
                      fill="#fff"
                      stroke={d.color}
                      strokeWidth="2"
                      style={{
                        cursor: "move",
                        pointerEvents: isSelected ? "auto" : "none",
                      }}
                      onPointerDown={(e) =>
                        beginDrawingAnchorDrag(e, d.id, "p1")
                      }
                    />
                    <circle
                      cx={x2}
                      cy={y2}
                      r="5"
                      fill="#fff"
                      stroke={d.color}
                      strokeWidth="2"
                      style={{
                        cursor: "move",
                        pointerEvents: isSelected ? "auto" : "none",
                      }}
                      onPointerDown={(e) =>
                        beginDrawingAnchorDrag(e, d.id, "p2")
                      }
                    />
                  </>
                )}
              </g>
            );
          }

          if (d.type === "measure") {
            const rx = Math.min(x1, x2);
            const ry = Math.min(y1, y2);
            const rw = Math.abs(x2 - x1);
            const rh = Math.abs(y2 - y1);
            const diffPrice = d.p2.price - d.p1.price;
            const pips = (diffPrice * 10).toFixed(1);
            const pct = ((diffPrice / d.p1.price) * 100).toFixed(2);
            return (
              <g
                key={d.id}
                data-drawing-id={d.id}
                onClick={(e) => {
                  e.stopPropagation();
                  setSelectedDrawingId(d.id);
                }}
                style={{ cursor: "pointer", pointerEvents: "auto" }}
              >
                <rect
                  x={rx}
                  y={ry}
                  width={rw}
                  height={rh}
                  fill={`${d.color}33`}
                  stroke={d.color}
                  strokeWidth={d.lineWidth ?? 1}
                  strokeDasharray={strokeDasharray ?? "3 3"}
                />
                <text
                  x={rx + rw / 2}
                  y={ry + rh / 2}
                  fill="#fff"
                  fontSize="11"
                  textAnchor="middle"
                  fontWeight="bold"
                  pointerEvents="none"
                >
                  {diffPrice >= 0 ? "+" : ""}
                  {diffPrice.toFixed(2)} ({pips} pips, {pct}%)
                </text>
                {isSelected && (
                  <>
                    <circle
                      cx={x1}
                      cy={y1}
                      r="5"
                      fill="#fff"
                      stroke={d.color}
                      strokeWidth="2"
                      style={{ cursor: "move", pointerEvents: "auto" }}
                      onPointerDown={(e) =>
                        beginDrawingAnchorDrag(e, d.id, "p1")
                      }
                    />
                    <circle
                      cx={x2}
                      cy={y2}
                      r="5"
                      fill="#fff"
                      stroke={d.color}
                      strokeWidth="2"
                      style={{ cursor: "move", pointerEvents: "auto" }}
                      onPointerDown={(e) =>
                        beginDrawingAnchorDrag(e, d.id, "p2")
                      }
                    />
                  </>
                )}
              </g>
            );
          }
        }
        return null;
      })}

      {/* Dynamic Live Preview while drawing */}
      {activeDrawingStartRef.current &&
        previewPoint &&
        (() => {
          const series = seriesRef.current;
          const chart = chartRef.current;
          if (!series || !chart) return null;
          const p1 = activeDrawingStartRef.current;
          const x1 = timeToX(p1.time);
          const y1 = series.priceToCoordinate(p1.price);
          const x2 = timeToX(previewPoint.time);
          const y2 = series.priceToCoordinate(previewPoint.price);
          if (x1 == null || y1 == null || x2 == null || y2 == null) return null;

          if (drawingTool === "trendline" || drawingTool === "ray") {
            return (
              <g>
                <line
                  x1={x1}
                  y1={y1}
                  x2={x2}
                  y2={y2}
                  stroke={drawingColor}
                  strokeWidth={drawingLineWidth}
                  strokeDasharray={
                    drawingLineStyle === "dashed"
                      ? "6 4"
                      : drawingLineStyle === "dotted"
                        ? "2 2"
                        : undefined
                  }
                />
                <circle cx={x1} cy={y1} r="4" fill={drawingColor} />
                <circle cx={x2} cy={y2} r="4" fill={drawingColor} />
              </g>
            );
          }
          if (
            drawingTool === "long_position" ||
            drawingTool === "short_position"
          ) {
            const boxLeft = Math.min(x1, x2);
            const boxRight = Math.max(x1, x2);
            const boxWidth = boxRight - boxLeft;
            const labelX = Math.max(4, Math.min(boxRight - 4, boxLeft + 8));
            const isLong = drawingTool === "long_position";
            const risk = isLong
              ? p1.price - previewPoint.price
              : previewPoint.price - p1.price;
            if (risk <= 0) return null;
            const targetPrice = p1.price + (isLong ? risk : -risk) * 2;
            const targetY = series.priceToCoordinate(targetPrice);
            if (targetY == null) return null;
            return (
              <g pointerEvents="none">
                <rect x={boxLeft} y={Math.min(y1, targetY)} width={boxWidth} height={Math.abs(y1 - targetY)} fill="#26a69a" fillOpacity="0.18" />
                <rect x={boxLeft} y={Math.min(y1, y2)} width={boxWidth} height={Math.abs(y1 - y2)} fill="#ef5350" fillOpacity="0.2" />
                <line x1={x1} y1={y1} x2={x2} y2={y1} stroke="#e8c94a" strokeWidth="1.5" />
                <line x1={x1} y1={targetY} x2={x2} y2={targetY} stroke="#26a69a" strokeDasharray="5 4" />
                <line x1={x1} y1={y2} x2={x2} y2={y2} stroke="#ef5350" strokeDasharray="5 4" />
                <text x={labelX} y={y1 - 7} fill="#fff" fontSize="11" fontWeight="700" style={{ paintOrder: "stroke", stroke: "rgba(11,13,17,0.9)", strokeWidth: 3 }}>
                  {isLong ? "LONG" : "SHORT"} · R:R 1:2.0
                </text>
              </g>
            );
          }
          if (drawingTool === "fib") {
            const levels = fibLevelsRef.current;
            const left = Math.min(x1, x2);
            const right = Math.max(x1, x2);
            const diff = previewPoint.price - p1.price;
            return (
              <g>
                <line
                  x1={x1}
                  y1={y1}
                  x2={x2}
                  y2={y2}
                  stroke={drawingColor}
                  strokeWidth={drawingLineWidth}
                  strokeDasharray={
                    drawingLineStyle === "dashed"
                      ? "6 4"
                      : drawingLineStyle === "dotted"
                        ? "2 2"
                        : undefined
                  }
                />
                {levels.map((level, i) => {
                  const y = series.priceToCoordinate(p1.price - diff * level);
                  if (y == null) return null;
                  return (
                    <g key={`fib-preview-${i}`}>
                      <line
                        x1={left}
                        y1={y}
                        x2={right}
                        y2={y}
                        stroke={drawingColor}
                        strokeWidth={drawingLineWidth}
                        strokeOpacity="0.8"
                        strokeDasharray={
                          drawingLineStyle === "dashed"
                            ? "6 4"
                            : drawingLineStyle === "dotted"
                              ? "2 2"
                              : undefined
                        }
                      />
                      <text
                        x={right - 4}
                        y={y - 3}
                        fill={drawingColor}
                        fontSize="10.5"
                        fontWeight="700"
                        textAnchor="end"
                        style={{
                          pointerEvents: "none",
                          paintOrder: "stroke",
                          stroke: "rgba(11,13,17,0.85)",
                          strokeWidth: 3,
                        }}
                      >
                        {formatFibLevel(level)}
                      </text>
                    </g>
                  );
                })}
                <circle cx={x1} cy={y1} r="4" fill={drawingColor} />
                <circle cx={x2} cy={y2} r="4" fill={drawingColor} />
              </g>
            );
          }
          if (drawingTool === "rectangle") {
            return (
              <rect
                x={Math.min(x1, x2)}
                y={Math.min(y1, y2)}
                width={Math.abs(x2 - x1)}
                height={Math.abs(y2 - y1)}
                fill={`${drawingColor}33`}
                stroke={drawingColor}
                strokeWidth={drawingLineWidth}
                strokeDasharray={
                  drawingLineStyle === "dashed"
                    ? "6 4"
                    : drawingLineStyle === "dotted"
                      ? "2 2"
                      : undefined
                }
              />
            );
          }
          if (drawingTool === "measure") {
            return (
              <rect
                x={Math.min(x1, x2)}
                y={Math.min(y1, y2)}
                width={Math.abs(x2 - x1)}
                height={Math.abs(y2 - y1)}
                fill={`${drawingColor}33`}
                stroke={drawingColor}
                strokeWidth={drawingLineWidth}
                strokeDasharray={
                  drawingLineStyle === "dashed"
                    ? "6 4"
                    : drawingLineStyle === "dotted"
                      ? "2 2"
                      : undefined
                }
              />
            );
          }
          return null;
        })()}
    </>
  );

  const rsiDef = INDICATOR_DEFS.find((d) => d.id === "rsi")!;
  const atrDef = INDICATOR_DEFS.find((d) => d.id === "atr")!;

  return (
    <div className="tv-chart-wrapper">
      <DrawingToolbar
        activeTool={drawingTool === "cursor" ? null : drawingTool}
        onSelectTool={(tool) => {
          if (tool !== "cursor") lastDrawingToolRef.current = tool;
          activeDrawingStartRef.current = null;
          clearDrawingPreview();
          setSelectedDrawingId(null);
          setDrawingTool(tool);
        }}
        onClearAll={clearAllDrawings}
        hasDrawings={drawings.length > 0}
        fibLevels={fibLevels}
        onFibLevelsChange={updateFibLevels}
        selectedFibId={
          selectedDrawing && selectedDrawing.type === "fib"
            ? selectedDrawing.id
            : null
        }
        selectedDrawing={selectedDrawing ?? null}
        styleOpenRequest={styleOpenRequest}
        drawingColor={selectedDrawing?.color ?? drawingColor}
        drawingLineStyle={selectedDrawing?.lineStyle ?? drawingLineStyle}
        drawingLineWidth={selectedDrawing?.lineWidth ?? drawingLineWidth}
        onDrawingStyleChange={(style) => {
          setDrawingColor(style.color);
          setDrawingLineStyle(style.lineStyle ?? "solid");
          setDrawingLineWidth(style.lineWidth);
          if (selectedDrawingId) updateDrawingStyle(selectedDrawingId, style);
        }}
        onDeleteSelected={() =>
          selectedDrawingId && deleteDrawing(selectedDrawingId)
        }
        onEditSelectedNote={editSelectedNote}
      />

      <div className="tv-chart-main">
        <div
          className="chart-plot-area"
          style={{
            position: "relative",
            flex: "1 1 auto",
            minWidth: 0,
            minHeight: 0,
          }}
          onPointerDownCapture={(e) => {
            if (e.button === 1 && !limitPlacementSide) {
              e.preventDefault();
              e.stopPropagation();
              if (drawingTool === "cursor") {
                const lastTool = lastDrawingToolRef.current;
                if (lastTool) {
                  activeDrawingStartRef.current = null;
                  clearDrawingPreview();
                  setSelectedDrawingId(null);
                  setDrawingTool(lastTool);
                }
              } else {
                lastDrawingToolRef.current = drawingTool;
                activeDrawingStartRef.current = null;
                clearDrawingPreview();
                setSelectedDrawingId(null);
                setDrawingTool("cursor");
              }
              return;
            }
            if (drawingTool !== "cursor" || limitPlacementSide) return;
            const target = e.target as Element;
            const drawingTarget = target.closest("[data-drawing-id]");
            if (!drawingTarget) {
              setSelectedDrawingId(null);
              lastDrawingClickRef.current = null;
              return;
            }
            if (e.button !== 0 || e.metaKey || e.ctrlKey) return;
            const drawingId = drawingTarget.getAttribute("data-drawing-id");
            if (!drawingId) return;
            if (drawingId === selectedDrawingId) {
              lastDrawingClickRef.current = null;
              return;
            }

            const now = performance.now();
            const previousClick = lastDrawingClickRef.current;
            const isDoubleClick =
              previousClick?.id === drawingId &&
              now - previousClick.time <= 450 &&
              Math.hypot(e.clientX - previousClick.x, e.clientY - previousClick.y) <= 8;
            if (isDoubleClick) {
              lastDrawingClickRef.current = null;
              e.preventDefault();
              e.stopPropagation();
              setSelectedDrawingId(drawingId);
              setStyleOpenRequest((request) => request + 1);
              return;
            }

            lastDrawingClickRef.current = {
              id: drawingId,
              time: now,
              x: e.clientX,
              y: e.clientY,
            };
            const chart = chartRef.current;
            const visible = chart?.timeScale().getVisibleLogicalRange();
            if (!chart || !visible) return;
            panDragRef.current = {
              startX: e.clientX,
              from: visible.from,
              to: visible.to,
              barSpacing: chart.timeScale().options().barSpacing,
            };
            try {
              svgOverlayRef.current?.setPointerCapture(e.pointerId);
            } catch {
              panDragRef.current = null;
            }
          }}
          onClickCapture={(e) => {
            const target = e.target as Element;
            if (target.closest("[data-drawing-id]") && e.detail < 2)
              e.stopPropagation();
          }}
        >
          <div ref={containerRef} style={{ width: "100%", height: "100%" }} />
          {historyLoading && (
            <div
              className="chart-history-loading"
              role="status"
              aria-live="polite"
            >
              <span className="chart-history-spinner" aria-hidden="true" />
              <span>Loading full chart history…</span>
            </div>
          )}

          {/* SVG Drawing Layer */}
          <svg
            ref={svgOverlayRef}
            className="chart-drawing-overlay"
            style={{
              position: "absolute",
              inset: 0,
              width: "100%",
              height: "100%",
              pointerEvents:
                drawingTool !== "cursor" || limitPlacementSide
                  ? "auto"
                  : "none",
              cursor: limitPlacementSide
                ? "crosshair"
                : drawingTool !== "cursor"
                  ? "crosshair"
                  : "default",
              zIndex: 5,
            }}
            onContextMenu={(e) => {
              if (drawingTool !== "cursor") e.preventDefault();
            }}
            onPointerDownCapture={(e) => {
              const target = e.target as Element;
              const drawingId = target
                .closest("[data-drawing-id]")
                ?.getAttribute("data-drawing-id");
              if (!drawingId || limitPlacementSide) return;
              const drawing = drawingsRef.current.find(
                (item) => item.id === drawingId,
              );
              if (!drawing) return;
              if (target.tagName.toLowerCase() === "circle") {
                setSelectedDrawingId(drawingId);
                try {
                  e.currentTarget.setPointerCapture(e.pointerId);
                } catch {
                  // The pointer may already be captured by the browser during a canceled gesture.
                }
                return;
              }
              if (
                (e.metaKey || e.ctrlKey) &&
                e.button === 0 &&
                drawingTool === "cursor"
              ) {
                const point = pointAtClient(e.clientX, e.clientY);
                if (!point) return;
                e.stopPropagation();
                const duplicate = {
                  ...drawing,
                  id: createDrawingId(drawingsRef.current),
                };
                const next = [...drawingsRef.current, duplicate];
                drawingsRef.current = next;
                setDrawings(next);
                setSelectedDrawingId(duplicate.id);
                pendingDrawingDragRef.current = next;
                drawingDragRef.current = { drawing: duplicate, start: point };
                try {
                  e.currentTarget.setPointerCapture(e.pointerId);
                } catch {
                  drawingDragRef.current = null;
                  pendingDrawingDragRef.current = null;
                }
                return;
              }
              beginDrawingBodyDrag(e, drawing);
            }}
            onPointerMove={(e) => {
              const pan = panDragRef.current;
              const chart = chartRef.current;
              if (pan && chart) {
                if (Math.abs(e.clientX - pan.startX) > 6)
                  lastDrawingClickRef.current = null;
                const deltaBars = (e.clientX - pan.startX) / pan.barSpacing;
                chart
                  .timeScale()
                  .setVisibleLogicalRange({
                    from: pan.from - deltaBars,
                    to: pan.to - deltaBars,
                  });
                return;
              }
              const drag = draggingHandleRef.current;
              const point = pointAtClient(
                e.clientX,
                e.clientY,
                !!drag || !!drawingDragRef.current,
              );
              if (!point) return;
              const { time, price } = point;
              if (timeToX(time) == null && !drag && !drawingDragRef.current)
                return;

              if (drag) {
                const drawing = drawingsRef.current.find(
                  (item) => item.id === drag.drawingId,
                );
                const anchorTime =
                  drag.pointIndex === "tp" &&
                  drawing &&
                  (drawing.type === "long_position" ||
                    drawing.type === "short_position")
                    ? drawing.p2.time
                    : time;
                const pending = {
                  ...drag,
                  point: { time: anchorTime, price },
                };
                pendingAnchorDragRef.current = pending;
                if (anchorDragFrameRef.current == null) {
                  anchorDragFrameRef.current = requestAnimationFrame(() => {
                    anchorDragFrameRef.current = null;
                    const latest = pendingAnchorDragRef.current;
                    if (!latest) return;
                    const next = applyAnchorPoint(drawingsRef.current, latest);
                    drawingsRef.current = next;
                    setDrawings(next);
                  });
                }
                return;
              }

              const drawingDrag = drawingDragRef.current;
              if (drawingDrag) {
                const deltaTime = time - drawingDrag.start.time;
                const deltaPrice = price - drawingDrag.start.price;
                const movePoint = (anchor: ChartPoint): ChartPoint => ({
                  time: anchor.time + deltaTime,
                  price: anchor.price + deltaPrice,
                });
                const source = drawingDrag.drawing;
                const moved: ChartDrawing =
                  source.type === "long_position" ||
                  source.type === "short_position"
                    ? {
                        ...source,
                        p1: movePoint(source.p1),
                        p2: movePoint(source.p2),
                        ...(source.tp ? { tp: movePoint(source.tp) } : {}),
                      }
                    : source.p2
                      ? {
                          ...source,
                          p1: movePoint(source.p1),
                          p2: movePoint(source.p2),
                        }
                      : { ...source, p1: movePoint(source.p1) };
                pendingDrawingDragRef.current = drawingsRef.current.map((d) =>
                  d.id === moved.id ? moved : d,
                );
                if (drawingDragFrameRef.current == null) {
                  drawingDragFrameRef.current = requestAnimationFrame(() => {
                    drawingDragFrameRef.current = null;
                    const latest = pendingDrawingDragRef.current;
                    if (!latest) return;
                    drawingsRef.current = latest;
                    setDrawings(latest);
                  });
                }
                return;
              }

              if (drawingTool !== "cursor" && activeDrawingStartRef.current) {
                pendingPreviewRef.current = { time, price };
                if (previewFrameRef.current == null) {
                  previewFrameRef.current = requestAnimationFrame(() => {
                    previewFrameRef.current = null;
                    if (pendingPreviewRef.current)
                      setPreviewPoint(pendingPreviewRef.current);
                  });
                }
              }
            }}
            onPointerUp={finishAnchorDrag}
            onPointerCancel={finishAnchorDrag}
            onPointerDown={(e) => {
              if (limitPlacementSide) {
                if (e.button !== 0) return;
                const point = pointAtClient(e.clientX, e.clientY);
                if (!point) return;
                e.preventDefault();
                e.stopPropagation();
                const risk = riskSizingEnabled
                  ? { percent: riskPercent, stopDistance: quickStopDistance }
                  : null;
                const placed = onLimitOrder(
                  limitPlacementSide,
                  point.price,
                  quickLot,
                  risk,
                );
                setLimitPlacementSide(null);
                setLimitPlacementError(
                  placed
                    ? ""
                    : "Invalid limit price, stop distance, or risk is below minimum lot",
                );
                return;
              }
              if (drawingTool === "cursor") return;
              if (e.button !== 0 || e.shiftKey) {
                const chart = chartRef.current;
                const visible = chart?.timeScale().getVisibleLogicalRange();
                if (!chart || !visible) return;
                e.preventDefault();
                panDragRef.current = {
                  startX: e.clientX,
                  from: visible.from,
                  to: visible.to,
                  barSpacing: chart.timeScale().options().barSpacing,
                };
                try {
                  e.currentTarget.setPointerCapture(e.pointerId);
                } catch {
                  panDragRef.current = null;
                }
                return;
              }
              const rect = svgOverlayRef.current?.getBoundingClientRect();
              if (!rect) return;
              const x = e.clientX - rect.left;
              const y = e.clientY - rect.top;
              const series = seriesRef.current;
              const chart = chartRef.current;
              const container = containerRef.current;
              if (!series || !chart || !container) return;

              const plotWidth =
                container.clientWidth - chart.priceScale("right").width();
              if (
                x < 0 ||
                x >= plotWidth ||
                y < 0 ||
                y >= container.clientHeight
              )
                return;
              const point = pointAtClient(e.clientX, e.clientY);
              if (!point) return;
              const { time: pointTime, price } = point;

              if (drawingTool === "horizontal") {
                const newDrawing: ChartDrawing = {
                  id: createDrawingId(drawingsRef.current),
                  type: "horizontal",
                  p1: { time: pointTime, price },
                  color: drawingColor,
                  lineStyle: drawingLineStyle,
                  lineWidth: drawingLineWidth,
                };
                saveDrawings([...drawingsRef.current, newDrawing]);
                setSelectedDrawingId(newDrawing.id);
                setDrawingTool("cursor");
                setPreviewPoint(null);
              } else if (drawingTool === "horizontal_ray") {
                const newDrawing: ChartDrawing = {
                  id: createDrawingId(drawingsRef.current),
                  type: "horizontal_ray",
                  p1: { time: pointTime, price },
                  color: drawingColor,
                  lineStyle: drawingLineStyle,
                  lineWidth: drawingLineWidth,
                };
                saveDrawings([...drawingsRef.current, newDrawing]);
                setSelectedDrawingId(newDrawing.id);
                setDrawingTool("cursor");
                setPreviewPoint(null);
              } else if (drawingTool === "note") {
                openNoteEditor(
                  { time: pointTime, price },
                  e.clientX,
                  e.clientY,
                );
              } else if (
                drawingTool === "trendline" ||
                drawingTool === "ray" ||
                drawingTool === "rectangle" ||
                drawingTool === "measure" ||
                drawingTool === "fib" ||
                drawingTool === "long_position" ||
                drawingTool === "short_position"
              ) {
                if (!activeDrawingStartRef.current) {
                  activeDrawingStartRef.current = { time: pointTime, price };
                } else {
                  if (
                    (drawingTool === "long_position" &&
                      price >= activeDrawingStartRef.current.price) ||
                    (drawingTool === "short_position" &&
                      price <= activeDrawingStartRef.current.price)
                  ) {
                    return;
                  }
                  const isPositionDrawing =
                    drawingTool === "long_position" ||
                    drawingTool === "short_position";
                  const isLongPosition = drawingTool === "long_position";
                  const stopDistance = isLongPosition
                    ? activeDrawingStartRef.current.price - price
                    : price - activeDrawingStartRef.current.price;
                  const initialTp = isPositionDrawing
                    ? {
                        time: pointTime,
                        price:
                          activeDrawingStartRef.current.price +
                          (isLongPosition ? 1 : -1) * stopDistance * 2,
                      }
                    : undefined;
                  const newDrawing: ChartDrawing = {
                    id: createDrawingId(drawingsRef.current),
                    type: drawingTool,
                    p1: activeDrawingStartRef.current,
                    p2: { time: pointTime, price },
                    color: drawingColor,
                    lineStyle: drawingLineStyle,
                    lineWidth: drawingLineWidth,
                    ...(drawingTool === "fib"
                      ? { levels: [...fibLevelsRef.current] }
                      : {}),
                    ...(initialTp
                      ? { tp: initialTp, riskReward: 2 }
                      : {}),
                  };
                  saveDrawings([...drawingsRef.current, newDrawing]);
                  setSelectedDrawingId(newDrawing.id);
                  activeDrawingStartRef.current = null;
                  clearDrawingPreview();
                  setDrawingTool("cursor");
                }
              }
            }}
          >
            <OverlayRenderer
              ref={overlayRendererRef}
              render={renderOverlayItems}
            />
          </svg>

          {noteEditor && (
            <div
              className="chart-note-editor"
              style={{ left: noteEditor.left, top: noteEditor.top }}
              onPointerDown={(e) => e.stopPropagation()}
            >
              <div className="chart-note-editor-header">
                <strong>
                  {noteEditor.drawingId ? "Edit chart note" : "Add chart note"}
                </strong>
                <button
                  className="chart-note-close"
                  onClick={cancelNoteEditor}
                  aria-label="Close note editor"
                >
                  ×
                </button>
              </div>
              <textarea
                autoFocus
                value={noteEditor.text}
                onChange={(e) =>
                  setNoteEditor({ ...noteEditor, text: e.target.value })
                }
                onKeyDown={(e) => {
                  if (e.key === "Escape") cancelNoteEditor();
                  if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) saveNote();
                }}
                placeholder="Write a note about this price action…"
                maxLength={2000}
              />
              <div className="chart-note-editor-actions">
                <button
                  className="btn btn-secondary btn-tiny"
                  onClick={cancelNoteEditor}
                >
                  Cancel
                </button>
                <button className="btn btn-buy btn-tiny" onClick={saveNote}>
                  Save note
                </button>
              </div>
            </div>
          )}

          <div
            ref={priceLineRef}
            className="current-price-line"
            style={{ display: "none" }}
          />
          <div
            ref={priceLabelRef}
            className="current-price-label"
            style={{ display: "none" }}
          >
            <div ref={priceLabelPriceRef} className="current-price-value" />
            <div ref={priceLabelTimeRef} className="current-price-countdown" />
          </div>
          {orderLineTargets.flatMap((t) => {
            const kinds: OrderLineKind[] = t.orderKind
              ? ["sl", "tp", "trigger"]
              : ["sl", "tp"];
            return kinds.map((kind) => {
              const key = `${t.id}-${kind}`;
              const initialPrice =
                kind === "trigger"
                  ? t.anchorPrice
                  : ((kind === "sl" ? t.sl : t.tp) ?? t.anchorPrice);
              return (
                <div
                  key={key}
                  ref={(el) => {
                    if (el) orderLineRefs.current.set(key, el);
                    else orderLineRefs.current.delete(key);
                  }}
                  className={`sltp-drag-line sltp-drag-${kind}`}
                  style={{ display: "none" }}
                >
                  <div
                    className="sltp-drag-handle"
                    ref={(el) => {
                      if (el) orderHandleRefs.current.set(key, el);
                      else orderHandleRefs.current.delete(key);
                    }}
                    onPointerDown={(e) =>
                      startOrderLineDrag(e, t.id, kind, initialPrice)
                    }
                  />
                  <div
                    className={`sltp-price-tag sltp-price-tag-${kind}`}
                    ref={(el) => {
                      if (el) orderPriceTagRefs.current.set(key, el);
                      else orderPriceTagRefs.current.delete(key);
                    }}
                  />
                </div>
              );
            });
          })}
          <div
            className="chart-order-controls"
            onPointerDown={(e) => e.stopPropagation()}
          >
            {draft ? (
              <div className="chart-confirm-controls">
                <span className="chart-confirm-status">
                  {draft.side.toUpperCase()} {draft.kind.toUpperCase()} ·{" "}
                  {draftLot != null
                    ? `${draftLot.toFixed(2)} lot`
                    : "Set valid SL"}
                  {draft && (
                    <>
                      {" "}· Entry {draft.price.toFixed(pricePrecision)} · R:R{" "}
                      {formatRiskReward(
                        draft.side,
                        draft.price,
                        draft.sl,
                        draft.tp,
                      ) ?? "—"}
                    </>
                  )}
                </span>
                <button
                  className="btn btn-secondary btn-tiny"
                  onClick={onCancelDraft}
                >
                  Cancel
                </button>
                <button
                  className="btn btn-buy btn-tiny"
                  disabled={!canConfirmDraft}
                  onClick={onConfirmDraft}
                >
                  Confirm {draft.kind === "market" ? "Trade" : "Order"}
                </button>
              </div>
            ) : (
              <>
                {!riskSizingEnabled && (
                  <label
                    className="chart-lot-control"
                    title="Quick-trade volume in lots"
                  >
                    <span>Lot</span>
                    <input
                      type="number"
                      min="0.01"
                      max="50"
                      step="0.01"
                      value={quickLot}
                      onChange={(e) =>
                        onQuickLotChange(
                          Math.max(
                            0.01,
                            Math.min(
                              50,
                              Math.round(
                                (Number(e.target.value) || 0.01) * 100,
                              ) / 100,
                            ),
                          ),
                        )
                      }
                    />
                  </label>
                )}
                <label
                  className="chart-risk-toggle"
                  title="Size the order from account balance risk"
                >
                  <input
                    type="checkbox"
                    checked={riskSizingEnabled}
                    onChange={(e) => onRiskSizingChange(e.target.checked)}
                  />{" "}
                  Risk
                </label>
                {riskSizingEnabled && (
                  <>
                    <label
                      className="chart-lot-control"
                      title="Risk as a percent of account balance"
                    >
                      <span>%</span>
                      <input
                        type="number"
                        min="0.01"
                        max="100"
                        step="0.1"
                        value={riskPercent}
                        onChange={(e) =>
                          onRiskPercentChange(
                            Math.max(
                              0.01,
                              Math.min(100, Number(e.target.value) || 0.01),
                            ),
                          )
                        }
                      />
                    </label>
                    <label
                      className="chart-lot-control"
                      title="Stop distance in price units"
                    >
                      <span>SL Δ</span>
                      <input
                        type="number"
                        min="0.01"
                        step="0.1"
                        value={quickStopDistance}
                        onChange={(e) =>
                          onQuickStopDistanceChange(
                            Math.max(0.01, Number(e.target.value) || 0.01),
                          )
                        }
                      />
                    </label>
                  </>
                )}
                <button
                  className="btn btn-sell btn-tiny"
                  onClick={() => {
                    const risk = riskSizingEnabled
                      ? {
                          percent: riskPercent,
                          stopDistance: quickStopDistance,
                        }
                      : null;
                    if (!onMarketOrder("sell", quickLot, risk))
                      setLimitPlacementError("Set a valid stop distance");
                    else setLimitPlacementError("");
                  }}
                >
                  SELL
                </button>
                <button
                  className="btn btn-buy btn-tiny"
                  onClick={() => {
                    const risk = riskSizingEnabled
                      ? {
                          percent: riskPercent,
                          stopDistance: quickStopDistance,
                        }
                      : null;
                    if (!onMarketOrder("buy", quickLot, risk))
                      setLimitPlacementError("Set a valid stop distance");
                    else setLimitPlacementError("");
                  }}
                >
                  BUY
                </button>
                <button
                  className={`btn btn-secondary btn-tiny ${limitPlacementSide === "sell" ? "chart-limit-active" : ""}`}
                  onClick={() => {
                    setLimitPlacementError("");
                    setLimitPlacementSide((side) =>
                      side === "sell" ? null : "sell",
                    );
                  }}
                  title="Then click a price on the chart to create a Sell Limit preview"
                >
                  Sell Limit
                </button>
                <button
                  className={`btn btn-secondary btn-tiny ${limitPlacementSide === "buy" ? "chart-limit-active" : ""}`}
                  onClick={() => {
                    setLimitPlacementError("");
                    setLimitPlacementSide((side) =>
                      side === "buy" ? null : "buy",
                    );
                  }}
                  title="Then click a price on the chart to create a Buy Limit preview"
                >
                  Buy Limit
                </button>
                {limitPlacementSide && (
                  <span className="chart-limit-hint">
                    Click chart price…{" "}
                    <button onClick={() => setLimitPlacementSide(null)}>
                      ×
                    </button>
                  </span>
                )}
              </>
            )}
            {limitPlacementError && (
              <span className="chart-limit-error">{limitPlacementError}</span>
            )}
          </div>
        </div>
        <div className="chart-header">
          <div className="chart-tf-controls">
            {TIMEFRAMES.map((tf) => (
              <button
                key={tf}
                className={`chart-tf-btn ${tf === timeframe ? "chart-tf-btn-active" : ""}`}
                onClick={() => setTimeframe(tf)}
              >
                {tf}
              </button>
            ))}
          </div>
          <div className="chart-top-right-controls">
            <div ref={clockRef} className="chart-clock" />
            <div
              className="chart-appearance-control"
              onPointerDown={(e) => e.stopPropagation()}
            >
              <button
                className="chart-zoom-btn chart-appearance-toggle"
                onClick={() => setAppearanceOpen((open) => !open)}
                title="Chart appearance settings"
                aria-label="Chart appearance settings"
                aria-expanded={appearanceOpen}
              >
                Theme
              </button>
              {appearanceOpen && (
                <div
                  className="chart-appearance-panel"
                  role="dialog"
                  aria-label="Chart appearance settings"
                >
                  <div className="chart-appearance-title">Chart appearance</div>
                  <label className="chart-appearance-row">
                    <span>Background</span>
                    <input
                      aria-label="Chart background color"
                      type="color"
                      value={chartAppearance.background}
                      onChange={(e) =>
                        setChartAppearance((current) => ({
                          ...current,
                          background: e.target.value,
                        }))
                      }
                    />
                  </label>
                  <label className="chart-appearance-row">
                    <span>Text / price labels</span>
                    <input
                      aria-label="Chart text color"
                      type="color"
                      value={chartAppearance.textColor}
                      onChange={(e) =>
                        setChartAppearance((current) => ({
                          ...current,
                          textColor: e.target.value,
                        }))
                      }
                    />
                  </label>
                  <label className="chart-appearance-row">
                    <span>Axis borders</span>
                    <input
                      aria-label="Chart axis border color"
                      type="color"
                      value={chartAppearance.axisColor}
                      onChange={(e) =>
                        setChartAppearance((current) => ({
                          ...current,
                          axisColor: e.target.value,
                        }))
                      }
                    />
                  </label>
                  <label className="chart-appearance-row">
                    <span>Grid color</span>
                    <input
                      aria-label="Chart grid color"
                      type="color"
                      value={chartAppearance.gridColor}
                      onChange={(e) =>
                        setChartAppearance((current) => ({
                          ...current,
                          gridColor: e.target.value,
                        }))
                      }
                    />
                  </label>
                  <label className="chart-appearance-row">
                    <span>Horizontal grid</span>
                    <input
                      aria-label="Show horizontal grid"
                      type="checkbox"
                      checked={chartAppearance.horizontalGrid}
                      onChange={(e) =>
                        setChartAppearance((current) => ({
                          ...current,
                          horizontalGrid: e.target.checked,
                        }))
                      }
                    />
                  </label>
                  <label className="chart-appearance-row">
                    <span>Vertical grid</span>
                    <input
                      aria-label="Show vertical grid"
                      type="checkbox"
                      checked={chartAppearance.verticalGrid}
                      onChange={(e) =>
                        setChartAppearance((current) => ({
                          ...current,
                          verticalGrid: e.target.checked,
                        }))
                      }
                    />
                  </label>
                  <label className="chart-appearance-row">
                    <span>Bull candle</span>
                    <input
                      aria-label="Bull candle color"
                      type="color"
                      value={chartAppearance.upCandle}
                      onChange={(e) =>
                        setChartAppearance((current) => ({
                          ...current,
                          upCandle: e.target.value,
                        }))
                      }
                    />
                  </label>
                  <label className="chart-appearance-row">
                    <span>Bear candle</span>
                    <input
                      aria-label="Bear candle color"
                      type="color"
                      value={chartAppearance.downCandle}
                      onChange={(e) =>
                        setChartAppearance((current) => ({
                          ...current,
                          downCandle: e.target.value,
                        }))
                      }
                    />
                  </label>
                  <button
                    className="btn btn-secondary btn-tiny chart-appearance-reset"
                    onClick={() => setChartAppearance(DEFAULT_CHART_APPEARANCE)}
                  >
                    Reset defaults
                  </button>
                </div>
              )}
            </div>
            <IndicatorMenu
              state={indicatorState}
              sessionSettings={sessionSettings}
              onSessionSettingsChange={updateSessionSettings}
              onToggle={(id) =>
                setIndicatorState((s) => ({
                  ...s,
                  [id]: { ...s[id], enabled: !s[id].enabled },
                }))
              }
              onPeriodChange={(id, period) =>
                setIndicatorState((s) => ({ ...s, [id]: { ...s[id], period } }))
              }
            />
            <div className="chart-zoom-controls">
              <button
                className="chart-zoom-btn"
                onClick={() => zoom(1.3)}
                title="Zoom In"
              >
                +
              </button>
              <button
                className="chart-zoom-btn"
                onClick={() => zoom(1 / 1.3)}
                title="Zoom Out"
              >
                −
              </button>
            </div>
          </div>
        </div>

        {chartReady && chartRef.current && indicatorState.rsi.enabled && (
          <OscillatorPane
            def={rsiDef}
            mainChart={chartRef.current}
            onReady={(h) => {
              rsiHandleRef.current = h;
              h.setAll(rsi(displayedRef.current, indicatorState.rsi.period));
            }}
            onDestroy={() => {
              rsiHandleRef.current = null;
            }}
          />
        )}
        {chartReady && chartRef.current && indicatorState.atr.enabled && (
          <OscillatorPane
            def={atrDef}
            mainChart={chartRef.current}
            onReady={(h) => {
              atrHandleRef.current = h;
              h.setAll(atr(displayedRef.current, indicatorState.atr.period));
            }}
            onDestroy={() => {
              atrHandleRef.current = null;
            }}
          />
        )}
        <div
          className="playback-floating"
          onPointerDown={(e) => e.stopPropagation()}
        >
          <div className="playback-group">
            <button
              className="btn btn-secondary playback-btn"
              onClick={() => engine.stepCandles(-playbackStepCandles)}
              title={`Previous ${playbackStepTf} step (←)`}
              aria-label="Previous candles"
            >
              ⏮
            </button>
            <button
              className={`btn ${playing ? "btn-pause" : "btn-play"} playback-btn`}
              onClick={onPlayToggle}
              title="Play / pause (Space)"
              aria-label={playing ? "Pause replay" : "Play replay"}
            >
              {playing ? "⏸" : "▶"}
            </button>
            <button
              className="btn btn-secondary playback-btn"
              onClick={() => engine.stepCandles(playbackStepCandles)}
              title={`Next ${playbackStepTf} step (→)`}
              aria-label="Next candles"
            >
              ⏭
            </button>
            <select
              className="speed-select step-select"
              value={playbackStepTf}
              onChange={(e) => setPlaybackStepTf(e.target.value)}
              title="Number of candles moved by Next / Previous"
              aria-label="Playback step size"
            >
              {PLAYBACK_STEPS.map((step) => (
                <option key={step.id} value={step.id}>
                  step {step.label}
                </option>
              ))}
            </select>
          </div>
          <select
            className="speed-select playback-speed-select"
            value={speed}
            onChange={(e) => onSpeedChange(Number(e.target.value) as Speed)}
            title="Replay speed"
            aria-label="Replay speed"
          >
            {SPEED_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
          <button
            className="btn btn-secondary playback-save-btn"
            onClick={saveProgress}
            title="Save this account's backtest position"
            aria-label="Save backtest progress"
          >
            {progressSaved ? "Saved ✓" : "Save"}
          </button>
          <button
            className="btn btn-secondary playback-jump-btn"
            onClick={jumpToNext0600}
            title="Jump to the next day's 06:00 UTC time point"
            aria-label="Jump to next day at 06:00 UTC"
          >
            06:00 ↗
          </button>
        </div>
      </div>
    </div>
  );
}

export default memo(PriceChart);
