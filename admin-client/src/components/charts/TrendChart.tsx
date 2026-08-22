'use client';

import ReactECharts from 'echarts-for-react';
import { useMemo } from 'react';

interface TrendData { date: string; calls: number; cost: number }

/** 调用/费用趋势图（柱状+折线） */
export default function TrendChart({ data, days }: { data: TrendData[]; days: number }) {
  const option = useMemo(() => ({
    tooltip: {
      trigger: 'axis',
      backgroundColor: 'rgba(15,23,42,0.9)', borderWidth: 0, textStyle: { color: '#fff' },
    },
    legend: { data: ['调用量', '费用(元)'], top: 4, textStyle: { color: '#94a3b8' } },
    grid: { left: 10, right: 10, top: 40, bottom: 0, containLabel: true },
    xAxis: {
      type: 'category', data: data.map(d => d.date.slice(5)),
      axisLine: { lineStyle: { color: '#334155' } }, axisLabel: { color: '#94a3b8' },
    },
    yAxis: [
      { type: 'value', name: '调用', nameTextStyle: { color: '#94a3b8' }, axisLabel: { color: '#94a3b8' }, splitLine: { lineStyle: { color: '#1e293b' } } },
      { type: 'value', name: '费用', nameTextStyle: { color: '#94a3b8' }, axisLabel: { color: '#94a3b8' }, splitLine: { show: false } },
    ],
    series: [
      {
        name: '调用量', type: 'bar', data: data.map(d => d.calls), barWidth: '40%',
        itemStyle: { borderRadius: [6, 6, 0, 0], color: { type: 'linear', x: 0, y: 0, x2: 0, y2: 1, colorStops: [{ offset: 0, color: '#6366f1' }, { offset: 1, color: '#38bdf8' }] } },
      },
      {
        name: '费用(元)', type: 'line', yAxisIndex: 1, data: data.map(d => d.cost), smooth: true,
        itemStyle: { color: '#f59e0b' }, lineStyle: { color: '#f59e0b', width: 3 }, areaStyle: { opacity: 0.1, color: '#f59e0b' },
      },
    ],
  }), [data]);

  if (!data?.length) return <div className="flex items-center justify-center h-64 text-gray-400 text-sm">暂无趋势数据</div>;
  return <ReactECharts option={option} style={{ height: 300 }} notMerge={true} />;
}
