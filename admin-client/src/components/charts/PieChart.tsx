'use client';

import ReactECharts from 'echarts-for-react';
import { useMemo } from 'react';

interface PieItem { name: string; value: number }

const COLORS = ['#6366f1', '#38bdf8', '#f59e0b', '#10b981', '#ef4444', '#a855f7', '#ec4899', '#14b8a6'];

/** 环形饼图（占比分布） */
export default function PieChart({ title, data }: { title: string; data: PieItem[] }) {
  const option = useMemo(() => ({
    title: { text: title, left: 'center', top: 0, textStyle: { color: '#e2e8f0', fontSize: 14 } },
    tooltip: { trigger: 'item', formatter: '{b}: {c} ({d}%)', backgroundColor: 'rgba(15,23,42,0.9)', borderWidth: 0, textStyle: { color: '#fff' } },
    legend: { bottom: 0, textStyle: { color: '#94a3b8' }, type: 'scroll' },
    series: [{
      type: 'pie', radius: ['45%', '70%'], center: ['50%', '48%'],
      avoidLabelOverlap: true, itemStyle: { borderRadius: 6, borderColor: '#0f172a', borderWidth: 2 },
      label: { show: false }, emphasis: { label: { show: true, fontSize: 16, fontWeight: 'bold', color: '#e2e8f0' } },
      data: data.map((d, i) => ({ ...d, itemStyle: { color: COLORS[i % COLORS.length] } })),
    }],
  }), [title, data]);

  if (!data?.length) return <div className="flex items-center justify-center h-56 text-gray-400 text-sm">暂无数据</div>;
  return <ReactECharts option={option} style={{ height: 280 }} notMerge={true} />;
}
