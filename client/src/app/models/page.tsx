'use client';

import { useEffect, useState } from 'react';
import api from '@/lib/api';

interface Model {
  id: number;
  name: string;
  displayName: string;
  description: string;
  usageHint: string;
  source: string;
  modelType: string;
  status: string;
}

export default function ModelsPage() {
  const [models, setModels] = useState<Model[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    api.getModels().then((res) => {
      if (res.success) setModels((res.data as Model[]) || []);
      setLoading(false);
    });
  }, []);

  if (loading) {
    return <div className="flex justify-center items-center h-64"><div className="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-600" /></div>;
  }

  return (
    <div>
      <h1 className="text-2xl font-bold mb-6">模型中心</h1>
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
        {models.map((model) => (
          <div key={model.id} className="bg-white dark:bg-gray-800 rounded-xl p-5 shadow-sm border border-gray-200 dark:border-gray-700 hover:shadow-md transition-shadow">
            <div className="flex items-start justify-between mb-3">
              <div>
                <h3 className="font-semibold text-lg">{model.displayName}</h3>
                <p className="text-xs text-gray-500 font-mono mt-0.5">{model.id}</p>
              </div>
              <span className={`px-2 py-0.5 rounded-full text-xs font-medium ${
                model.status === 'online' ? 'bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400' :
                'bg-gray-100 text-gray-500 dark:bg-gray-700 dark:text-gray-400'
              }`}>
                {model.status === 'online' ? '在线' : '离线'}
              </span>
            </div>
            <p className="text-sm text-gray-600 dark:text-gray-400 mb-2">{model.description}</p>
            {model.usageHint && (
              <p className="text-xs text-gray-500 dark:text-gray-500 mb-3">💡 {model.usageHint}</p>
            )}
            <div className="flex items-center gap-2">
              <span className={`px-2 py-0.5 rounded text-xs ${
                model.source === 'volcano' && model.modelType === 'video' ? 'bg-purple-100 text-purple-700 dark:bg-purple-900/30 dark:text-purple-400' :
                model.source === 'volcano' && model.modelType === 'image' ? 'bg-pink-100 text-pink-700 dark:bg-pink-900/30 dark:text-pink-400' :
                model.source === 'volcano' && (model.modelType === 'chat' || model.modelType === 'audio') ? 'bg-cyan-100 text-cyan-700 dark:bg-cyan-900/30 dark:text-cyan-400' :
                'bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-400'
              }`}>
                {model.source === 'volcano' && model.modelType === 'video' ? '🎬 视频生成' :
                 model.source === 'volcano' && model.modelType === 'image' ? '🖼️ 图片生成' :
                 model.source === 'volcano' && (model.modelType === 'chat' || model.modelType === 'audio') ? '🧠 理解' :
                 '🖥️ 自部署'}
              </span>
            </div>
          </div>
        ))}
        {models.length === 0 && (
          <div className="col-span-full text-center py-12 text-gray-500">暂无可用模型</div>
        )}
      </div>
    </div>
  );
}