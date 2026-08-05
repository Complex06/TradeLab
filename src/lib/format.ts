// Formatting helpers for prices, numbers, durations, and time display.

export function fmtPrice(x: number, decimals = 2): string {
  if (!Number.isFinite(x)) return '—';
  return x.toLocaleString('en-US', {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  });
}

export function fmtPct(x: number, decimals = 2): string {
  return `${(x * 100).toFixed(decimals)}%`;
}

export function fmtSigned(x: number, decimals = 2): string {
  const s = fmtPrice(x, decimals);
  return x > 0 ? `+${s}` : s;
}

export function fmtUsd(x: number): string {
  if (!Number.isFinite(x)) return '—';
  return `$${fmtPrice(x, 2)}`;
}

export function fmtQty(x: number): string {
  if (!Number.isFinite(x)) return '—';
  return x.toLocaleString('en-US', { maximumFractionDigits: 6 });
}

export function fmtTime(ts: number, opts?: { date?: boolean }): string {
  const d = new Date(ts);
  const time = d.toLocaleTimeString('zh-CN', { hour12: false, hour: '2-digit', minute: '2-digit' });
  if (opts?.date) {
    return `${d.toLocaleDateString('zh-CN')} ${time}`;
  }
  return time;
}

export function fmtDuration(ms: number): string {
  if (ms <= 0) return '0s';
  const s = Math.round(ms / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${sec}s`;
  return `${sec}s`;
}
