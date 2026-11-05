import { useEffect, useRef } from 'react'
import { createChart, ColorType, type IChartApi, type ISeriesApi, type UTCTimestamp } from 'lightweight-charts'
import type { IndicatorDef } from '../indicators/types'

export type OscillatorHandle = {
  setAll: (points: { time: number; value: number }[]) => void
  updateLast: (point: { time: number; value: number }) => void
}

type Props = {
  def: IndicatorDef
  mainChart: IChartApi
  onReady: (handle: OscillatorHandle) => void
  onDestroy: () => void
}

export default function OscillatorPane({ def, mainChart, onReady, onDestroy }: Props) {
  const containerRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!containerRef.current) return
    const chart = createChart(containerRef.current, {
      layout: { background: { type: ColorType.Solid, color: '#0f1115' }, textColor: '#c7ccd6' },
      grid: { vertLines: { color: '#1b1f27' }, horzLines: { color: '#1b1f27' } },
      rightPriceScale: { borderColor: '#2a2f3a' },
      timeScale: { borderColor: '#2a2f3a', timeVisible: true, secondsVisible: false },
      crosshair: { mode: 0 },
      width: containerRef.current.clientWidth,
      height: containerRef.current.clientHeight,
    })
    const series = chart.addLineSeries({
      color: def.color,
      lineWidth: 2,
      priceLineVisible: false,
      autoscaleInfoProvider:
        def.paneMin != null && def.paneMax != null
          ? () => ({ priceRange: { minValue: def.paneMin!, maxValue: def.paneMax! } })
          : undefined,
    })

    def.refLines?.forEach((v) => {
      series.createPriceLine({
        price: v,
        color: '#3a3f4a',
        lineWidth: 1,
        lineStyle: 3,
        axisLabelVisible: true,
        title: '',
      })
    })

    const resize = () => {
      if (!containerRef.current) return
      chart.applyOptions({ width: containerRef.current.clientWidth, height: containerRef.current.clientHeight })
    }
    const ro = new ResizeObserver(resize)
    ro.observe(containerRef.current)

    // keep this pane's time axis glued to the main chart's, in both directions
    let syncing = false
    const fromMain = () => {
      if (syncing) return
      const range = mainChart.timeScale().getVisibleRange()
      if (!range) return
      syncing = true
      try {
        chart.timeScale().setVisibleRange(range)
      } catch {
        // lightweight-charts can't resolve a range against an empty/mismatched
        // series in some transient states — safe to just skip that sync tick
      }
      syncing = false
    }
    const fromThis = () => {
      if (syncing) return
      const range = chart.timeScale().getVisibleRange()
      if (!range) return
      syncing = true
      try {
        mainChart.timeScale().setVisibleRange(range)
      } catch {
        // see fromMain
      }
      syncing = false
    }
    const handle: OscillatorHandle = {
      setAll: (points) => series.setData(points.map((p) => ({ time: p.time as UTCTimestamp, value: p.value }))),
      updateLast: (point) => series.update({ time: point.time as UTCTimestamp, value: point.value }),
    }

    // must populate this pane's series with data BEFORE the first range sync —
    // lightweight-charts can't resolve a time range against an empty series
    // and throws ("Value is null") deep inside setVisibleRange otherwise
    onReady(handle)

    mainChart.timeScale().subscribeVisibleTimeRangeChange(fromMain)
    chart.timeScale().subscribeVisibleTimeRangeChange(fromThis)
    fromMain()

    return () => {
      mainChart.timeScale().unsubscribeVisibleTimeRangeChange(fromMain)
      ro.disconnect()
      chart.remove()
      onDestroy()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  return (
    <div className="oscillator-pane">
      <div className="oscillator-pane-label" style={{ color: def.color }}>
        {def.label}
      </div>
      <div ref={containerRef} style={{ width: '100%', height: '100%' }} />
    </div>
  )
}
