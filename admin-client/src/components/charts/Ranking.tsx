'use client';

/** TOP 排行列表（用户TOP / 模型TOP 通用） */
export interface RankItem { name: string; value: number; sub?: string; unit?: string }

export default function Ranking({ title, items, color = '#6366f1' }: { title: string; items: RankItem[]; color?: string }) {
  return (
    <div className="bg-white dark:bg-gray-800 rounded-2xl shadow-sm border border-gray-200 dark:border-gray-700 p-4">
      <h3 className="text-sm font-semibold text-gray-700 dark:text-gray-200 mb-3">{title}</h3>
      {items.length === 0 ? (
        <div className="text-center py-10 text-gray-400 text-sm">暂无数据</div>
      ) : (
        <div className="space-y-2">
          {items.map((it, i) => {
            const max = items[0]?.value || 1;
            return (
              <div key={i} className="flex items-center gap-3">
                <span className={`w-6 h-6 rounded-lg flex items-center justify-center text-xs font-bold ${i < 3 ? 'text-white' : 'text-gray-500 bg-gray-100 dark:bg-gray-700'}`}
                  style={i < 3 ? { background: [color, '#38bdf8', '#f59e0b'][i] } : undefined}>
                  {i + 1}
                </span>
                <div className="flex-1 min-w-0">
                  <div className="flex justify-between items-center text-sm">
                    <span className="truncate">{it.name}</span>
                    <span className="text-gray-500 text-xs">{it.value}{it.unit || ''}</span>
                  </div>
                  <div className="w-full h-1.5 bg-gray-100 dark:bg-gray-700 rounded-full mt-1 overflow-hidden">
                    <div className="h-full rounded-full" style={{ width: `${(it.value / max) * 100}%`, background: color }} />
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
