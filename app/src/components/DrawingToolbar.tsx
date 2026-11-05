import { useEffect, useState } from 'react'
import type { ChartDrawing, DrawingTool } from '../types'

type Props = {
  activeTool: DrawingTool | null
  onSelectTool: (t: DrawingTool) => void
  onClearAll: () => void
  hasDrawings: boolean
  fibLevels: number[]
  onFibLevelsChange: (levels: number[]) => void
  selectedFibId: string | null
  selectedDrawing: ChartDrawing | null
  styleOpenRequest: number
  drawingColor: string
  drawingLineStyle: NonNullable<ChartDrawing['lineStyle']>
  drawingLineWidth: number
  onDrawingStyleChange: (style: { color: string; lineStyle: NonNullable<ChartDrawing['lineStyle']>; lineWidth: number }) => void
  onDeleteSelected: () => void
  onEditSelectedNote: () => void
}

type ToolItem = {
  id: DrawingTool
  title: string
  icon: JSX.Element
}

const DEFAULT_FIB_LEVELS = [0, 0.236, 0.382, 0.5, 0.618, 0.786, 1]

function parseLevels(raw: string): number[] | null {
  const parts = raw
    .split(/[\s,;]+/)
    .map((s) => s.trim())
    .filter(Boolean)
  if (!parts.length) return null
  const nums = parts.map((p) => Number(p))
  if (nums.length > 100 || nums.some((n) => !Number.isFinite(n))) return null
  // keep the editor input order (users often add extension levels above 1)
  return Array.from(new Set(nums))
}

export default function DrawingToolbar({
  activeTool,
  onSelectTool,
  onClearAll,
  hasDrawings,
  fibLevels,
  onFibLevelsChange,
  selectedFibId,
  selectedDrawing,
  styleOpenRequest,
  drawingColor,
  drawingLineStyle,
  drawingLineWidth,
  onDrawingStyleChange,
  onDeleteSelected,
  onEditSelectedNote,
}: Props) {
  const [levelsOpen, setLevelsOpen] = useState(false)
  const [styleOpen, setStyleOpen] = useState(false)
  const [levelsText, setLevelsText] = useState(fibLevels.join(', '))
  const [levelsError, setLevelsError] = useState(false)

  useEffect(() => {
    setLevelsText(fibLevels.join(', '))
  }, [fibLevels])

  useEffect(() => {
    if (styleOpenRequest > 0) setStyleOpen(true)
  }, [styleOpenRequest])

  useEffect(() => {
    if (!selectedDrawing) setStyleOpen(false)
  }, [selectedDrawing?.id])

  const applyLevels = () => {
    const parsed = parseLevels(levelsText)
    if (!parsed) {
      setLevelsError(true)
      return
    }
    setLevelsError(false)
    onFibLevelsChange(parsed)
  }

  const tools: ToolItem[] = [
    {
      id: 'cursor',
      title: 'Cursor / Select (V)',
      icon: (
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          <path d="M4 4l7 17 2.5-6.5L20 12 4 4z" />
        </svg>
      ),
    },
    {
      id: 'trendline',
      title: 'Trendline (Alt+T)',
      icon: (
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          <circle cx="5" cy="19" r="2" fill="currentColor" />
          <circle cx="19" cy="5" r="2" fill="currentColor" />
          <line x1="6.5" y1="17.5" x2="17.5" y2="6.5" />
        </svg>
      ),
    },
    {
      id: 'ray',
      title: 'Ray Line (Ray extended to infinity)',
      icon: (
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          <circle cx="5" cy="19" r="2" fill="currentColor" />
          <line x1="6.5" y1="17.5" x2="21" y2="3" />
          <polyline points="15 3 21 3 21 9" />
        </svg>
      ),
    },
    {
      id: 'horizontal',
      title: 'Horizontal Line (Alt+H)',
      icon: (
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          <line x1="2" y1="12" x2="22" y2="12" />
          <circle cx="12" cy="12" r="2" fill="currentColor" />
        </svg>
      ),
    },
    {
      id: 'horizontal_ray',
      title: 'Horizontal Ray (Alt+J)',
      icon: (
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          <circle cx="6" cy="12" r="2" fill="currentColor" />
          <line x1="8" y1="12" x2="22" y2="12" />
          <polyline points="18 8 22 12 18 16" />
        </svg>
      ),
    },
    {
      id: 'rectangle',
      title: 'Rectangle / Zone (Supply & Demand)',
      icon: (
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          <rect x="3" y="6" width="18" height="12" rx="2" />
        </svg>
      ),
    },
    {
      id: 'fib',
      title: 'Fibonacci Retracement (custom levels)',
      icon: (
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7">
          <line x1="3" y1="4" x2="21" y2="4" />
          <line x1="3" y1="8" x2="21" y2="8" />
          <line x1="3" y1="12" x2="21" y2="12" />
          <line x1="3" y1="16" x2="21" y2="16" />
          <line x1="3" y1="20" x2="21" y2="20" />
          <line x1="12" y1="2" x2="12" y2="22" strokeDasharray="2 2" />
        </svg>
      ),
    },
    {
      id: 'long_position',
      title: 'Long Position (entry, then stop loss; default 1:2 R:R)',
      icon: (
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7">
          <rect x="4" y="3" width="16" height="8" fill="#26a69a" fillOpacity="0.28" stroke="#26a69a" />
          <rect x="4" y="11" width="16" height="10" fill="#ef5350" fillOpacity="0.25" stroke="#ef5350" />
          <line x1="2" y1="11" x2="22" y2="11" />
        </svg>
      ),
    },
    {
      id: 'short_position',
      title: 'Short Position (entry, then stop loss; default 1:2 R:R)',
      icon: (
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7">
          <rect x="4" y="3" width="16" height="10" fill="#ef5350" fillOpacity="0.25" stroke="#ef5350" />
          <rect x="4" y="13" width="16" height="8" fill="#26a69a" fillOpacity="0.28" stroke="#26a69a" />
          <line x1="2" y1="13" x2="22" y2="13" />
        </svg>
      ),
    },
    {
      id: 'measure',
      title: 'Price Range / Measure (Shift+Click)',
      icon: (
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          <path d="M2 12h20M7 8v8M12 9v6M17 8v8M2 5v14M22 5v14" />
        </svg>
      ),
    },
    {
      id: 'note',
      title: 'Chart note (click to add)',
      icon: (
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          <path d="M5 3h10l4 4v14H5zM15 3v5h4M8 12h8M8 16h6" />
        </svg>
      ),
    },
  ]

  const fibLevelsBusy = activeTool === 'fib' || !!selectedFibId

  return (
    <div className="tv-drawing-toolbar">
      {tools.map((t) => (
        <button
          key={t.id}
          className={`tv-tool-btn ${activeTool === t.id ? 'tv-tool-btn-active' : ''}`}
          onClick={() => onSelectTool(activeTool === t.id && t.id !== 'cursor' ? 'cursor' : t.id)}
          title={t.title}
        >
          {t.icon}
        </button>
      ))}

      <div className="tv-tool-divider" />

      <button
        className={`tv-tool-btn ${styleOpen ? 'tv-tool-btn-active' : ''}`}
        onClick={() => setStyleOpen((v) => !v)}
        title={selectedDrawing ? 'Edit selected drawing style' : 'Drawing style for new objects'}
      >
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          <path d="M4 20l4.5-1 10.8-10.8a2.1 2.1 0 0 0-3-3L5.5 16 4 20z" />
          <path d="M14.5 6.5l3 3" />
        </svg>
      </button>

      {styleOpen && (
        <div className="tv-drawing-style-popover">
          <div className="tv-fib-popover-title">{selectedDrawing ? 'Selected drawing' : 'New drawings'}</div>
          <label className="tv-style-row">
            <span>Color</span>
            <input
              aria-label="Drawing color"
              type="color"
              value={drawingColor}
              onChange={(e) => onDrawingStyleChange({ color: e.target.value, lineStyle: drawingLineStyle, lineWidth: drawingLineWidth })}
            />
          </label>
          <label className="tv-style-row">
            <span>Line</span>
            <select
              aria-label="Drawing line style"
              value={drawingLineStyle}
              onChange={(e) => onDrawingStyleChange({ color: drawingColor, lineStyle: e.target.value as NonNullable<ChartDrawing['lineStyle']>, lineWidth: drawingLineWidth })}
            >
              <option value="solid">Solid</option>
              <option value="dashed">Dashed</option>
              <option value="dotted">Dotted</option>
            </select>
          </label>
          <label className="tv-style-row">
            <span>Width · {drawingLineWidth}px</span>
            <input
              aria-label="Drawing line width"
              type="range"
              min="1"
              max="5"
              step="1"
              value={drawingLineWidth}
              onChange={(e) => onDrawingStyleChange({ color: drawingColor, lineStyle: drawingLineStyle, lineWidth: Number(e.target.value) })}
            />
          </label>
          {selectedDrawing?.type === 'note' && (
            <button className="btn btn-secondary btn-tiny tv-style-delete" onClick={onEditSelectedNote}>
              Edit note
            </button>
          )}
          {selectedDrawing && (
            <button className="btn btn-secondary btn-tiny tv-style-delete" onClick={onDeleteSelected}>
              Delete selected
            </button>
          )}
        </div>
      )}

      <button
        className={`tv-tool-btn ${levelsOpen ? 'tv-tool-btn-active' : ''} ${fibLevelsBusy ? 'tv-tool-fib-levels' : ''}`}
        onClick={() => setLevelsOpen((v) => !v)}
        title="Edit Fibonacci levels (applies to selected / new Fibonacci drawings)"
      >
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          <path d="M4 6h16M4 12h16M4 18h16" />
          <circle cx="9" cy="6" r="2" fill="currentColor" />
          <circle cx="15" cy="12" r="2" fill="currentColor" />
          <circle cx="7" cy="18" r="2" fill="currentColor" />
        </svg>
      </button>

      {hasDrawings && (
        <button className="tv-tool-btn tv-tool-trash" onClick={onClearAll} title="Remove all drawings">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <polyline points="3 6 5 6 21 6" />
            <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
          </svg>
        </button>
      )}

      {levelsOpen && (
        <div className="tv-fib-popover">
          <div className="tv-fib-popover-title">Fibonacci levels</div>
          <div className="tv-fib-popover-hint">
            Entry to stop ratios — 0 = entry, positive values project targets beyond entry.
          </div>
          <input
            className={`tv-fib-levels-input ${levelsError ? 'tv-fib-levels-invalid' : ''}`}
            value={levelsText}
            onChange={(e) => {
              setLevelsText(e.target.value)
              setLevelsError(false)
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter') applyLevels()
            }}
            placeholder="0, 0.236, 0.382, 0.5, 0.618, 0.786, 1"
          />
          {levelsError && <div className="tv-fib-error">Enter up to 100 numeric ratios separated by commas.</div>}
          <div className="tv-fib-actions">
            <button className="btn btn-secondary btn-tiny" onClick={() => setLevelsText(DEFAULT_FIB_LEVELS.join(', '))}>
              Defaults
            </button>
            <button className="btn btn-buy btn-tiny" onClick={applyLevels}>
              Apply
            </button>
          </div>
          <div className="tv-fib-popover-note">
            {selectedFibId ? 'Applying updates the selected Fibonacci drawing.' : 'Applies to new Fibonacci drawings.'}
          </div>
        </div>
      )}
    </div>
  )
}

export { DEFAULT_FIB_LEVELS }
