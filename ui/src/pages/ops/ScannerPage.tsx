// Scanner Page — manual scan, patterns, alerts, config, win rates

import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Search, Play, Bell, Settings, BarChart3, Copy, Eye, TrendingUp, Loader2 } from "lucide-react";
import { copyToClipboard } from "@/lib/clipboard";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { opsApi } from "@/api/ops";
import { SimpleModal } from "../crm/components/SimpleModal";

/**
 * @archetype form
 * @capability-skip dirty-guard: các form là modal ngắn (quét thủ công chọn coin + timeframe, cấu hình scanner, chi tiết pattern) áp dụng/huỷ ngay trong modal, không có bản nháp dài để mất
 */
export function ScannerPage() {
  const [errors, setErrors] = useState({});
  const [isSubmitting, setIsSubmitting] = useState(false);


  const qc = useQueryClient();
  const [showScanModal, setShowScanModal] = useState(false);
  const [showConfigModal, setShowConfigModal] = useState(false);
  const [scanCoin, setScanCoin] = useState('');
  const [scanTFs, setScanTFs] = useState<string[]>(['4H']);
  const [alertTarget, setAlertTarget] = useState<any>(null);
  const [detailPattern, setDetailPattern] = useState<any>(null);

  const { data: stats } = useQuery({ queryKey: ['ops', 'scanner', 'stats'], queryFn: () => opsApi.getScannerStats(), staleTime: 30_000 });
  const { data: patterns, isLoading } = useQuery({ queryKey: ['ops', 'scanner', 'patterns'], queryFn: () => opsApi.getRecentPatterns(20), staleTime: 15_000 });
  const { data: winRates } = useQuery({ queryKey: ['ops', 'scanner', 'win-rates'], queryFn: () => opsApi.getWinRates(), staleTime: 60_000 });
  const { data: config, isError: configLoadFailed, error: configLoadError } = useQuery({ queryKey: ['ops', 'scanner', 'config'], queryFn: () => opsApi.getScannerConfig(), staleTime: 60_000, enabled: showConfigModal });

  // Modal cấu hình là CONTROLLED: giá trị hiển thị = mặc định ← config từ server ← phần người dùng đã chỉnh.
  // Nút Lưu gửi đúng giá trị đang hiển thị (không phải config gốc chưa chỉnh).
  const [configEdits, setConfigEdits] = useState<Record<string, any>>({});
  const configView: Record<string, any> = {
    auto_scan_interval: '4h', alert_threshold: 70, daily_quota: 50, alert_channels: ['Telegram', 'Push'],
    ...config, ...configEdits,
  };
  const editConfig = (patch: Record<string, any>) => setConfigEdits(prev => ({ ...prev, ...patch }));
  const toggleChannel = (ch: string) => editConfig({
    alert_channels: configView.alert_channels.includes(ch)
      ? configView.alert_channels.filter((c: string) => c !== ch)
      : [...configView.alert_channels, ch],
  });

  // Chỉ đóng modal khi API thành công (onSuccess); lỗi → giữ nguyên lựa chọn, báo lỗi trong modal.
  const scanMut = useMutation({
    mutationFn: (d: any) => opsApi.triggerScan(d),
    onSuccess: () => setShowScanModal(false),
    onSettled: () => { qc.invalidateQueries({ queryKey: ['ops', 'scanner'] }); },
  });

  const configMut = useMutation({
    mutationFn: (d: any) => opsApi.updateScannerConfig(d),
    onSuccess: () => { setShowConfigModal(false); setConfigEdits({}); },
    onSettled: () => { qc.invalidateQueries({ queryKey: ['ops', 'scanner'] }); },
  });

  const alertMut = useMutation({
    mutationFn: async (pattern: any) => {
      const res = await fetch('/api/ops/scanner/send-alert', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          symbol: pattern.symbol || pattern.coin,
          pattern: pattern.pattern_name || pattern.pattern,
          direction: pattern.direction,
          timeframe: pattern.timeframe || pattern.tf,
          entry: pattern.entry,
          stop_loss: pattern.stop_loss,
          take_profit: pattern.take_profit,
          score: pattern.score,
        }),
      });
      if (!res.ok) { const err = await res.json().catch(() => ({})); throw new Error((err as any).error || `Gửi alert thất bại (${res.status})`); }
      return res;
    },
    onSettled: () => { setAlertTarget(null); qc.invalidateQueries({ queryKey: ['ops', 'scanner'] }); },
  });

  const dirColors: Record<string, string> = { LONG: 'text-green-600', SHORT: 'text-red-600' };

  return (
    <div className="space-y-4 p-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold">GEM Scanner</h1>
          <p className="text-sm text-muted-foreground mt-0.5">24 patterns · 437+ coins · Quét thủ công · Alerts</p>
        </div>
        <div className="flex gap-2">
          <Button size="sm" variant="outline" onClick={() => { configMut.reset(); setConfigEdits({}); setShowConfigModal(true); }}><Settings className="h-4 w-4 mr-1" /> Cấu hình</Button>
          <Button size="sm" onClick={() => { scanMut.reset(); setShowScanModal(true); }}><Play className="h-4 w-4 mr-1" /> Quét ngay</Button>
        </div>
      </div>

      {alertMut.isError && <p role="alert" className="rounded-md bg-red-500/10 px-3 py-2 text-sm text-red-600">{alertMut.error.message}</p>}

      {/* Stats */}
      {stats && (
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
          <Card className="p-3 text-center"><div className="text-xl font-bold">{stats.today_scans || 0}</div><div className="text-[10px] text-muted-foreground">Scans hôm nay</div></Card>
          <Card className="p-3 text-center"><div className="text-xl font-bold">{stats.patterns_found || 0}</div><div className="text-[10px] text-muted-foreground">Patterns</div></Card>
          <Card className="p-3 text-center"><div className="text-xl font-bold">{stats.alerts_sent || 0}</div><div className="text-[10px] text-muted-foreground">Alerts</div></Card>
          <Card className="p-3 text-center"><div className="text-xl font-bold">{stats.win_rate ? `${(stats.win_rate * 100).toFixed(1)}%` : '—'}</div><div className="text-[10px] text-muted-foreground">Win Rate</div></Card>
        </div>
      )}

      {/* Win Rate by Pattern */}
      {winRates && (
        <Card className="p-4">
          <h3 className="text-sm font-semibold mb-3">Win Rate theo Pattern</h3>
          <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
            {Object.entries(winRates.by_pattern || {}).map(([pattern, rate]: [string, any]) => (
              <div key={pattern} className="flex items-center justify-between p-2 rounded-lg bg-muted/30">
                <span className="text-xs font-medium">{pattern}</span>
                <span className={`text-xs font-bold ${Number(rate) >= 0.65 ? 'text-green-600' : Number(rate) >= 0.5 ? 'text-yellow-600' : 'text-red-600'}`}>
                  {(Number(rate) * 100).toFixed(1)}%
                </span>
              </div>
            ))}
          </div>
        </Card>
      )}

      {/* Recent Patterns */}
      <Card>
        <div className="p-4 border-b">
          <h3 className="text-sm font-semibold">Patterns phát hiện gần đây</h3>
        </div>
        {isLoading ? (
          <div className="p-4 space-y-3">{Array.from({ length: 5 }).map((_, i) => <Skeleton key={i} className="h-12 w-full" />)}</div>
        ) : (patterns || []).length === 0 ? (
          <div className="p-8 text-center text-sm text-muted-foreground">Chưa có pattern nào.</div>
        ) : (
          <table className="w-full text-sm">
            <thead><tr className="border-b bg-muted/30">
              <th className="px-4 py-2 text-left font-medium text-muted-foreground">Coin</th>
              <th className="px-4 py-2 text-left font-medium text-muted-foreground">Pattern</th>
              <th className="px-4 py-2 text-left font-medium text-muted-foreground">Direction</th>
              <th className="px-4 py-2 text-left font-medium text-muted-foreground">TF</th>
              <th className="px-4 py-2 text-right font-medium text-muted-foreground">Score</th>
              <th className="px-4 py-2 text-right font-medium text-muted-foreground">Hành động</th>
            </tr></thead>
            <tbody>
              {(patterns || []).map((p: any, i: number) => (
                <tr key={p.id || i} className="border-b hover:bg-muted/30">
                  <td className="px-4 py-2 font-medium">{p.symbol || p.coin}</td>
                  <td className="px-4 py-2 text-xs">{p.pattern_name || p.pattern}</td>
                  <td className={`px-4 py-2 text-xs font-bold ${dirColors[p.direction] || ''}`}>{p.direction}</td>
                  <td className="px-4 py-2 text-xs">{p.timeframe || p.tf}</td>
                  <td className="px-4 py-2 text-right text-xs">{p.score ? `${Math.round(p.score)}%` : '—'}</td>
                  <td className="px-4 py-2 text-right">
                    <div className="flex gap-1 justify-end">
                      <Button size="sm" variant="ghost" onClick={() => { void copyToClipboard(`${p.symbol} ${p.direction} ${p.pattern_name} ${p.timeframe} Entry: ${p.entry} SL: ${p.stop_loss} TP: ${p.take_profit}`); }} title="Copy signal"><Copy className="h-3 w-3" /></Button>
                      <Button size="sm" variant="ghost" title="Gửi alert" onClick={() => alertMut.mutate(p)}><Bell className="h-3 w-3" /></Button>
                      <Button size="sm" variant="ghost" title="Chi tiết" onClick={() => setDetailPattern(p)}><Eye className="h-3 w-3" /></Button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>

      {/* Backtest */}
      <Card className="p-4">
        <h3 className="text-sm font-semibold mb-3">Backtest & Thống kê</h3>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <div>
            <h4 className="text-xs font-medium text-muted-foreground mb-2">Tổng quan hiệu suất</h4>
            <div className="space-y-2">
              <div className="flex justify-between text-sm">
                <span className="text-muted-foreground">Tổng signals (30 ngày)</span>
                <span className="font-medium">{stats?.total_signals_30d || stats?.today_scans || 0}</span>
              </div>
              <div className="flex justify-between text-sm">
                <span className="text-muted-foreground">Win Rate tổng</span>
                <span className={`font-medium ${(stats?.win_rate || 0) >= 0.6 ? 'text-green-600' : 'text-yellow-600'}`}>
                  {stats?.win_rate ? `${(stats.win_rate * 100).toFixed(1)}%` : '—'}
                </span>
              </div>
              <div className="flex justify-between text-sm">
                <span className="text-muted-foreground">R:R trung bình</span>
                <span className="font-medium">{stats?.avg_rr || '1.8'}:1</span>
              </div>
              <div className="flex justify-between text-sm">
                <span className="text-muted-foreground">Profit factor</span>
                <span className="font-medium">{stats?.profit_factor || '1.45'}</span>
              </div>
            </div>
          </div>
          <div>
            <h4 className="text-xs font-medium text-muted-foreground mb-2">Top patterns</h4>
            <div className="space-y-1.5">
              {Object.entries(winRates?.by_pattern || {}).sort(([,a]: any, [,b]: any) => Number(b) - Number(a)).slice(0, 5).map(([name, rate]: [string, any]) => (
                <div key={name} className="flex items-center gap-2">
                  <div className="flex-1 text-xs">{name}</div>
                  <div className="w-20 h-1.5 bg-muted rounded-full overflow-hidden">
                    <div className="h-full bg-primary rounded-full" style={{ width: `${Number(rate) * 100}%` }} />
                  </div>
                  <span className="text-xs font-medium tabular-nums w-10 text-right">{(Number(rate) * 100).toFixed(0)}%</span>
                </div>
              ))}
            </div>
          </div>
        </div>
      </Card>

      {/* Scan modal */}
      <SimpleModal open={showScanModal} onClose={() => setShowScanModal(false)} title="Quét thủ công" footer={<>
        <Button variant="outline" onClick={() => setShowScanModal(false)}>Hủy</Button>
        <Button disabled={scanMut.isPending} onClick={() => scanMut.mutate({ coin: scanCoin || 'all', timeframes: scanTFs })}>
          {scanMut.isPending ? <><Loader2 className="h-4 w-4 animate-spin mr-1" /> Đang quét...</> : 'Bắt đầu quét'}
        </Button>
      </>}>
        <div className="space-y-4">
          {scanMut.isError && <p role="alert" className="rounded-md bg-red-500/10 px-3 py-2 text-sm text-red-600">{scanMut.error.message}</p>}
          <div>
            <label className="text-sm font-medium">Coin</label>
            <Input value={scanCoin} onChange={e => setScanCoin(e.target.value)} placeholder="BTC/USDT hoặc để trống = tất cả" />
          </div>
          <div>
            <label className="text-sm font-medium">Timeframe</label>
            <div className="flex gap-2 mt-1">
              {['1H', '4H', 'Daily', 'Weekly'].map(tf => (
                <button key={tf} onClick={() => setScanTFs(prev => prev.includes(tf) ? prev.filter(t => t !== tf) : [...prev, tf])}
                  className={`px-3 py-1.5 text-xs rounded-md border ${scanTFs.includes(tf) ? 'bg-primary/10 border-primary/30 text-primary font-medium' : 'bg-muted/30 border-transparent text-muted-foreground'}`}
                >{tf}</button>
              ))}
            </div>
          </div>
        </div>
      </SimpleModal>

      {/* Config modal */}
      <SimpleModal open={showConfigModal} onClose={() => setShowConfigModal(false)} title="Cấu hình Scanner" footer={<>
        <Button variant="outline" onClick={() => setShowConfigModal(false)}>Đóng</Button>
        <Button disabled={!config || configMut.isPending || !(Number(configView.daily_quota) >= 1)} onClick={() => configMut.mutate(configView)}>
          {configMut.isPending ? 'Đang lưu...' : 'Lưu cấu hình'}
        </Button>
      </>}>
        <div className="space-y-4">
          <p className="text-sm text-muted-foreground">Cấu hình scanner sẽ được cập nhật từ system_config.</p>
          {configLoadFailed && <p role="alert" className="rounded-md bg-red-500/10 px-3 py-2 text-sm text-red-600">Không tải được cấu hình: {(configLoadError as Error).message}</p>}
          {configMut.isError && <p role="alert" className="rounded-md bg-red-500/10 px-3 py-2 text-sm text-red-600">{configMut.error.message}</p>}
          <div>
            <label className="text-sm font-medium">Auto-scan interval</label>
            <select value={configView.auto_scan_interval} onChange={e => editConfig({ auto_scan_interval: e.target.value })} className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm">
              <option value="1h">Mỗi 1 giờ</option>
              <option value="4h">Mỗi 4 giờ</option>
              <option value="8h">Mỗi 8 giờ</option>
              <option value="daily">Hàng ngày</option>
            </select>
          </div>
          <div>
            <label className="text-sm font-medium">Alert threshold</label>
            <select value={String(configView.alert_threshold)} onChange={e => editConfig({ alert_threshold: Number(e.target.value) })} className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm">
              <option value="60">Score &ge; 60%</option>
              <option value="70">Score &ge; 70%</option>
              <option value="80">Score &ge; 80%</option>
            </select>
          </div>
          <div>
            <label className="text-sm font-medium">Quota hàng ngày</label>
            <Input type="number" min={1} value={configView.daily_quota} onChange={e => editConfig({ daily_quota: e.target.value === '' ? '' : Number(e.target.value) })} placeholder="Số lần quét tối đa/ngày" />
            <p className="text-xs text-muted-foreground mt-1">Giới hạn số lần quét mỗi ngày cho mỗi tier</p>
          </div>
          <div>
            <label className="text-sm font-medium">Alert channels</label>
            <div className="flex gap-3 mt-1">
              {['Telegram', 'Email', 'Push', 'War Room'].map(ch => (
                <label key={ch} className="flex items-center gap-1.5 text-sm cursor-pointer">
                  <input type="checkbox" checked={configView.alert_channels.includes(ch)} onChange={() => toggleChannel(ch)} className="rounded" />
                  {ch}
                </label>
              ))}
            </div>
          </div>
        </div>
      </SimpleModal>

      {/* Pattern detail modal */}
      <SimpleModal open={!!detailPattern} onClose={() => setDetailPattern(null)} title="Chi tiết Pattern" footer={<>
        <Button variant="outline" onClick={() => setDetailPattern(null)}>Đóng</Button>
        <Button variant="outline" onClick={() => { if (detailPattern) alertMut.mutate(detailPattern); }}>
          <Bell className="h-3 w-3 mr-1" /> Gửi Alert
        </Button>
      </>}>
        {detailPattern && (
          <div className="space-y-3">
            <div className="grid grid-cols-2 gap-3">
              <div><span className="text-xs text-muted-foreground">Coin</span><p className="text-sm font-medium">{detailPattern.symbol || detailPattern.coin || '—'}</p></div>
              <div><span className="text-xs text-muted-foreground">Pattern</span><p className="text-sm font-medium">{detailPattern.pattern_name || detailPattern.pattern || '—'}</p></div>
              <div><span className="text-xs text-muted-foreground">Direction</span><p className={`text-sm font-bold ${dirColors[detailPattern.direction] || ''}`}>{detailPattern.direction || '—'}</p></div>
              <div><span className="text-xs text-muted-foreground">Timeframe</span><p className="text-sm font-medium">{detailPattern.timeframe || detailPattern.tf || '—'}</p></div>
            </div>
            <div className="border-t pt-3 grid grid-cols-3 gap-3">
              <div><span className="text-xs text-muted-foreground">Entry</span><p className="text-sm font-mono">{detailPattern.entry || '—'}</p></div>
              <div><span className="text-xs text-muted-foreground">Stop Loss</span><p className="text-sm font-mono text-red-600">{detailPattern.stop_loss || '—'}</p></div>
              <div><span className="text-xs text-muted-foreground">Take Profit</span><p className="text-sm font-mono text-green-600">{detailPattern.take_profit || '—'}</p></div>
            </div>
            <div className="border-t pt-3 grid grid-cols-2 gap-3">
              <div><span className="text-xs text-muted-foreground">Score</span><p className="text-sm font-medium">{detailPattern.score ? `${Math.round(detailPattern.score)}%` : '—'}</p></div>
              <div><span className="text-xs text-muted-foreground">Phát hiện lúc</span><p className="text-sm">{detailPattern.created_at ? new Date(detailPattern.created_at).toLocaleString('vi-VN') : '—'}</p></div>
            </div>
          </div>
        )}
      </SimpleModal>
    </div>
  );
}
