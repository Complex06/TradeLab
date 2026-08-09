import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useBootstrap, usePractices } from '../data/hooks';
import { deleteDataset, deletePractice, getDataset } from '../data/db';
import { downloadSymbolDataset } from '../data/download';
import { tfLabel } from '../core/aggregate';
import { fmtTime } from '../lib/format';

export function LibraryPage() {
  const { state, datasets, refresh: refreshDatasets, retry } = useBootstrap();
  const { practices, refresh: refreshPractices } = usePractices();
  const [dlSymbol, setDlSymbol] = useState('');
  const [dlDays, setDlDays] = useState(365);
  const [dlBusy, setDlBusy] = useState(false);
  const [dlMsg, setDlMsg] = useState<string | null>(null);
  const [dlErr, setDlErr] = useState<string | null>(null);

  async function downloadSymbol() {
    const sym = dlSymbol.trim().toUpperCase();
    if (!sym) {
      setDlErr('请输入品种代码');
      return;
    }
    if (!/^[A-Z0-9]+$/.test(sym)) {
      setDlErr('品种代码格式不正确，例如 BTCUSDT、XRPUSDT');
      return;
    }
    setDlErr(null);
    setDlMsg(null);
    setDlBusy(true);
    try {
      const existing = await getDataset(sym);
      if (existing) {
        setDlErr(`品种 ${sym} 已存在，无需重复下载`);
        return;
      }
      await downloadSymbolDataset(sym, {
        days: dlDays,
        onProgress: (p) => {
          setDlMsg(`正在下载 ${p.message ?? sym} …`);
        },
      });
      await refreshDatasets();
      const rangeLabel = dlDays === 0 ? '全部历史' : `最近 ${dlDays} 天`;
      setDlMsg(`品种 ${sym}（${rangeLabel}）下载完成，已加入练习库`);
    } catch (err) {
      setDlErr(err instanceof Error ? err.message : String(err));
    } finally {
      setDlBusy(false);
    }
  }

  async function removeDataset(symbol: string) {
    await deleteDataset(symbol);
    await refreshDatasets();
  }

  async function removePractice(id: string) {
    await deletePractice(id);
    await refreshPractices();
  }

  return (
    <div className="page">
      <h1>练习列表</h1>

      {/* first-run bootstrap status */}
      {state.status !== 'ready' && (
        <div className="card">
          <h2>数据准备</h2>
          {state.status === 'downloading' && (
            <>
              <p className="muted" style={{ margin: '0 0 10px' }}>
                {state.progress?.message ?? '正在下载…'}
              </p>
              {state.progress && (
                <>
                  <div
                    style={{
                      height: 8,
                      background: 'var(--panel2)',
                      borderRadius: 4,
                      overflow: 'hidden',
                      marginBottom: 6,
                    }}
                  >
                    <div
                      style={{
                        height: '100%',
                        width: `${state.progress.total > 0 ? (state.progress.done / state.progress.total) * 100 : 0}%`,
                        background: 'var(--blue)',
                        transition: 'width .3s',
                      }}
                    />
                  </div>
                  <p className="muted" style={{ fontSize: 12, margin: 0 }}>
                    {state.progress.done} / {state.progress.total} 个品种
                  </p>
                </>
              )}
              <p className="muted" style={{ fontSize: 11, margin: '8px 0 0' }}>
                首次使用需联网从 Binance 公共数据下载 {state.progress?.total ?? 5} 个品种（BTC/ETH/SOL/BNB/HYPE）
                最近一年 5m K 线。下载完成后完全离线可用。
              </p>
            </>
          )}
          {state.status === 'error' && (
            <>
              <p className="down" style={{ margin: 0 }}>
                数据下载失败：{state.error}
              </p>
              <p className="muted" style={{ fontSize: 12, margin: '6px 0' }}>
                请检查网络连接后重试。数据只需下载一次。
              </p>
              <button className="btn primary" onClick={() => void retry()}>
                重试下载
              </button>
            </>
          )}
        </div>
      )}

      <div className="card">
        <h2>可用品种</h2>
        <div className="row" style={{ marginBottom: 10 }}>
          <input
            type="text"
            placeholder="输入品种代码，如 XRPUSDT"
            value={dlSymbol}
            onChange={(e) => setDlSymbol(e.target.value)}
            className="grow"
            onKeyDown={(e) => {
              if (e.key === 'Enter') void downloadSymbol();
            }}
          />
          <select
            value={dlDays}
            onChange={(e) => setDlDays(Number(e.target.value))}
            style={{ width: 112, flexShrink: 0 }}
          >
            <option value={31}>近 1 个月</option>
            <option value={92}>近 3 个月</option>
            <option value={183}>近 6 个月</option>
            <option value={365}>近 1 年</option>
            <option value={730}>近 2 年</option>
            <option value={1095}>近 3 年</option>
            <option value={0}>全部历史</option>
          </select>
          <button className="btn primary" onClick={() => void downloadSymbol()} disabled={dlBusy}>
            {dlBusy ? '下载中…' : '下载品种'}
          </button>
        </div>
        {dlErr && <p className="down" style={{ fontSize: 12, margin: '0 0 8px' }}>{dlErr}</p>}
        {dlMsg && <p className="up" style={{ fontSize: 12, margin: '0 0 8px' }}>{dlMsg}</p>}
        {datasets.length === 0 ? (
          <div className="empty">
            {state.status === 'downloading' ? '正在准备数据…' : '暂无数据，请等待下载或重试。'}
          </div>
        ) : (
          <table>
            <thead>
              <tr><th>品种</th><th>K 线数（5m）</th><th>时间范围</th><th>可回放</th><th></th></tr>
            </thead>
            <tbody>
              {datasets.map((d) => {
                const first = d.bars[0];
                const last = d.bars[d.bars.length - 1];
                return (
                  <tr key={d.symbol}>
                    <td className="mono">{d.symbol}</td>
                    <td className="mono">{d.bars.length.toLocaleString()}</td>
                    <td className="mono muted">
                      {first ? fmtTime(first.t, { date: true }) : '—'} → {last ? fmtTime(last.t, { date: true }) : '—'}
                    </td>
                    <td>
                      <Link to={`/setup?symbol=${d.symbol}`}>
                        <button className="btn primary" style={{ padding: '4px 10px' }}>
                          用此品种练习
                        </button>
                      </Link>
                    </td>
                    <td>
                      <button className="btn ghost" onClick={() => removeDataset(d.symbol)}>
                        删除
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>

      <div className="card">
        <h2>练习会话</h2>
        {practices.length === 0 ? (
          <div className="empty">
            还没有练习。<Link to="/setup">新建一次练习</Link>
          </div>
        ) : (
          <table>
            <thead>
              <tr><th>品种</th><th>周期</th><th>进度</th><th>余额</th><th>状态</th><th></th></tr>
            </thead>
            <tbody>
              {practices.map((p) => {
                return (
                  <tr key={p.sessionId}>
                    <td className="mono">{p.hidden && !p.revealed ? '•••' : p.symbol}</td>
                    <td>{tfLabel(p.tfMs)}</td>
                    <td className="mono">{p.currentIndex - p.startIndex + 1} 根 / 已推进</td>
                    <td className="mono">{p.balance.toFixed(2)}</td>
                    <td>{p.completed ? '已完成' : p.position ? '持仓中' : '待开仓'}</td>
                    <td className="row" style={{ justifyContent: 'flex-end' }}>
                      <Link to={`/practice/${p.sessionId}`}>
                        <button className="btn primary" style={{ padding: '4px 10px' }}>
                          {p.completed ? '查看报告' : '继续练习'}
                        </button>
                      </Link>
                      <button className="btn ghost" onClick={() => removePractice(p.sessionId)}>
                        删除
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
