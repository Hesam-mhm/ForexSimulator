import type { SymbolId } from "./symbols";

export type Bar = {
  time: number; // ms epoch, bar open time
  open: number;
  high: number;
  low: number;
  close: number;
  ticks: number;
};

export type MonthIndexEntry = {
  month: string;
  from: number;
  to: number;
  bars: number;
};

export type DataIndex = {
  symbols: Record<string, { months: MonthIndexEntry[] }>;
};

export type Side = "buy" | "sell";

export type Position = {
  id: number;
  symbol: SymbolId;
  side: Side;
  lot: number;
  openPrice: number;
  openTime: number;
  sl: number | null;
  tp: number | null;
};

export type ClosedTrade = Position & {
  closePrice: number;
  closeTime: number;
  pnl: number;
  reason: "manual" | "sl" | "tp" | "stopout";
};

export type AccountProfile = {
  id: string;
  name: string;
  balance: number;
  initialBalance: number;
  leverage: 500 | 1000;
  createdAt: number;
  backtestStartTime?: number;
  lastSimTime?: number;
  positions: Position[];
  pendingOrders: PendingOrder[];
  history: ClosedTrade[];
};

export type DrawingTool =
  | "cursor"
  | "trendline"
  | "ray"
  | "horizontal"
  | "horizontal_ray"
  | "rectangle"
  | "measure"
  | "fib"
  | "long_position"
  | "short_position"
  | "note";

export type DrawingType =
  | "trendline"
  | "ray"
  | "horizontal"
  | "horizontal_ray"
  | "rectangle"
  | "measure"
  | "fib"
  | "long_position"
  | "short_position"
  | "note";

export type DrawingPoint = {
  time: number; // unix seconds; independent of chart pixels and display timeframe
  price: number; // absolute instrument price
};

type ChartDrawingBase = {
  id: string;
  p1: DrawingPoint;
  color: string;
  lineWidth?: number;
  lineStyle?: "solid" | "dashed" | "dotted";
  /** Fibonacci target ratios measured from entry (p1) away from the stop (p2). */
  levels?: number[];
  text?: string;
};

export type ChartDrawing =
  | (ChartDrawingBase & {
      type: "horizontal" | "horizontal_ray" | "note";
      p2?: never;
    })
  | (ChartDrawingBase & {
      type: "trendline" | "ray" | "rectangle" | "measure" | "fib";
      p2: DrawingPoint;
    })
  | (ChartDrawingBase & {
      type: "long_position" | "short_position";
      p2: DrawingPoint;
      tp?: DrawingPoint;
      riskReward?: number;
    });

export type OrderKind = "stop" | "limit";

export type PendingOrder = {
  id: number;
  symbol: SymbolId;
  side: Side;
  kind: OrderKind;
  lot: number;
  triggerPrice: number;
  sl: number | null;
  tp: number | null;
  createdTime: number;
};

// sentinel id for an order that's being placed but not yet confirmed — lives
// only as local UI state (see App.tsx's `draft`), never in useTradingAccount
export const DRAFT_ORDER_ID = -1;

export type DraftOrderKind = "market" | OrderKind;

export type DraftOrder = {
  side: Side;
  kind: DraftOrderKind;
  lot: number;
  price: number;
  sl: number | null;
  tp: number | null;
} | null;

export type Speed = 1 | 2 | 5 | 10 | 30 | 60 | 300 | 900 | 3600;

export type EngineSnapshot = {
  simTime: number;
  bid: number;
  ask: number;
  playing: boolean;
  speed: Speed;
  ready: boolean;
};
