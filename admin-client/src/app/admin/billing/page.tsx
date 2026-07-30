'use client';

import { useEffect, useState, useCallback } from 'react';
import { adminApi as api } from '@/lib/api';
import { Download, Search, X, ChevronDown, ChevronUp } from 'lucide-react';

type BillingTab = 'models' | 'users';

// source 显示名称映射（可扩展）
const SOURCE_LABELS: Record<string, string> = {
  volcano: '火山引擎',
  local: '自部署',
};
function sourceLabel(s: string) { return SOURCE_LABELS[s] || s; }

// source 颜色映射
const SOURCE_COLORS: Record<string, { border: string; text: string }> = {
  volcano: { border: 'border-l-orange-500', text: 'text-orange-600' },
  local: { border: 'border-l-green-500', text: 'text-green-600' },
};
function sourceColor(s: string) { return SOURCE_COLORS[s] || { border: 'border-l-gray-400', text: 'text-gray-600' }; }

export default function AdminBillingPage() {
  const [tab, setTab] = useState<BillingTab>('models');
  const [data, setData] = useState<any>(null);
  const [loading, setLoading] = useState(false);
  const [page, setPage] = useState(1);

  const today = new Date().toISOString().slice(0, 10);
  const weekAgo = new Date(Date.now() - 7 * 86400000).toISOString().slice(0, 10);
  const [startDate, setStartDate] = useState(weekAgo);
  const [endDate, setEndDate] = useState(today);

  // 搜索 & 筛选
  const [search, setSearch] = useState('');
  const [source, setSource] = useState('');
  // 模型账单分组折叠
  const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(new Set());

  const buildParams = useCallback((extraLimit?: string) => {
    const params = new URLSearchParams({ page: String(page), limit: extraLimit || '50' });
    if (startDate) params.set('startDate', startDate);
    if (endDate) params.set('endDate', endDate + 'T23:59:59');
    if (search) params.set('search', search);
    if (source) params.set('source', source);
    return params;
  }, [page, startDate, endDate, search, source]);

  const load = useCallback(async () => {
    setLoading(true);
    const path = tab === 'models' ? '/api/v1/admin/billing/models' : '/api/v1/admin/billing/users';
    const res = await api.get(path + '?' + buildParams());
    if (res.success) setData(res.data);
    setLoading(false);
  }, [tab, buildParams]);

  useEffect(() => { setPage(1); load(); }, [tab, startDate, endDate, search, source]);
  useEffect(() => { load(); }, [page]);

  const fmt = (n: number) => n?.toFixed(4) || '0';

  // 搜索防抖
  const [searchInput, setSearchInput] = useState('');
  useEffect(() => {
    if (searchInput === search) return;
    const t = setTimeout(() => setSearch(searchInput), 400);
    return () => clearTimeout(t);
  }, [searchInput]);

  // 导出 CSV — 全量明细（带当前筛选条件）
  const exportCSV = async (filename: string) => {
    const path = tab === 'models' ? '/api/v1/admin/billing/models' : '/api/v1/admin/billing/users';
    const res = await api.get(path + '?' + buildParams('99999'));
    if (!res.success) return;

    const resData = res.data as any;
    if (!resData?.items) return;

    const items = resData.items;
    const headers = ['ID', '用户名', '模型', '来源', '模型类型', '输入Tokens', '输出Tokens', '耗时(ms)', '消耗', '调用时间'];
    const rows = items.map((r: any) => headers.map(h => {
      const map: Record<string, string> = {
        'ID': String(r.id),
        '用户名': r.user,
        '模型': r.model,
        '来源': sourceLabel(r.source),
        '模型类型': r.modelType,
        '输入Tokens': String(r.tokensInput),
        '输出Tokens': String(r.tokensOutput),
        '耗时(ms)': String(r.durationMs || ''),
        '消耗': String(r.cost),
        '调用时间': new Date(r.createdAt).toLocaleString('zh-CN'),
      };
      const v = map[h] || '';
      return v.includes(',') || v.includes('"') ? `"${v.replace(/"/g, '""')}"` : v;
    }));

    const csv = ['\uFEFF' + headers.join(','), ...rows.map((r: string[]) => r.join(','))].join('\n');
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = filename;
    a.click();
  };

  const sourceBadge = (s: string) => (
    <span className={`px-1.5 py-0.5 rounded text-[10px] font-medium ${s === 'volcano' ? 'bg-orange-100 text-orange-700' : s === 'local' ? 'bg-green-100 text-green-700' : 'bg-gray-100 text-gray-600'}`}>
      {sourceLabel(s)}
    </span>
  );

  const toggleGroup = (src: string) => {
    const next = new Set(collapsedGroups);
    if (next.has(src)) next.delete(src); else next.add(src);
    setCollapsedGroups(next);
  };

  const totalPages = data ? Math.ceil(data.total / 50) : 0;

  // 模型账单：按 source 分组
  const groupedItems = (data?.items || []).reduce((acc: Map<string, any[]>, item: any) => {
    const src = item.source || 'unknown';
    if (!acc.has(src)) acc.set(src, []);
    acc.get(src)!.push(item);
    return acc;
  }, new Map<string, any[]>());

  return (
    <div>
      <div className="flex items-center justify-between mb-4">
        <h1 className="text-2xl font-bold">账单核对</h1>
      </div>

      {/* 搜索 / 筛选栏 */}
      <div className="flex items-center gap-3 mb-3 flex-wrap">
        <span className="text-xs text-gray-500">时间：</span>
        <input type="date" value={startDate} onChange={e => setStartDate(e.target.value)}
          className="px-2 py-1.5 text-sm border rounded-lg bg-white dark:bg-gray-800" />
        <span className="text-gray-400">—</span>
        <input type="date" value={endDate} onChange={e => setEndDate(e.target.value)}
          className="px-2 py-1.5 text-sm border rounded-lg bg-white dark:bg-gray-800" />

        <span className="text-gray-300 mx-1">|</span>

        <div className="relative">
          <Search size={14} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-gray-400" />
          <input
            type="text" value={searchInput} onChange={e => setSearchInput(e.target.value)}
            placeholder="搜索用户/模型..."
            className="pl-8 pr-8 py-1.5 text-sm border rounded-lg bg-white dark:bg-gray-800 w-44"
          />
          {searchInput && (
            <button onClick={() => { setSearchInput(''); setSearch(''); }} className="absolute right-2 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-600">
              <X size={14} />
            </button>
          )}
        </div>

        <select value={source} onChange={e => setSource(e.target.value)}
          className="px-2 py-1.5 text-sm border rounded-lg bg-white dark:bg-gray-800">
          <option value="">全部来源</option>
          <option value="volcano">火山引擎</option>
          <option value="local">自部署</option>
        </select>

        <button
          onClick={() => exportCSV(`${tab === 'models' ? '模型账单' : '用户账单'}_${startDate}_${endDate}.csv`)}
          className="flex items-center gap-1.5 text-sm bg-blue-600 text-white px-3 py-1.5 rounded-lg hover:bg-blue-700 ml-auto">
          <Download size={14} /> 按条件导出
        </button>
      </div>

      {/* Tab */}
      <div className="flex gap-0 mb-4 border-b border-gray-200 dark:border-gray-700">
        <button onClick={() => setTab('models')}
          className={`px-6 py-2.5 text-sm font-medium border-b-2 transition-colors -mb-px ${tab === 'models' ? 'border-blue-600 text-blue-600' : 'border-transparent text-gray-500'}`}>
          模型账单
        </button>
        <button onClick={() => setTab('users')}
          className={`px-6 py-2.5 text-sm font-medium border-b-2 transition-colors -mb-px ${tab === 'users' ? 'border-blue-600 text-blue-600' : 'border-transparent text-gray-500'}`}>
          用户账单
        </button>
      </div>

      {/* ========== 模型账单：按 source 分组 ========== */}
      {tab === 'models' && (
        <>
          {/* 分组汇总卡片 */}
          {data?.groups && data.groups.length > 0 && (
            <div className={`grid gap-4 mb-4 ${data.groups.length <= 2 ? 'grid-cols-3' : `grid-cols-${Math.min(data.groups.length + 1, 5)}`}`}>
              {data.groups.map((g: any) => {
                const c = sourceColor(g.source);
                return (
                <div key={g.source} className="bg-white dark:bg-gray-800 rounded-xl border-l-4 p-4 shadow-sm" style={{ borderLeftColor: sourceColor(g.source).border.replace('border-l-', '') }}>
                  <div className={`text-xs mb-1 ${c.text}`}>{sourceLabel(g.source)}</div>
                  <div className={`text-lg font-bold ${c.text}`}>{fmt(g.cost)}</div>
                  <div className="text-xs text-gray-400">调用 {g.calls} 次</div>
                </div>
              )})}
              <div className="bg-white dark:bg-gray-800 rounded-xl border p-4">
                <div className="text-xs text-gray-500 mb-1">总计</div>
                <div className="text-lg font-bold text-blue-600">{fmt(data.totalCost)}</div>
                <div className="text-xs text-gray-400">共 {data.totalCalls} 次</div>
              </div>
            </div>
          )}

          {/* 按 source 分组的明细 */}
          {loading ? (
            <div className="text-center py-12 text-gray-500">加载中...</div>
          ) : (
            [...groupedItems.entries()].map(([src, items]) => {
              const groupInfo = data?.groups?.find((g: any) => g.source === src);
              const collapsed = collapsedGroups.has(src);
              return (
                <div key={src} className="mb-6">
                  {/* 分组标题 */}
                  <div
                    className="flex items-center gap-3 px-4 py-3 mb-2 rounded-xl bg-white dark:bg-gray-800 border cursor-pointer hover:border-gray-300"
                    onClick={() => toggleGroup(src)}
                  >
                    <span className="flex-1 font-medium text-sm">
                      {sourceLabel(src)}
                      <span className="ml-2 text-gray-500 font-normal">
                        ({items.length} 条 / 消耗 {fmt(groupInfo?.cost || 0)})
                      </span>
                    </span>
                    {collapsed ? <ChevronUp size={16} className="text-gray-400" /> : <ChevronDown size={16} className="text-gray-400" />}
                  </div>

                  {!collapsed && (
                    <div className="bg-white dark:bg-gray-800 rounded-xl border overflow-hidden">
                      <div className="overflow-x-auto">
                        <table className="w-full text-sm">
                          <thead>
                            <tr className="border-b bg-gray-50 dark:bg-gray-800/50">
                              <th className="text-left px-4 py-3">ID</th>
                              <th className="text-left px-4 py-3">用户</th>
                              <th className="text-left px-4 py-3">模型</th>
                              <th className="text-right px-4 py-3">Tokens</th>
                              <th className="text-right px-4 py-3">耗时</th>
                              <th className="text-right px-4 py-3">消耗</th>
                              <th className="text-left px-4 py-3">调用时间</th>
                            </tr>
                          </thead>
                          <tbody>
                            {items.map((r: any) => (
                              <tr key={r.id} className="border-b border-gray-100 dark:border-gray-700/50 hover:bg-gray-50 dark:hover:bg-gray-800/50">
                                <td className="px-4 py-3 text-gray-400 text-xs">{r.id}</td>
                                <td className="px-4 py-3">{r.user}</td>
                                <td className="px-4 py-3 font-mono text-xs">{r.model}</td>
                                <td className="px-4 py-3 text-right text-xs text-gray-500">{r.tokensInput}→{r.tokensOutput}</td>
                                <td className="px-4 py-3 text-right text-xs text-gray-500">{r.durationMs ? `${r.durationMs}ms` : '—'}</td>
                                <td className="px-4 py-3 text-right font-medium">{fmt(r.cost)}</td>
                                <td className="px-4 py-3 text-xs text-gray-500">{new Date(r.createdAt).toLocaleString('zh-CN')}</td>
                              </tr>
                            ))}
                            {items.length === 0 && (
                              <tr><td colSpan={7} className="text-center py-8 text-gray-500">暂无数据</td></tr>
                            )}
                          </tbody>
                        </table>
                      </div>
                    </div>
                  )}
                </div>
              );
            })
          )}
        </>
      )}

      {/* ========== 用户账单：平铺明细 ========== */}
      {tab === 'users' && (
        <>
          {/* 汇总卡片 */}
          {data?.summary && (
            <div className="grid grid-cols-4 gap-4 mb-4">
              <div className="bg-white dark:bg-gray-800 rounded-xl border p-4">
                <div className="text-xs text-gray-500 mb-1">火山消耗</div>
                <div className="text-lg font-bold text-orange-600">{fmt(data.summary.volcanoCost)}</div>
                <div className="text-xs text-gray-400">调用 {data.summary.volcanoCalls} 次</div>
              </div>
              <div className="bg-white dark:bg-gray-800 rounded-xl border p-4">
                <div className="text-xs text-gray-500 mb-1">自部署消耗</div>
                <div className="text-lg font-bold text-green-600">{fmt(data.summary.localCost)}</div>
                <div className="text-xs text-gray-400">调用 {data.summary.localCalls} 次</div>
              </div>
              <div className="bg-white dark:bg-gray-800 rounded-xl border p-4">
                <div className="text-xs text-gray-500 mb-1">总计消耗</div>
                <div className="text-lg font-bold text-blue-600">{fmt(data.summary.volcanoCost + data.summary.localCost)}</div>
                <div className="text-xs text-gray-400">共 {data.summary.volcanoCalls + data.summary.localCalls} 次</div>
              </div>
              <div className="bg-white dark:bg-gray-800 rounded-xl border p-4 flex items-center justify-center">
                <div className="text-center">
                  <div className="text-xs text-gray-500 mb-1">筛选条件</div>
                  <div className="text-sm text-gray-600">
                    {source ? (source === 'volcano' ? '火山引擎' : '自部署') : '全部'} · {search || '无搜索'}
                  </div>
                </div>
              </div>
            </div>
          )}

          {/* 用户账单明细表 */}
          <div className="bg-white dark:bg-gray-800 rounded-xl border overflow-hidden">
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b bg-gray-50 dark:bg-gray-800/50">
                    <th className="text-left px-4 py-3">ID</th>
                    <th className="text-left px-4 py-3">用户</th>
                    <th className="text-left px-4 py-3">模型</th>
                    <th className="text-left px-4 py-3">来源</th>
                    <th className="text-right px-4 py-3">Tokens</th>
                    <th className="text-right px-4 py-3">耗时</th>
                    <th className="text-right px-4 py-3">消耗</th>
                    <th className="text-left px-4 py-3">调用时间</th>
                  </tr>
                </thead>
                <tbody>
                  {loading ? (
                    <tr><td colSpan={8} className="text-center py-12 text-gray-500">加载中...</td></tr>
                  ) : data?.items?.length ? (
                    data.items.map((r: any) => (
                      <tr key={r.id} className="border-b border-gray-100 dark:border-gray-700/50 hover:bg-gray-50 dark:hover:bg-gray-800/50">
                        <td className="px-4 py-3 text-gray-400 text-xs">{r.id}</td>
                        <td className="px-4 py-3">{r.user}</td>
                        <td className="px-4 py-3 font-mono text-xs">{r.model}</td>
                        <td className="px-4 py-3">{sourceBadge(r.source)}</td>
                        <td className="px-4 py-3 text-right text-xs text-gray-500">{r.tokensInput}→{r.tokensOutput}</td>
                        <td className="px-4 py-3 text-right text-xs text-gray-500">{r.durationMs ? `${r.durationMs}ms` : '—'}</td>
                        <td className="px-4 py-3 text-right font-medium">{fmt(r.cost)}</td>
                        <td className="px-4 py-3 text-xs text-gray-500">{new Date(r.createdAt).toLocaleString('zh-CN')}</td>
                      </tr>
                    ))
                  ) : (
                    <tr><td colSpan={8} className="text-center py-12 text-gray-500">暂无数据</td></tr>
                  )}
                </tbody>
              </table>
            </div>
          </div>
        </>
      )}

      {/* 分页 */}
      {totalPages > 1 && (
        <div className="flex items-center justify-between mt-4 text-sm text-gray-500">
          <span>共 {data?.total || 0} 条，第 {page}/{totalPages} 页</span>
          <div className="flex gap-2">
            <button onClick={() => setPage(p => Math.max(1, p - 1))} disabled={page <= 1}
              className="px-3 py-1 border rounded disabled:opacity-30">上一页</button>
            <button onClick={() => setPage(p => p + 1)} disabled={page >= totalPages}
              className="px-3 py-1 border rounded disabled:opacity-30">下一页</button>
          </div>
        </div>
      )}
    </div>
  );
}
