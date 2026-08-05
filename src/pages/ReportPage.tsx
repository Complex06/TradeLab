import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { getPractice, savePractice } from '../data/db';
import { tfLabel } from '../core/aggregate';
import { computeStats } from '../core/engine';
import { fmtUsd, fmtPrice, fmtQty, fmtSigned, fmtPct, fmtDuration, fmtTime } from '../lib/format';
import { downloadCsv } from '../lib/csv';
import type { PracticeState } from '../core/types';

export function ReportPage() {
  const { sessionId } = useParams();
  const [state, setState] = useState<PracticeState | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    (async () => {
      if (!sessionId) return;
      const p = await getPractice(sessionId);
      if (!p) {
        setError('练习不存在');
        return;
      }
      // Ensure stats computed (compute if missing).
      let s = p;
      if (!s.stats) {
        s = { ...p, stats: computeStats(p) };
        await savePractice(s);
      }
      // Reveal hidden symbol/date on report (D26).
      if (s.hidden && !s.revealed) {
        s = { ...s, revealed: true, hidden: false };
        await savePractice(s);
      }
      setState(s);
    })();
  }, [sessionId]);

  if (error) return <div className="page"><p className="down">{error}</p></div>;
  if (!state || !state.stats) return <div className="page"><p className="muted">加载中…</p></div>;

  const st = state.stats;
  const exportReportCsv = () => {
    downloadCsv(`tradelab-report-${state.sessionId.slice(-6)}.csv`, [
      ['指标', '值'],
      ['品种', state.symbol],
      ['周期', tfLabel(state.tfMs)],
      ['初始资金', state.initialCapital],
      ['期末余额', state.balance],
      ['盈亏金额', st.netPnl],
      ['盈亏率', st.pnlPct],
      ['交易次数', st.tradeCount],
      ['胜率', st.winRate],
      ['盈亏比', st.profitFactor],
      ['最大回撤', st.maxDrawdown],
      ['平均持仓时间(ms)', st.avgHoldTimeMs],
      ['平均持仓时间', fmtDuration(st.avgHoldTimeMs)],
      ['总手续费', st.totalFee],
      ['爆仓次数', st.totalLiqCount],
    ]);
  }

  const exportTradesCsv = () => {
    downloadCsv(`tradelab-trades-${state.sessionId.slice(-6)}.csv`, [
      ['时间', '动作', '数量', '价格', '手续费', '强平'],
      ...state.tradeRecords.map((r) => [
        fmtTime(r.ts, { date: true }),
        actionLabel(r.action),
        r.qty,
        r.price,
        r.fee,
        r.liq ? '是' : '',
      ]),
    ]);
  }

  const cells: Array<[string, string]> = [
    ['盈亏金额', fmtSigned(st.netPnl)],
    ['盈亏率', fmtSigned(st.pnlPct * 100) + '%'],
    ['胜率', fmtPct(st.winRate)],
    ['盈亏比', st.profitFactor === Infinity ? '∞' : fmtPrice(st.profitFactor)],
    ['最大回撤', fmtPct(st.maxDrawdown)],
    ['平均持仓时间', fmtDuration(st.avgHoldTimeMs)],
    ['交易次数', String(st.tradeCount)],
    ['爆仓次数', String(st.totalLiqCount)],
    ['总手续费', fmtUsd(st.totalFee)],
  ];

  return (
    <div className="page" style={{ maxWidth: 760 }}>
      <div className="row" style={{ justifyContent: 'space-between', flexWrap: 'wrap', gap: 10 }}>
        <h1 style={{ margin: 0, fontSize: 20 }}>
          练习报告 <span className="muted" style={{ fontSize: 14 }}>{state.symbol} · {tfLabel(state.tfMs)}</span>
        </h1>
        <div className="row" style={{ gap: 8 }}>
          <Link to={`/practice/${state.sessionId}`}>
            <button className="btn">返回练习</button>
          </Link>
          <button className="btn" onClick={exportReportCsv}>导出报告 CSV</button>
          <button className="btn" onClick={exportTradesCsv}>导出成交 CSV</button>
        </div>
      </div>

      <div className="card" style={{ marginTop: 16 }}>
        <h2>核心指标</h2>
        <table>
          <tbody>
            {cells.map(([k, v]) => (
              <tr key={k}>
                <td style={{ color: 'var(--muted)' }}>{k}</td>
                <td className={`mono ${k === '盈亏金额' || k === '盈亏率' ? (st.netPnl >= 0 ? 'up' : 'down') : ''}`}>{v}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <p className="muted" style={{ marginTop: 12, fontSize: 12 }}>
          品种与日期已在报告页揭晓。期末余额 {fmtUsd(state.balance)}，初始资金 {fmtUsd(state.initialCapital)}。
        </p>
      </div>

      <div className="card">
        <h2>成交记录 ({state.tradeRecords.length})</h2>
        {state.tradeRecords.length === 0 ? (
          <div className="empty">本次练习无成交</div>
        ) : (
          <table>
            <thead>
              <tr><th>时间</th><th>动作</th><th>数量</th><th>价格</th><th>手续费</th></tr>
            </thead>
            <tbody>
              {state.tradeRecords.map((r) => (
                <tr key={r.id}>
                  <td className="mono">{fmtTime(r.ts, { date: true })}</td>
                  <td>
                    {r.liq ? <span className="badge" style={{ background: 'rgba(239,68,68,.2)', color: '#ef4444' }}>强平</span> : actionLabel(r.action)}
                  </td>
                  <td className="mono">{fmtQty(r.qty)}</td>
                  <td className="mono">{fmtPrice(r.price)}</td>
                  <td className="mono">{fmtUsd(r.fee)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}

function actionLabel(a: string): string {
  switch (a) {
    case 'openLong':
      return '开多';
    case 'openShort':
      return '开空';
    case 'closeLong':
      return '平多';
    case 'closeShort':
      return '平空';
    default:
      return a;
  }
}
