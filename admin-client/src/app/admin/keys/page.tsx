'use client';

import { useEffect, useState } from 'react';
import { adminApi as api } from '@/lib/api';
import { ToggleLeft, ToggleRight, Trash2, Eye, Copy, Check, X, Loader2, Layers, Filter, Key as KeyIcon, Boxes } from 'lucide-react';

interface BatchToast { type: 'success' | 'error'; msg: string }

export default function AdminKeysPage() {
  const [keys, setKeys] = useState<any[]>([]);
  const [page, setPage] = useState(1);
  const [total, setTotal] = useState(0);
  const [allocating, setAllocating] = useState<{id: number; amount: string} | null>(null);
  const [viewKey, setViewKey] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  // 多选
  const [selectedKeys, setSelectedKeys] = useState<Set<number>>(new Set());

  // 模型配置弹窗（单个 Key）
  const [modelConfig, setModelConfig] = useState<any>(null);
  // 批量弹窗：A=按Key批量设模型（选多个key→设同一组模型）；B=按模型批量授权（选模型→勾选key）
  const [batch, setBatch] = useState<{ mode: 'A' | 'B'; all: any[]; allKeys: any[]; selected: Set<number>; target: number | null; loading: boolean; saving: boolean; toast?: BatchToast } | null>(null);
  // 批量配额弹窗
  const [quotaBatch, setQuotaBatch] = useState<{ saving: boolean; amount: string; toast?: BatchToast } | null>(null);

  const load = () => {
    api.get(`/api/v1/admin/keys?page=${page}`).then(res => {
      if (res.success) { setKeys((res.data as any).items || (res.data as any)); setTotal((res.data as any).total || 0); }
    });
  };
  useEffect(() => { load(); }, [page]);
  useEffect(() => { setSelectedKeys(new Set()); }, [page]);

  // toast 自动消失
  useEffect(() => { if (!modelConfig?.toast) return; const t = setTimeout(() => setModelConfig((p:any)=>(p?{...p,toast:undefined}:p)), 2500); return () => clearTimeout(t); }, [modelConfig?.toast]);
  useEffect(() => { if (!batch?.toast) return; const t = setTimeout(() => setBatch((p:any)=>(p?{...p,toast:undefined}:p)), 2500); return () => clearTimeout(t); }, [batch?.toast]);
  useEffect(() => { if (!quotaBatch?.toast) return; const t = setTimeout(() => setQuotaBatch((p:any)=>(p?{...p,toast:undefined}:p)), 2500); return () => clearTimeout(t); }, [quotaBatch?.toast]);

  // ---- 多选 ----
  const toggleKey = (id: number) => setSelectedKeys(p => { const n = new Set(p); n.has(id)?n.delete(id):n.add(id); return n; });
  const toggleAll = () => setSelectedKeys(keys.length===selectedKeys.size ? new Set() : new Set(keys.map(k=>k.id)));
  const clearSelection = () => setSelectedKeys(new Set());

  // ---- 单个 Key 配置模型（原功能）----
  const handleOpenModelConfig = async (k: any) => {
    setModelConfig({ keyId: k.id, keyName: k.keyName, all: [], selected: new Set(), loading: true, saving: false });
    try {
      const [modelRes, keyModelsRes] = await Promise.all([
        api.get('/api/v1/admin/models/status'),
        api.get(`/api/v1/admin/keys/${k.id}/models`),
      ]);
      const all = (modelRes.data as any[]) || [];
      const selectedArr = (keyModelsRes.data as any[]) || [];
      setModelConfig({ keyId: k.id, keyName: k.keyName, all, selected: new Set(selectedArr.map((m:any)=>m.id)), loading: false, saving: false });
    } catch { setModelConfig(null); alert('加载模型列表失败'); }
  };
  const toggleModel = (id: number) => setModelConfig((p:any)=>{ if(!p)return p; const n=new Set(p.selected); n.has(id)?n.delete(id):n.add(id); return {...p,selected:n}; });
  const handleSaveModels = async () => {
    if (!modelConfig?.keyId) return;
    setModelConfig({...modelConfig, saving:true, toast:undefined});
    const res = await api.put(`/api/v1/admin/keys/${modelConfig.keyId}/models`, { modelIds: Array.from(modelConfig.selected) });
    setModelConfig({...modelConfig, saving:false, toast: res.success ? {type:'success',msg:res.message||'已保存'} : {type:'error',msg:res.error?.message||'保存失败'}});
  };

  // ---- 批量 A：给多个选中 Key 设同一组模型 ----
  const openBatchA = async () => {
    if (selectedKeys.size === 0) { alert('请先勾选要批量配置的 Key'); return; }
    setBatch({ mode:'A', all:[], allKeys:[], selected:new Set(), target:null, loading:true, saving:false });
    const modelRes = await api.get('/api/v1/admin/models/status');
    setBatch({ mode:'A', all:(modelRes.data as any[])||[], allKeys:[], selected:new Set(), target:null, loading:false, saving:false });
  };

  // ---- 批量 B：按模型批量授权给多个 Key ----
  const openBatchB = async () => {
    setBatch({ mode:'B', all:[], allKeys:[], selected:new Set(), target:null, loading:true, saving:false });
    const [modelRes, keysRes] = await Promise.all([api.get('/api/v1/admin/models/status'), api.get('/api/v1/admin/keys?limit=1000')]);
    const allKeys = (keysRes.data as any)?.items || (keysRes.data as any) || [];
    setBatch({ mode:'B', all:(modelRes.data as any[])||[], allKeys, selected:new Set(), target:null, loading:false, saving:false });
  };

  const batchToggle = (id: number) => setBatch((p:any)=>{ if(!p)return p; const n=new Set(p.selected); n.has(id)?n.delete(id):n.add(id); return {...p,selected:n}; });
  const setBatchTarget = (id: number | null) => setBatch((p:any)=>(p?{...p,target:id,selected:new Set()}:p));

  // 批量保存
  const handleBatchSave = async () => {
    if (!batch) return;
    setBatch({...batch, saving:true, toast:undefined});
    let res: any;
    if (batch.mode === 'A') {
      // 给选中 Key 设模型（覆盖）
      res = await api.post('/api/v1/admin/keys/batch/models', { keyIds: Array.from(selectedKeys), modelIds: Array.from(batch.selected) });
    } else {
      // 给选中 Key 授权某个模型（覆盖该模型在这些key上的状态；这里用单模型→keyIds，覆盖为仅此模型）
      const keyIds = Array.from(batch.selected);
      if (keyIds.length === 0 || batch.target == null) { setBatch({...batch, saving:false, toast:{type:'error',msg:'请选择模型和 Key'}}); return; }
      res = await api.post('/api/v1/admin/keys/batch/models', { keyIds, modelIds: [batch.target] });
      setSelectedKeys(new Set());
    }
    setBatch({...batch, saving:false, toast: res.success ? {type:'success',msg:res.message||'批量设置成功'} : {type:'error',msg:res.error?.message||'批量设置失败'}});
    if (res.success) { if (batch.mode!=='A') setBatch(null); load(); }
  };

  // 批量配额
  const openQuotaBatch = () => {
    if (selectedKeys.size === 0) { alert('请先勾选要设置配额的 Key'); return; }
    setQuotaBatch({ saving:false, amount:'' });
  };
  const handleQuotaBatchSave = async () => {
    if (!quotaBatch || quotaBatch.amount === '') { setQuotaBatch(p=>(p?{...p,toast:{type:'error' as const,msg:'请输入额度'}}:p)); return; }
    setQuotaBatch({...quotaBatch, saving:true, toast:undefined});
    const res = await api.post('/api/v1/admin/keys/batch/quota', {
      keyIds: Array.from(selectedKeys), amount: parseFloat(quotaBatch.amount),
    });
    setQuotaBatch({...quotaBatch, saving:false, toast: res.success ? {type:'success' as const,msg:res.message||'批量配额成功'} : {type:'error' as const,msg:res.error?.message||'批量配额失败'}});
    if (res.success) { setSelectedKeys(new Set()); load(); }
  };

  const handleAllocate = async () => { if (!allocating?.amount) return; const res = await api.put(`/api/v1/admin/keys/${allocating.id}/quota`, { amount: parseFloat(allocating.amount) }); if (res.success) { setAllocating(null); load(); } else alert(res.error?.message||'分配失败'); };
  const handleToggle = async (k:any) => { const res = await api.put(`/api/v1/admin/keys/${k.id}/toggle`); if (res.success) load(); else alert(res.error?.message||'操作失败'); };
  const handleDelete = async (k:any) => { if(!confirm(`确定删除 Key "${k.keyName}"？此操作不可撤销。`))return; const res = await api.delete(`/api/v1/admin/keys/${k.id}`); if(res.success)load(); };
  const handleViewKey = async (k:any) => { const res = await api.get(`/api/v1/admin/keys/${k.id}/value`); if(res.success) setViewKey((res.data as any).keyValue); };
  const copyKey = () => { if(viewKey){ navigator.clipboard.writeText(viewKey); setCopied(true); setTimeout(()=>setCopied(false),2000);} };

  const statusBadge = (s:string) => {
    const map:Record<string,string> = { active:'bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400', pending_quota:'bg-yellow-100 text-yellow-700 dark:bg-yellow-900/30 dark:text-yellow-400', revoked:'bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400' };
    const label:Record<string,string> = { active:'正常', pending_quota:'等待配额', revoked:'已禁用' };
    return <span className={`px-2 py-0.5 rounded-full text-xs ${map[s]||''}`}>{label[s]||s}</span>;
  };

  // 批量弹窗内的模型/Key 勾选列表（复用）
  const renderCheckList = (items:any[], selected:Set<number>, type:'model'|'key', onToggle:(id:number)=>void) => (
    <div className="flex-1 overflow-y-auto border rounded-lg p-3">
      {items.length===0 ? <div className="text-center py-8 text-gray-400">暂无{type==='model'?'模型':'Key'}</div> : (
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-1.5">
          {items.map((m:any)=>{
            const checked = selected.has(m.id);
            return (
              <label key={m.id} className={`flex items-center gap-2 px-3 py-2 rounded-lg border cursor-pointer transition ${checked?'border-purple-400 bg-purple-50 dark:bg-purple-900/20':'border-gray-200 dark:border-gray-700 hover:bg-gray-50 dark:hover:bg-gray-800'}`}>
                <input type="checkbox" checked={checked} onChange={()=>onToggle(m.id)} className="accent-purple-600" />
                <div className="flex-1 min-w-0">
                  <div className="text-sm font-medium truncate">{type==='model' ? (m.displayName||m.name) : m.keyName}</div>
                  <div className="text-xs text-gray-500">{type==='model' ? `${m.name} · ${m.modelType}` : (m.user?.username||'—')}</div>
                </div>
              </label>
            );
          })}
        </div>
      )}
    </div>
  );

  return (
    <div>
      <h1 className="text-2xl font-bold mb-6">Key 管理</h1>

      {/* 批量工具条 */}
      <div className="bg-white dark:bg-gray-800 rounded-xl shadow-sm border border-gray-200 dark:border-gray-700 p-3 mb-4 flex items-center gap-3 flex-wrap">
        <span className="text-sm text-gray-500 flex items-center gap-1"><Layers size={15} /> 批量操作</span>
        <button onClick={openBatchA} className="px-3 py-1.5 bg-purple-600 hover:bg-purple-700 text-white text-sm rounded-lg transition-colors flex items-center gap-1 disabled:opacity-50" disabled={selectedKeys.size===0}>
          <Boxes size={14} /> 给选中 Key 配置模型 ({selectedKeys.size})
        </button>
        <button onClick={openQuotaBatch} className="px-3 py-1.5 bg-green-600 hover:bg-green-700 text-white text-sm rounded-lg transition-colors flex items-center gap-1 disabled:opacity-50" disabled={selectedKeys.size===0}>
          <Layers size={14} /> 给选中 Key 批量配额 ({selectedKeys.size})
        </button>
        <button onClick={openBatchB} className="px-3 py-1.5 bg-indigo-600 hover:bg-indigo-700 text-white text-sm rounded-lg transition-colors flex items-center gap-1">
          <KeyIcon size={14} /> 按模型批量授权
        </button>
        {selectedKeys.size > 0 && (
          <button onClick={clearSelection} className="text-xs text-gray-500 hover:text-gray-700">清空选择({selectedKeys.size})</button>
        )}
        <span className="text-xs text-gray-400 ml-auto">勾选多个 Key 后可批量配置模型</span>
      </div>

      <div className="bg-white dark:bg-gray-800 rounded-xl shadow-sm border border-gray-200 dark:border-gray-700 overflow-hidden">
        <table className="w-full">
          <thead>
            <tr className="border-b border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-800/50">
              <th className="px-4 py-3 w-10">
                <input type="checkbox" checked={keys.length>0 && selectedKeys.size===keys.length} onChange={toggleAll} className="accent-purple-600" />
              </th>
              <th className="text-left px-4 py-3 text-sm">名称</th>
              <th className="text-left px-4 py-3 text-sm">用户</th>
              <th className="text-left px-4 py-3 text-sm">状态</th>
              <th className="text-left px-4 py-3 text-sm">配额</th>
              <th className="text-left px-4 py-3 text-sm">最近使用</th>
              <th className="text-left px-4 py-3 text-sm w-48">操作</th>
            </tr>
          </thead>
          <tbody>
            {keys.map(k => (
              <tr key={k.id} className={`border-b border-gray-100 dark:border-gray-700/50 ${selectedKeys.has(k.id)?'bg-purple-50/50 dark:bg-purple-900/10':''}`}>
                <td className="px-4 py-3">
                  <input type="checkbox" checked={selectedKeys.has(k.id)} onChange={()=>toggleKey(k.id)} className="accent-purple-600" />
                </td>
                <td className="px-4 py-3 text-sm font-medium">{k.keyName}</td>
                <td className="px-4 py-3 text-sm">{k.user?.username || '—'}</td>
                <td className="px-4 py-3">{statusBadge(k.status)}</td>
                <td className="px-4 py-3 text-sm">{k.quotaUsed}/{k.quotaTotal}</td>
                <td className="px-4 py-3 text-sm text-gray-500">{k.lastUsed ? new Date(k.lastUsed).toLocaleDateString('zh-CN') : '—'}</td>
                <td className="px-4 py-3">
                  {allocating?.id === k.id ? (
                    <div className="flex gap-1">
                      <input value={allocating!.amount} onChange={e=>setAllocating({id:k.id,amount:e.target.value})} type="number" className="w-20 px-2 py-0.5 border rounded text-xs" placeholder={String(k.quotaTotal)} />
                      <button onClick={handleAllocate} className="text-xs bg-blue-600 text-white px-2 py-0.5 rounded">修改</button>
                      <button onClick={()=>setAllocating(null)} className="text-xs text-gray-500 px-1">取消</button>
                    </div>
                  ) : (
                    <div className="flex gap-1 flex-wrap">
                      <button onClick={()=>handleOpenModelConfig(k)} className="text-xs text-purple-600 hover:underline px-1">模型</button>
                      <button onClick={()=>setAllocating({id:k.id,amount:String(k.quotaTotal)})} className="text-xs text-blue-600 hover:underline">额度</button>
                      <button onClick={()=>handleToggle(k)} title={k.status==='revoked'?'启用':'禁用'} className={`text-xs px-1 rounded ${k.status==='revoked'?'text-green-600 hover:bg-green-50':'text-orange-600 hover:bg-orange-50'}`}>{k.status==='revoked'?<ToggleRight size={16}/>:<ToggleLeft size={16}/>}</button>
                      <button onClick={()=>handleViewKey(k)} className="text-xs text-gray-500 hover:text-gray-700 px-0.5"><Eye size={14}/></button>
                      <button onClick={()=>handleDelete(k)} className="text-xs text-red-500 hover:text-red-700 px-0.5"><Trash2 size={14}/></button>
                    </div>
                  )}
                </td>
              </tr>
            ))}
            {keys.length===0 && <tr><td colSpan={7} className="text-center py-12 text-gray-500">暂无 Key</td></tr>}
          </tbody>
        </table>
      </div>

      {/* 翻页 */}
      <div className="flex justify-between mt-4">
        <span className="text-sm text-gray-500">共 {total} 条</span>
        <div className="flex gap-2">
          <button onClick={()=>setPage(p=>Math.max(1,p-1))} disabled={page<=1} className="px-3 py-1 border rounded text-sm disabled:opacity-30">上一页</button>
          <button onClick={()=>setPage(p=>p+1)} disabled={page*20>=total} className="px-3 py-1 border rounded text-sm disabled:opacity-30">下一页</button>
        </div>
      </div>

      {/* 单 Key 模型配置弹窗 */}
      {modelConfig && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50" onClick={()=>!modelConfig.saving&&setModelConfig(null)}>
          <div className="bg-white dark:bg-gray-800 rounded-xl p-6 max-w-2xl w-full mx-4 shadow-2xl max-h-[80vh] flex flex-col" onClick={e=>e.stopPropagation()}>
            <div className="flex justify-between items-center mb-4">
              <h3 className="font-semibold text-lg">配置「{modelConfig.keyName}」可用模型</h3>
              <button onClick={()=>setModelConfig(null)} className="text-gray-400 hover:text-gray-600"><X size={20}/></button>
            </div>
            {modelConfig.toast && <div className={`mb-3 px-3 py-2 rounded-lg text-sm flex items-center gap-2 ${modelConfig.toast.type==='success'?'bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400':'bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400'}`}>{modelConfig.toast.type==='success'?<Check size={16}/>:<X size={16}/>}<span>{modelConfig.toast.msg}</span></div>}
            <p className="text-xs text-gray-500 mb-3">勾选该 Key 允许使用的模型（可多选）。<span className="text-red-500">未配置的 Key 将无法调用任何模型。</span></p>
            {renderCheckList(modelConfig.all, modelConfig.selected, 'model', toggleModel)}
            <div className="flex justify-between items-center mt-4">
              <span className="text-sm text-gray-500">已选 {modelConfig.selected.size} 个模型</span>
              <div className="flex gap-2">
                <button onClick={()=>setModelConfig(null)} className="px-4 py-2 border rounded-lg text-sm">取消</button>
                <button onClick={handleSaveModels} disabled={modelConfig.saving||modelConfig.loading} className="px-4 py-2 bg-purple-600 text-white rounded-lg text-sm disabled:opacity-50 flex items-center gap-1">{modelConfig.saving&&<Loader2 size={14} className="animate-spin"/>}保存</button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* 批量弹窗 */}
      {batch && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50" onClick={()=>!batch.saving&&setBatch(null)}>
          <div className="bg-white dark:bg-gray-800 rounded-xl p-6 max-w-2xl w-full mx-4 shadow-2xl max-h-[85vh] flex flex-col" onClick={e=>e.stopPropagation()}>
            <div className="flex justify-between items-center mb-4">
              <h3 className="font-semibold text-lg">{batch.mode==='A' ? '批量配置模型' : '按模型批量授权'}</h3>
              <button onClick={()=>setBatch(null)} className="text-gray-400 hover:text-gray-600"><X size={20}/></button>
            </div>
            {batch.toast && <div className={`mb-3 px-3 py-2 rounded-lg text-sm flex items-center gap-2 ${batch.toast.type==='success'?'bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400':'bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400'}`}>{batch.toast.type==='success'?<Check size={16}/>:<X size={16}/>}<span>{batch.toast.msg}</span></div>}

            {batch.mode==='A' ? (
              <>
                <p className="text-xs text-gray-500 mb-3">已选中 <span className="text-purple-600 font-medium">{selectedKeys.size}</span> 个 Key，勾选要授予它们的模型（<span className="text-red-500">覆盖式：这些 Key 的模型授权将被替换为下方勾选结果</span>）</p>
                {renderCheckList(batch.all, batch.selected, 'model', batchToggle)}
              </>
            ) : (
              <>
                <p className="text-xs text-gray-500 mb-3">先选一个模型，再勾选要授权的 Key（覆盖式）</p>
                <div className="mb-3">
                  <select value={batch.target ?? ''} onChange={e=>setBatchTarget(e.target.value?Number(e.target.value):null)} className="w-full px-3 py-2 border rounded-lg text-sm bg-white dark:bg-gray-800">
                    <option value="">—— 选择要授权的模型 ——</option>
                    {(batch.all||[]).map((m:any)=>(<option key={m.id} value={m.id}>{m.displayName||m.name} ({m.name})</option>))}
                  </select>
                </div>
                <p className="text-xs text-gray-500 mb-3">勾选要授权的 Key（<span className="text-red-500">覆盖式：这些 Key 的模型授权将被替换为仅该模型</span>）</p>
                {renderCheckList(batch.allKeys, batch.selected, 'key', batchToggle)}
              </>
            )}

            <div className="flex justify-between items-center mt-4">
              <span className="text-sm text-gray-500">{batch.mode==='A' ? `已选 ${batch.selected.size} 个模型` : `已选 ${batch.selected.size} 个 Key`}</span>
              <div className="flex gap-2">
                <button onClick={()=>setBatch(null)} className="px-4 py-2 border rounded-lg text-sm">取消</button>
                <button onClick={handleBatchSave} disabled={batch.saving||batch.loading||(batch.mode==='B'&&(batch.target==null||batch.selected.size===0))} className="px-4 py-2 bg-purple-600 text-white rounded-lg text-sm disabled:opacity-50 flex items-center gap-1">{batch.saving&&<Loader2 size={14} className="animate-spin"/>}批量保存</button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* 批量配额弹窗 */}
      {quotaBatch && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50" onClick={()=>!quotaBatch.saving&&setQuotaBatch(null)}>
          <div className="bg-white dark:bg-gray-800 rounded-xl p-6 max-w-md w-full mx-4 shadow-2xl" onClick={e=>e.stopPropagation()}>
            <div className="flex justify-between items-center mb-4">
              <h3 className="font-semibold text-lg">批量设置配额</h3>
              <button onClick={()=>setQuotaBatch(null)} className="text-gray-400 hover:text-gray-600"><X size={20}/></button>
            </div>
            {quotaBatch.toast && <div className={`mb-3 px-3 py-2 rounded-lg text-sm flex items-center gap-2 ${quotaBatch.toast.type==='success'?'bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400':'bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400'}`}>{quotaBatch.toast.type==='success'?<Check size={16}/>:<X size={16}/>}<span>{quotaBatch.toast.msg}</span></div>}
            <p className="text-sm text-gray-500 mb-3">为已选中的 <span className="text-green-600 font-medium">{selectedKeys.size}</span> 个 Key 统一设置算力额度（覆盖式）</p>
            {quotaBatch.toast?.type==='success' && (
              <p className="text-xs text-gray-400 mb-3">已设置完成，如需继续可为其他 Key 设置，或关闭窗口。</p>
            )}
            <div className="mb-4">
              <label className="text-xs text-gray-500 mb-1 block">额度金额（元）</label>
              <input
                type="number" step="0.01" min="0"
                value={quotaBatch.amount}
                onChange={e=>setQuotaBatch({...quotaBatch,amount:e.target.value})}
                disabled={quotaBatch.saving}
                placeholder="例如 100"
                className="w-full px-3 py-2 border rounded-lg text-sm bg-white dark:bg-gray-800 disabled:opacity-50"
              />
            </div>
            <div className="flex justify-end gap-2">
              <button onClick={()=>setQuotaBatch(null)} className="px-4 py-2 border rounded-lg text-sm">取消</button>
              <button onClick={handleQuotaBatchSave} disabled={quotaBatch.saving} className="px-4 py-2 bg-green-600 text-white rounded-lg text-sm disabled:opacity-50 flex items-center gap-1">{quotaBatch.saving&&<Loader2 size={14} className="animate-spin"/>}批量设置</button>
            </div>
          </div>
        </div>
      )}

      {/* Key 值弹窗 */}
      {viewKey && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50" onClick={()=>{setViewKey(null);setCopied(false);}}>
          <div className="bg-white dark:bg-gray-800 rounded-xl p-6 max-w-lg w-full mx-4 shadow-2xl" onClick={e=>e.stopPropagation()}>
            <div className="flex justify-between items-center mb-4">
              <h3 className="font-semibold text-lg">Key 明文</h3>
              <button onClick={()=>{setViewKey(null);setCopied(false);}} className="text-gray-400 hover:text-gray-600"><X size={20}/></button>
            </div>
            <div className="flex gap-2">
              <input value={viewKey} readOnly className="flex-1 px-3 py-2 border rounded bg-gray-50 dark:bg-gray-700 text-sm font-mono select-all" />
              <button onClick={copyKey} className="px-3 py-2 bg-blue-600 text-white rounded text-sm flex items-center gap-1">{copied?<Check size={14}/>:<Copy size={14}/>}{copied?'已复制':'复制'}</button>
            </div>
            <p className="text-xs text-gray-500 mt-3">⚠️ 请妥善保管，Key 值只显示这一次。</p>
          </div>
        </div>
      )}
    </div>
  );
}
