'use client';

import ReactECharts from 'echarts-for-react';
import { useMemo } from 'react';
import { LucideIcon } from 'lucide-react';

interface GaugeStatProps {
  label: string;
  value: number;
  suffix?: string;
  percent?: number;     // 0-100，用于环进度
  icon: LucideIcon;
  color: string;        // 主色 hex
  bg: string;           // 浅背景
  href?: string;
  sub?: string;         // 副标题（如 "已配XX"）
}

/** 大屏顶部数据卡片（数字 + 可选进度环） */
export default function GaugeStat({ label, value, suffix, percent, icon: Icon, color, bg, href, sub }: GaugeStatProps) {
  const gaugeOpt = useMemo(() => ({   // 仅当 percent 存在时显示迷你环
    series: [{
      type: 'gauge', startAngle: 220, endAngle: -40, radius: '95%', center: ['50%', '55%'],
      min: 0, max: 100, pointer: { show: false },
      progress: { show: true, width: 8, itemStyle: { color } },
      axisLine: { lineStyle: { width: 8, color: [[1, 'rgba(148,163,184,0.2)']] } },
      axisTick: { show: false }, splitLine: { show: false }, axisLabel: { show: false },
      detail: { show: false },
      data: [{ value: percent || 0 }],
    }],
  }), [percent, color]);

  return (
    <a href={href} className={`block bg-white dark:bg-gray-800 rounded-2xl p-4 shadow-sm border border-gray-200 dark:border-gray-700 hover:shadow-md transition-shadow ${href ? 'cursor-pointer' : ''}`}>
      <div className={`${bg} w-10 h-10 rounded-xl flex items-center justify-center mb-3`} style={color?{color}:undefined}>
        <Icon size={20} />
      </div>
      <p className="text-xs text-gray-500">{label}</p>
      <div className="flex items-end gap-2 mt-1">
        <p className="text-2xl font-bold" style={{ color }}>{value}{suffix}</p>
        {typeof percent === 'number' && (
          <div className="w-14 h-14 ml-auto -mt-2">
            <ReactECharts option={gaugeOpt} style={{ width: 56, height: 56 }} />
          </div>
        )}
      </div>
      {sub && <p className="text-[11px] text-gray-400 mt-1">{sub}</p>}
    </a>
  );
}
