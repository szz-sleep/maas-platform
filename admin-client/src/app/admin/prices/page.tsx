'use client';

import { useEffect, useState } from 'react';
import { adminApi as api } from '@/lib/api';
import { Plus, Trash2, X, Save, Loader2 } from 'lucide-react';

interface PriceItem {
  id: number;
  modelKey: string;
  displayName: string | null;
  modelType: string;
  source: string;
  priceMode: string;
  inputPrice: number | null;
  outputPrice: number | null;
  cacheHitPrice: number | null;
  resolution: string | null;
  inputNoVideo: number | null;
  inputWithVideo: number | null;
  perSecond: number | null;
  perImage: number | null;
  perImageHigh: number | null;
  refModel: string | null;
  remark: string | null;
}

const TYPE_LABEL: Record<string, string> = { chat: '对话', video: '视频', image: '图片', '3d': '3D' };
const MODE_LABEL: Record<string, string> = { token: '按Token', per_second: '按秒', per_image: '按张' };

export default function AdminPricesPage() {
  const [list, setList] = useState<PriceItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState<number | null>(null);
  const [editing, setEditing] = useState<PriceItem | null>(null); // 新增弹窗
  const [toast, setToast] = useState<string | null>(null);

  const load = () => {
    setLoading(true);
    api.get('/api/v1/admin/prices').then(res => {
      if (res.success) setList((res.data as any[]) || []);
      setLoading(false);
    });
  };
  useEffect(load, []);
  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 2500);
    return () => clearTimeout(t);
  }, [toast]);

  const save = async (item: PriceItem) => {
    setSaving(item.id);
    const res = await api.put(`/api/v1/admin/prices/${item.id}`, {
      displayName: item.displayName, inputPrice: item.inputPrice, outputPrice: item.outputPrice,
      cacheHitPrice: item.cacheHitPrice, inputNoVideo: item.inputNoVideo, inputWithVideo: item.inputWithVideo,
      perSecond: item.perSecond, perImage: item.perImage, perImageHigh: item.perImageHigh, refModel: item.refModel, remark: item.remark,
    });
    setSaving(null);
    setToast(res.success ? '已保存' : (res.error?.message || '保存失败'));
    if (res.success) load();
  };

  const setField = (id: number, field: keyof PriceItem, val: any) => {
    setList(ls => ls.map(x => x.id === id ? { ...x, [field]: val } : x));
  };

  const addNew = async () => {
    if (!editing?.modelKey) { setToast('请输入 modelKey'); return; }
    const res = await api.post('/api/v1/admin/prices', editing);
    setEditing(null);
    setToast(res.success ? '已添加' : (res.error?.message || '添加失败'));
    if (res.success) load();
  };

  const remove = async (item: PriceItem) => {
    if (!confirm(`确定删除价格项 "${item.modelKey}"？`)) return;
    const res = await api.delete(`/api/v1/admin/prices/${item.id}`);
    setToast(res.success ? '已删除' : (res.error?.message || '删除失败'));
    if (res.success) load();
  };

  const fmt = (v: number | null) => (v === null || v === undefined ? '—' : Number(v).toFixed(3));

  const numInput = (item: PriceItem, field: any) => (
    <input
      type="number" step="0.001" value={(item as any)[field] ?? ''}
      onChange={e => setField(item.id, field, e.target.value === '' ? null : parseFloat(e.target.value))}
      className="w-20 px-1.5 py-0.5 border rounded text-xs bg-white dark:bg-gray-800 text-right"
    />
  );

  const grouped = ['chat', 'video', 'image', '3d'].map(t => ({ type: t, items: list.filter(l => l.modelType === t) }));

  return (
    <div>
      <div className="flex items-center justify-between mb-6">
        <h1 className="text-2xl font-bold">价格管理</h1>
        <div className="flex items-center gap-3">
          {toast && <span className="text-sm text-green-600 dark:text-green-400">{toast}</span>}
          <button onClick={() => setEditing({ id: 0, modelKey: '', displayName: '', modelType: 'chat', source: 'volcano', priceMode: 'token', inputPrice: null, outputPrice: null, cacheHitPrice: null, resolution: null, inputNoVideo: null, inputWithVideo: null, perSecond: null, perImage: null, perImageHigh: null, refModel: null, remark: null })} className="px-3 py-2 bg-blue-600 text-white rounded-lg text-sm flex items-center gap-1"><Plus size={15} />新增</button>
        </div>
      </div>

      {loading ? (
        <div className="flex items-center justify-center py-16 text-gray-400"><Loader2 className="animate-spin mr-2" />加载中...</div>
      ) : (
        grouped.map(g => (
          <div key={g.type} className="mb-8">
            <h2 className="text-lg font-semibold mb-3 flex items-center gap-2">
              {TYPE_LABEL[g.type] || g.type}
              <span className="text-xs text-gray-500 font-normal">({g.items.length})</span>
            </h2>
            <div className="bg-white dark:bg-gray-800 rounded-xl shadow-sm border border-gray-200 dark:border-gray-700 overflow-x-auto">
              <table className="w-full min-w-[900px]">
                <thead>
                  <tr className="border-b border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-800/50 text-xs">
                    <th className="text-left px-3 py-2">模型标识</th>
                    <th className="text-left px-3 py-2">名称</th>
                    <th className="text-left px-3 py-2">来源</th>
                    <th className="text-left px-3 py-2">计费</th>
                    {g.type === 'chat' && <><th className="text-left px-3 py-2">输入(元/百万)</th><th className="text-left px-3 py-2">输出(元/百万)</th></>}
                    {g.type === 'video' && <><th className="text-left px-3 py-2">分辨率</th><th className="text-left px-3 py-2">不含视频(元/百万)</th><th className="text-left px-3 py-2">含视频(元/百万)</th></>}
                    {g.type === 'image' && <><th className="text-left px-3 py-2">普通(元/张)</th><th className="text-left px-3 py-2">高像素(元/张)</th></>}
                    <th className="text-left px-3 py-2">参考模型</th>
                    <th className="text-left px-3 py-2 w-24">操作</th>
                  </tr>
                </thead>
                <tbody>
                  {g.items.map(item => (
                    <tr key={item.id} className="border-b border-gray-100 dark:border-gray-700/50 text-sm">
                      <td className="px-3 py-1.5 font-mono text-xs">{item.modelKey}</td>
                      <td className="px-3 py-1.5">
                        <input value={item.displayName || ''} onChange={e => setField(item.id, 'displayName', e.target.value)} className="w-28 px-1.5 py-0.5 border rounded text-xs bg-white dark:bg-gray-800" />
                      </td>
                      <td className="px-3 py-1.5 text-xs">{item.source === 'local' ? '本地' : '火山'}</td>
                      <td className="px-3 py-1.5 text-xs">{MODE_LABEL[item.priceMode] || item.priceMode}</td>
                      {g.type === 'chat' && <>{numInput(item, 'inputPrice') && <td className="px-3 py-1.5">{numInput(item, 'inputPrice')}</td>}<td className="px-3 py-1.5">{numInput(item, 'outputPrice')}</td></>}
                      {g.type === 'video' && <>
                        <td className="px-3 py-1.5 text-xs">{item.resolution || '—'}</td>
                        <td className="px-3 py-1.5">{numInput(item, 'inputNoVideo')}</td>
                        <td className="px-3 py-1.5">{numInput(item, 'inputWithVideo')}</td>
                      </>}
                      {g.type === 'image' && <>
                        <td className="px-3 py-1.5">{numInput(item, 'perImage')}</td>
                        <td className="px-3 py-1.5">{numInput(item, 'perImageHigh')}</td>
                      </>}
                      <td className="px-3 py-1.5 text-xs">{item.refModel || '—'}</td>
                      <td className="px-3 py-1.5">
                        <div className="flex gap-1">
                          <button onClick={() => save(item)} disabled={saving === item.id} className="text-xs text-blue-600 hover:underline disabled:opacity-40"><Save size={14} /></button>
                          <button onClick={() => remove(item)} className="text-xs text-red-500 hover:underline"><Trash2 size={14} /></button>
                        </div>
                      </td>
                    </tr>
                  ))}
                  {g.items.length === 0 && <tr><td colSpan={8} className="px-3 py-4 text-center text-gray-400 text-sm">暂无{g.type}类型价格</td></tr>}
                </tbody>
              </table>
            </div>
          </div>
        ))
      )}

      {/* 新增弹窗 */}
      {editing && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50" onClick={() => setEditing(null)}>
          <div className="bg-white dark:bg-gray-800 rounded-xl p-6 max-w-md w-full mx-4 shadow-2xl" onClick={e => e.stopPropagation()}>
            <div className="flex justify-between items-center mb-4">
              <h3 className="font-semibold text-lg">新增价格项</h3>
              <button onClick={() => setEditing(null)} className="text-gray-400 hover:text-gray-600"><X size={20} /></button>
            </div>
            <div className="space-y-3">
              <div className="flex gap-3">
                <div className="flex-1"><label className="text-xs text-gray-500">modelKey *</label><input value={editing.modelKey} onChange={e => setEditing({...editing, modelKey: e.target.value})} className="w-full px-2 py-1.5 border rounded text-sm" /></div>
                <div className="flex-1"><label className="text-xs text-gray-500">显示名</label><input value={editing.displayName || ''} onChange={e => setEditing({...editing, displayName: e.target.value})} className="w-full px-2 py-1.5 border rounded text-sm" /></div>
              </div>
              <div className="flex gap-3">
                <div className="flex-1"><label className="text-xs text-gray-500">类型</label>
                  <select value={editing.modelType} onChange={e => setEditing({...editing, modelType: e.target.value, priceMode: e.target.value === 'image' ? 'per_image' : e.target.value === 'video' ? 'token' : 'token'})} className="w-full px-2 py-1.5 border rounded text-sm">
                    <option value="chat">对话</option><option value="video">视频</option><option value="image">图片</option><option value="3d">3D</option>
                  </select>
                </div>
                <div className="flex-1"><label className="text-xs text-gray-500">来源</label>
                  <select value={editing.source} onChange={e => setEditing({...editing, source: e.target.value})} className="w-full px-2 py-1.5 border rounded text-sm"><option value="volcano">火山</option><option value="local">本地</option></select>
                </div>
                {editing.modelType === 'video' && <div className="flex-1"><label className="text-xs text-gray-500">分辨率</label>
                  <select value={editing.resolution || '720p'} onChange={e => setEditing({...editing, resolution: e.target.value})} className="w-full px-2 py-1.5 border rounded text-sm"><option value="480p">480p</option><option value="720p">720p</option><option value="1080p">1080p</option><option value="4k">4K</option></select>
                </div>}
              </div>
              <div className="grid grid-cols-3 gap-3">
                {editing.modelType === 'chat' && <>
                  <div><label className="text-xs text-gray-500">输入(元/百万)</label><input type="number" value={editing.inputPrice ?? ''} onChange={e => setEditing({...editing, inputPrice: e.target.value === '' ? null : parseFloat(e.target.value)})} className="w-full px-2 py-1.5 border rounded text-sm" /></div>
                  <div><label className="text-xs text-gray-500">输出(元/百万)</label><input type="number" value={editing.outputPrice ?? ''} onChange={e => setEditing({...editing, outputPrice: e.target.value === '' ? null : parseFloat(e.target.value)})} className="w-full px-2 py-1.5 border rounded text-sm" /></div>
                </>}
                {editing.modelType === 'video' && <>
                  <div><label className="text-xs text-gray-500">不含视频(元/百万)</label><input type="number" value={editing.inputNoVideo ?? ''} onChange={e => setEditing({...editing, inputNoVideo: e.target.value === '' ? null : parseFloat(e.target.value)})} className="w-full px-2 py-1.5 border rounded text-sm" /></div>
                  <div><label className="text-xs text-gray-500">含视频(元/百万)</label><input type="number" value={editing.inputWithVideo ?? ''} onChange={e => setEditing({...editing, inputWithVideo: e.target.value === '' ? null : parseFloat(e.target.value)})} className="w-full px-2 py-1.5 border rounded text-sm" /></div>
                </>}
                {editing.modelType === 'image' && <>
                  <div><label className="text-xs text-gray-500">普通(元/张)</label><input type="number" value={editing.perImage ?? ''} onChange={e => setEditing({...editing, perImage: e.target.value === '' ? null : parseFloat(e.target.value)})} className="w-full px-2 py-1.5 border rounded text-sm" /></div>
                  <div><label className="text-xs text-gray-500">高像素(元/张)</label><input type="number" value={editing.perImageHigh ?? ''} onChange={e => setEditing({...editing, perImageHigh: e.target.value === '' ? null : parseFloat(e.target.value)})} className="w-full px-2 py-1.5 border rounded text-sm" /></div>
                </>}
              </div>
              <div><label className="text-xs text-gray-500">参考模型(本地用)</label><input value={editing.refModel || ''} onChange={e => setEditing({...editing, refModel: e.target.value})} placeholder="如 doubao-seedance-2.0" className="w-full px-2 py-1.5 border rounded text-sm" /></div>
            </div>
            <div className="flex justify-end gap-2 mt-5">
              <button onClick={() => setEditing(null)} className="px-4 py-2 border rounded-lg text-sm">取消</button>
              <button onClick={addNew} className="px-4 py-2 bg-blue-600 text-white rounded-lg text-sm">添加</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
