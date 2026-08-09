import { useEffect, useRef } from 'react';
import {
  createChart,
  ColorType,
  CandlestickSeries,
  LineSeries,
  HistogramSeries,
  type IChartApi,
  type IPrimitivePaneRenderer,
  type IPrimitivePaneView,
  type ISeriesApi,
  type ISeriesPrimitive,
  type PrimitivePaneViewZOrder,
  type SeriesAttachedParameter,
  type Time,
  type UTCTimestamp,
  type CandlestickData,
  type LineData,
  type HistogramData,
  type MouseEventParams,
} from 'lightweight-charts';
import type { CanvasRenderingTarget2D } from 'fancy-canvas';
import type { Bar } from '../core/types';
import { fmtPrice, fmtTime } from '../lib/format';
import { ema, macd, type MacdPoint } from '../core/indicators';

export interface IndicatorConfig {
  ema: { enabled: boolean; period: number };
  macd: { enabled: boolean; fast: number; slow: number; signal: number };
  volume: { enabled: boolean };
}

export const DEFAULT_INDICATORS: IndicatorConfig = {
  ema: { enabled: false, period: 20 },
  macd: { enabled: false, fast: 12, slow: 26, signal: 9 },
  volume: { enabled: true },
};

/** Trade fill marker shown on the chart (Binance-style badge: B/S). */
export interface TradeMarker {
  time: UTCTimestamp;
  color: string;
  text: string;
  price: number; // anchor price: bar low for buy, bar high for sell
  anchor: 'above' | 'below';
}

/** Custom primitive drawing solid circles with a centered white letter. */
class TradeMarkersPrimitive implements ISeriesPrimitive<Time> {
  markers: TradeMarker[] = [];
  chart: IChartApi | null = null;
  series: ISeriesApi<'Candlestick'> | null = null;
  private _requestUpdate: (() => void) | null = null;
  private _views: IPrimitivePaneView[] = [];

  setMarkers(markers: TradeMarker[]): void {
    this.markers = markers;
    this._requestUpdate?.();
  }

  attached(param: SeriesAttachedParameter<Time>): void {
    this.chart = param.chart;
    this.series = param.series as ISeriesApi<'Candlestick'>;
    this._requestUpdate = param.requestUpdate;
    this._views = [new TradeMarkersPaneView(this)];
  }

  detached(): void {
    this.chart = null;
    this.series = null;
    this._requestUpdate = null;
    this._views = [];
  }

  paneViews(): readonly IPrimitivePaneView[] {
    return this._views;
  }
}

class TradeMarkersPaneView implements IPrimitivePaneView {
  constructor(private readonly _p: TradeMarkersPrimitive) {}

  zOrder(): PrimitivePaneViewZOrder {
    return 'top';
  }

  renderer(): IPrimitivePaneRenderer {
    return new TradeMarkersRenderer(this._p);
  }
}

class TradeMarkersRenderer implements IPrimitivePaneRenderer {
  constructor(private readonly _p: TradeMarkersPrimitive) {}

  draw(target: CanvasRenderingTarget2D): void {
    const chart = this._p.chart;
    const series = this._p.series;
    if (!chart || !series) return;
    const markers = this._p.markers;
    if (markers.length === 0) return;

    target.useMediaCoordinateSpace((scope) => {
      const ctx = scope.context;
      for (const m of markers) {
        const x = chart.timeScale().timeToCoordinate(m.time);
        const yPrice = series.priceToCoordinate(m.price);
        if (x === null || yPrice === null) continue;
        const y = m.anchor === 'above' ? yPrice - 10 : yPrice + 10;
        const r = 7;
        ctx.beginPath();
        ctx.arc(x, y, r, 0, Math.PI * 2);
        ctx.fillStyle = m.color;
        ctx.shadowColor = m.color;
        ctx.shadowBlur = 5;
        ctx.fill();
        ctx.shadowBlur = 0;
        ctx.strokeStyle = 'rgba(0,0,0,0.25)';
        ctx.lineWidth = 1;
        ctx.stroke();
        ctx.fillStyle = '#ffffff';
        ctx.font = '700 10px -apple-system, "PingFang SC", "Microsoft YaHei", sans-serif';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(m.text, x, y + 0.5);
      }
    });
  }
}

interface Props {
  bars: Bar[];
  upColor?: string;
  downColor?: string;
  height?: number;
  tooltip?: boolean;
  indicators?: IndicatorConfig;
  markers?: TradeMarker[];
}

/** Dark panel background. */
const PANEL_BG = { type: ColorType.Solid, color: '#141922' } as const;

/** Resolve ms from a lightweight-charts time (UTCTimestamp | BusinessDay). */
function timeToMs(time: unknown): number {
  if (typeof time === 'number') return time * 1000;
  if (typeof time === 'string') return Date.parse(time);
  if (time && typeof time === 'object' && 'timestamp' in time) {
    return (time as { timestamp: number }).timestamp * 1000;
  }
  if (time && typeof time === 'object' && 'year' in time) {
    const b = time as { year: number; month: number; day: number };
    return Date.UTC(b.year, b.month - 1, b.day);
  }
  return 0;
}

/** Beijing-time crosshair label (full date + time). */
function beijingFullLabel(time: unknown): string {
  return new Date(timeToMs(time)).toLocaleString('zh-CN', {
    timeZone: 'Asia/Shanghai',
    hour12: false,
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
}

/** Beijing-time tick mark label for the x-axis. Returns ≤8 chars. */
function beijingTickLabel(time: unknown, tickMarkType: number): string | null {
  const ms = timeToMs(time);
  const d = new Date(ms);
  const fmt = (opts: Intl.DateTimeFormatOptions) =>
    d.toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false, ...opts });
  switch (tickMarkType) {
    case 0:
      return String(d.getFullYear());
    case 1:
      return fmt({ month: '2-digit', year: '2-digit' });
    case 2:
      return fmt({ month: '2-digit', day: '2-digit' });
    case 3:
      return fmt({ hour: '2-digit', minute: '2-digit' });
    case 4:
      return fmt({ hour: '2-digit', minute: '2-digit', second: '2-digit' });
    default:
      return fmt({ month: '2-digit', day: '2-digit' });
  }
}

export function KChart({
  bars,
  upColor = '#22c55e',
  downColor = '#ef4444',
  height = 420,
  tooltip = true,
  indicators = DEFAULT_INDICATORS,
  markers = [],
}: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const seriesRef = useRef<ISeriesApi<'Candlestick'> | null>(null);
  const markersRef = useRef<TradeMarkersPrimitive | null>(null);
  const volumeSeriesRef = useRef<ISeriesApi<'Histogram'> | null>(null);
  const emaSeriesRef = useRef<ISeriesApi<'Line'> | null>(null);
  const macdPaneRef = useRef<ReturnType<IChartApi['addPane']> | null>(null);
  const macdHistRef = useRef<ISeriesApi<'Histogram'> | null>(null);
  const macdLineRef = useRef<ISeriesApi<'Line'> | null>(null);
  const macdSignalRef = useRef<ISeriesApi<'Line'> | null>(null);
  const tooltipRef = useRef<HTMLDivElement | null>(null);
  const barsRef = useRef<Bar[]>([]);
  barsRef.current = bars;

  const macdEnabled = indicators.macd.enabled;
  const volumeEnabled = indicators.volume.enabled;

  // Build the single chart. pane 0 = candles + EMA; pane 1 = volume (optional); pane 2 = MACD (optional).
  useEffect(() => {
    if (!containerRef.current) return;
    const container = containerRef.current;
    container.innerHTML = '';

    const chart = createChart(container, {
      width: container.clientWidth,
      height: height + (volumeEnabled ? 80 : 0) + (macdEnabled ? 110 : 0),
      layout: {
        background: PANEL_BG,
        textColor: '#8b96a8',
        fontFamily: "'SF Mono', Menlo, Consolas, monospace",
        panes: {
          enableResize: true,
          separatorColor: '#232c3d',
          separatorHoverColor: 'rgba(59, 130, 246, 0.35)',
        },
      },
      grid: { vertLines: { color: '#1a2130' }, horzLines: { color: '#1a2130' } },
      rightPriceScale: { borderColor: '#232c3d' },
      localization: { timeFormatter: beijingFullLabel },
      timeScale: { borderColor: '#232c3d', timeVisible: true, secondsVisible: false, tickMarkFormatter: beijingTickLabel },
      crosshair: { mode: 0, vertLine: { color: '#3b82f6', width: 1, style: 3 }, horzLine: { color: '#3b82f6', width: 1, style: 3 } },
    });
    chartRef.current = chart;

    // Main pane (pane 0): candles + EMA overlay.
    const series = chart.addSeries(CandlestickSeries, {
      upColor,
      downColor,
      wickUpColor: upColor,
      wickDownColor: downColor,
      borderVisible: false,
    });
    const emaSeries = chart.addSeries(LineSeries, {
      color: '#f59e0b',
      lineWidth: 2,
      priceLineVisible: false,
      lastValueVisible: false,
      crosshairMarkerVisible: false,
      visible: false,
    });
    const markersPrimitive = new TradeMarkersPrimitive();
    series.attachPrimitive(markersPrimitive);
    markersPrimitive.setMarkers(markers);
    markersRef.current = markersPrimitive;
    seriesRef.current = series;
    emaSeriesRef.current = emaSeries;

    // Volume pane (optional) — shares the same timeScale as pane 0.
    if (volumeEnabled) {
      const volumePane = chart.addPane();
      const volumeSeries = volumePane.addSeries(HistogramSeries, {
        priceFormat: { type: 'volume' },
        priceLineVisible: false,
        lastValueVisible: false,
      });
      volumeSeriesRef.current = volumeSeries;
    }

    // MACD pane (optional) — shares the same timeScale as pane 0.
    if (macdEnabled) {
      const pane = chart.addPane();
      macdPaneRef.current = pane;
      const hist = pane.addSeries(HistogramSeries, {
        priceFormat: { type: 'price', precision: 6 },
        priceLineVisible: false,
      });
      const macdLine = pane.addSeries(LineSeries, {
        color: '#3b82f6',
        lineWidth: 1,
        priceLineVisible: false,
        lastValueVisible: false,
        crosshairMarkerVisible: false,
      });
      const signalLine = pane.addSeries(LineSeries, {
        color: '#f59e0b',
        lineWidth: 1,
        priceLineVisible: false,
        lastValueVisible: false,
        crosshairMarkerVisible: false,
      });
      macdHistRef.current = hist;
      macdLineRef.current = macdLine;
      macdSignalRef.current = signalLine;
    }

    // Floating tooltip on the container (anchored to the main pane area).
    const tip = document.createElement('div');
    tip.style.cssText =
      'position:absolute;pointer-events:none;background:#0b0e14;border:1px solid #232c3d;' +
      'border-radius:6px;padding:6px 9px;font-family:var(--mono);font-size:11px;' +
      'color:var(--text);z-index:10;white-space:nowrap;opacity:0;transition:opacity .12s;';
    container.appendChild(tip);
    tooltipRef.current = tip;

    const hide = () => {
      tip.style.opacity = '0';
    };
    const onCrosshair = (param: MouseEventParams) => {
      const time = param.time as number | undefined;
      if (time === undefined || param.point === undefined) return hide();
      const idx = barsRef.current.findIndex((b) => b.t / 1000 === time);
      const bar = idx >= 0 ? barsRef.current[idx] : undefined;
      if (!bar) return hide();
      const { x, y } = param.point;
      const up = bar.c >= bar.o;
      const html =
        `<div style="color:var(--muted)">${fmtTime(bar.t, { date: true })}</div>` +
        `<div><span style="color:var(--muted)">O </span>${fmtPrice(bar.o)}</div>` +
        `<div><span style="color:var(--muted)">H </span>${fmtPrice(bar.h)}</div>` +
        `<div><span style="color:var(--muted)">L </span>${fmtPrice(bar.l)}</div>` +
        `<div><span style="color:var(--muted)">C </span><b style="color:${up ? 'var(--green)' : 'var(--red)'}">${fmtPrice(bar.c)}</b></div>`;
      tip.innerHTML = html;
      const cw = container.clientWidth;
      const tw = tip.offsetWidth || 100;
      const th = tip.offsetHeight || 90;
      const left = x + 14 + tw > cw ? x - 14 - tw : x + 14;
      const top = y - th / 2 < 0 ? 4 : y - th / 2;
      tip.style.left = `${Math.max(0, left)}px`;
      tip.style.top = `${Math.max(0, top)}px`;
      tip.style.opacity = '1';
    };
    chart.subscribeCrosshairMove(onCrosshair);

    const ro = new ResizeObserver(() => {
      chart.applyOptions({ width: container.clientWidth });
    });
    ro.observe(container);

    return () => {
      chart.unsubscribeCrosshairMove(onCrosshair);
      ro.disconnect();
      tip.remove();
      if (markersRef.current) series.detachPrimitive(markersRef.current);
      chart.remove();
      chartRef.current = null;
      markersRef.current = null;
      seriesRef.current = null;
      volumeSeriesRef.current = null;
      emaSeriesRef.current = null;
      macdPaneRef.current = null;
      macdHistRef.current = null;
      macdLineRef.current = null;
      macdSignalRef.current = null;
      tooltipRef.current = null;
    };
  }, [height, upColor, downColor, tooltip, macdEnabled, volumeEnabled]);

  // Trade markers update independently of chart recreation.
  useEffect(() => {
    markersRef.current?.setMarkers(markers);
  }, [markers]);

  // Feed data.
  useEffect(() => {
    const series = seriesRef.current;
    if (!series) return;
    const candleData: CandlestickData[] = bars.map((b) => ({
      time: (b.t / 1000) as UTCTimestamp,
      open: b.o,
      high: b.h,
      low: b.l,
      close: b.c,
    }));
    series.setData(candleData);

    // Volume data.
    const volumeSeries = volumeSeriesRef.current;
    if (volumeSeries) {
      const volumeData: HistogramData[] = bars.map((b) => ({
        time: (b.t / 1000) as UTCTimestamp,
        value: b.v,
        color: b.c >= b.o ? 'rgba(34,197,94,0.3)' : 'rgba(239,68,68,0.3)',
      }));
      volumeSeries.setData(volumeData);
    }

    const emaSeries = emaSeriesRef.current;
    if (emaSeries) {
      const closes = bars.map((b) => b.c);
      const emaVals = indicators.ema.enabled ? ema(closes, indicators.ema.period) : [];
      const lineData: LineData[] = [];
      bars.forEach((b, i) => {
        const v = emaVals[i];
        if (v !== null && v !== undefined) lineData.push({ time: (b.t / 1000) as UTCTimestamp, value: v });
      });
      emaSeries.applyOptions({ visible: indicators.ema.enabled });
      emaSeries.setData(lineData);
    }

    if (indicators.macd.enabled && macdHistRef.current) {
      const closes = bars.map((b) => b.c);
      const pts: MacdPoint[] = macd(closes, indicators.macd.fast, indicators.macd.slow, indicators.macd.signal);
      const histData: HistogramData[] = [];
      const macdLineData: LineData[] = [];
      const signalData: LineData[] = [];
      bars.forEach((b, i) => {
        const t = (b.t / 1000) as UTCTimestamp;
        const p = pts[i];
        if (p.macd !== null) {
          macdLineData.push({ time: t, value: p.macd });
          histData.push({
            time: t,
            value: p.hist ?? 0,
            color: (p.hist ?? 0) >= 0 ? 'rgba(34,197,94,0.6)' : 'rgba(239,68,68,0.6)',
          });
        }
        if (p.signal !== null) signalData.push({ time: t, value: p.signal });
      });
      macdHistRef.current.setData(histData);
      macdLineRef.current?.setData(macdLineData);
      macdSignalRef.current?.setData(signalData);
    }
  }, [bars, indicators.ema.enabled, indicators.ema.period, indicators.macd.enabled, indicators.macd.fast, indicators.macd.slow, indicators.macd.signal, indicators.volume.enabled]);

  return (
    <div style={{ width: '100%' }}>
      <div ref={containerRef} style={{ position: 'relative', width: '100%' }} />
      {macdEnabled && (
        <div className="muted" style={{ fontSize: 11, marginTop: 2 }}>
          MACD {indicators.macd.fast}/{indicators.macd.slow}/{indicators.macd.signal}
        </div>
      )}
    </div>
  );
}
