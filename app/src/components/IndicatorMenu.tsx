import { useState } from 'react'
import { INDICATOR_DEFS, type IndicatorState } from '../indicators/types'
import type { SessionLevelsSettings } from '../indicators/sessionLevels'

type Props = {
  state: IndicatorState
  sessionSettings: SessionLevelsSettings
  onSessionSettingsChange: (settings: Partial<SessionLevelsSettings>) => void
  onToggle: (id: (typeof INDICATOR_DEFS)[number]['id']) => void
  onPeriodChange: (id: (typeof INDICATOR_DEFS)[number]['id'], period: number) => void
}

const SESSION_TOGGLES: { key: keyof SessionLevelsSettings; label: string }[] = [
  { key: 'showPreviousDay', label: 'Previous day high / low (PDH / PDL)' },
  { key: 'showAsia', label: 'Asia high / low (AH / AL)' },
  { key: 'showLondon', label: 'London high / low (LH / LL)' },
  { key: 'showNYClose', label: 'Previous New York close (NYC)' },
  { key: 'showPreviousWeek', label: 'Previous week high / low (PWH / PWL)' },
  { key: 'showSessionLines', label: 'Session window boundaries' },
  { key: 'showTimePoints', label: 'Reference time lines' },
  { key: 'showBands', label: 'Session background bands' },
  { key: 'showLabels', label: 'Level labels' },
  { key: 'labelsHistory', label: 'Labels on historical days' },
]

const SESSION_COLORS: { key: keyof SessionLevelsSettings; label: string }[] = [
  { key: 'colPD', label: 'Previous day' },
  { key: 'colPW', label: 'Previous week' },
  { key: 'colNYC', label: 'NY close' },
  { key: 'colAsia', label: 'Asia levels' },
  { key: 'colLondon', label: 'London levels' },
  { key: 'colBandLon1', label: 'London first 90 min' },
  { key: 'colBandLon2', label: 'London next 90 min' },
  { key: 'colBandNY1', label: 'NY first hour' },
  { key: 'colBandNY2', label: 'NY next two hours' },
]

export default function IndicatorMenu({
  state,
  sessionSettings,
  onSessionSettingsChange,
  onToggle,
  onPeriodChange,
}: Props) {
  const [open, setOpen] = useState(false)
  const [sessionSettingsOpen, setSessionSettingsOpen] = useState(false)

  return (
    <div className="indicator-menu">
      <button className="chart-tf-btn indicator-menu-btn" onClick={() => setOpen((o) => !o)}>
        📊 Indicators
      </button>
      {open && (
        <div className="indicator-dropdown">
          {INDICATOR_DEFS.map((def) => {
            const s = state[def.id]
            const isSessions = def.id === 'sessions'
            return (
              <div key={def.id} className="indicator-row-wrap">
                <div className="indicator-row">
                  <label className="indicator-row-label">
                    <input type="checkbox" checked={s.enabled} onChange={() => onToggle(def.id)} />
                    <span style={{ color: def.color }}>{def.label}</span>
                  </label>
                  {def.hasPeriod && (
                    <input
                      className="indicator-period-input"
                      type="number"
                      min={1}
                      value={s.period}
                      onChange={(e) => onPeriodChange(def.id, Math.max(1, Number(e.target.value) || 1))}
                    />
                  )}
                  {isSessions && (
                    <button
                      className={`indicator-settings-toggle ${sessionSettingsOpen ? 'active' : ''}`}
                      onClick={() => setSessionSettingsOpen((value) => !value)}
                      title="Session indicator settings"
                      aria-label="Session indicator settings"
                    >⚙</button>
                  )}
                </div>
                {isSessions && sessionSettingsOpen && (
                  <div className="session-indicator-settings">
                    <div className="session-settings-title">Sessions &amp; Key Levels</div>
                    <div className="session-settings-grid">
                      <label>
                        History days
                        <input
                          type="number"
                          min={1}
                          max={100}
                          value={sessionSettings.historyDays}
                          onChange={(e) => onSessionSettingsChange({ historyDays: Math.max(1, Math.min(100, Number(e.target.value) || 1)) })}
                        />
                      </label>
                      <label>
                        Window (hours)
                        <input
                          type="number"
                          min={0.25}
                          max={8}
                          step={0.25}
                          value={sessionSettings.windowHours}
                          onChange={(e) => onSessionSettingsChange({ windowHours: Math.max(0.25, Math.min(8, Number(e.target.value) || 0.25)) })}
                        />
                      </label>
                      <label>Tokyo open (Tokyo)
                        <input type="time" value={sessionSettings.tokyoOpen} onChange={(e) => onSessionSettingsChange({ tokyoOpen: e.target.value })} />
                      </label>
                      <label>London open (London)
                        <input type="time" value={sessionSettings.londonOpen} onChange={(e) => onSessionSettingsChange({ londonOpen: e.target.value })} />
                      </label>
                      <label>New York open (New York)
                        <input type="time" value={sessionSettings.nyOpen} onChange={(e) => onSessionSettingsChange({ nyOpen: e.target.value })} />
                      </label>
                      <label>New York close (New York)
                        <input type="time" value={sessionSettings.nyClose} onChange={(e) => onSessionSettingsChange({ nyClose: e.target.value })} />
                      </label>
                    </div>

                    <div className="session-settings-subtitle">Display</div>
                    <div className="session-settings-toggles">
                      {SESSION_TOGGLES.map(({ key, label }) => (
                        <label key={key}>
                          <input
                            type="checkbox"
                            checked={Boolean(sessionSettings[key])}
                            onChange={(e) => onSessionSettingsChange({ [key]: e.target.checked })}
                          />
                          {label}
                        </label>
                      ))}
                    </div>

                    <div className="session-settings-grid session-style-numbers">
                      <label>Line width
                        <input type="number" min={1} max={5} value={sessionSettings.lineWidth} onChange={(e) => onSessionSettingsChange({ lineWidth: Math.max(1, Math.min(5, Number(e.target.value) || 1)) })} />
                      </label>
                      <label>Label font size
                        <input type="number" min={6} max={40} value={sessionSettings.labelFontSize} onChange={(e) => onSessionSettingsChange({ labelFontSize: Math.max(6, Math.min(40, Number(e.target.value) || 6)) })} />
                      </label>
                    </div>

                    <div className="session-settings-subtitle">Band opacity (0–100%)</div>
                    <div className="session-settings-grid">
                      <label>London first half
                        <input type="number" min={0} max={100} value={sessionSettings.bandLon1Opacity} onChange={(e) => onSessionSettingsChange({ bandLon1Opacity: Math.max(0, Math.min(100, Number(e.target.value) || 0)) })} />
                      </label>
                      <label>London second half
                        <input type="number" min={0} max={100} value={sessionSettings.bandLon2Opacity} onChange={(e) => onSessionSettingsChange({ bandLon2Opacity: Math.max(0, Math.min(100, Number(e.target.value) || 0)) })} />
                      </label>
                      <label>NY first half
                        <input type="number" min={0} max={100} value={sessionSettings.bandNY1Opacity} onChange={(e) => onSessionSettingsChange({ bandNY1Opacity: Math.max(0, Math.min(100, Number(e.target.value) || 0)) })} />
                      </label>
                      <label>NY second half
                        <input type="number" min={0} max={100} value={sessionSettings.bandNY2Opacity} onChange={(e) => onSessionSettingsChange({ bandNY2Opacity: Math.max(0, Math.min(100, Number(e.target.value) || 0)) })} />
                      </label>
                    </div>

                    <div className="session-settings-subtitle">Colors</div>
                    <div className="session-color-grid">
                      {SESSION_COLORS.map(({ key, label }) => (
                        <label key={key}>
                          <span>{label}</span>
                          <input
                            type="color"
                            value={String(sessionSettings[key])}
                            onChange={(e) => onSessionSettingsChange({ [key]: e.target.value })}
                          />
                        </label>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}
