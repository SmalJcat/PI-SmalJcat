import { useEffect, useState } from 'react';
import { displayCost, emptyResponseSpeed, responseSpeed } from './composer-metrics.mjs';
import type { Wire } from './types';

export function usePiResponseSpeed(generation: number | undefined, sessionId: string | undefined, modelKey: string, ready: boolean) {
  const [speed, setSpeed] = useState<number | null>(null);
  useEffect(() => {
    setSpeed(null);
    if (!ready) return;
    let measurement = emptyResponseSpeed();
    return window.pi.onEvent(({ generation: incoming, event }) => {
      if (incoming !== generation) return;
      const next = responseSpeed(measurement, event, performance.now());
      if (next !== measurement) { measurement = next; setSpeed(next.tokensPerSecond); }
    });
  }, [generation, sessionId, modelKey, ready]);
  return speed;
}

export function ComposerMetrics({ scope, speed, cost, stale = false }: { scope: string; speed?: number | null; cost?: Wire; stale?: boolean }) {
  const known = typeof speed === 'number' && Number.isFinite(speed) && speed > 0;
  return <span className="composer-metrics" aria-label={`${scope} 模型统计`}>
    <span title={known ? '最近一次回复的平均输出速度，含等待与传输耗时' : '暂无完整回复的速度统计'}>速度 <span data-testid="model-speed">{known ? `${speed.toFixed(1)} tok/s` : '—'}</span></span>
    <span aria-hidden="true">·</span>
    <span title={`${scope === 'Pi' ? 'Pi 会话累计费用（USD）' : 'CLI 上报费用'}${stale ? ' · 上次统计' : ''}`}>{stale ? '上次花费' : '花费'} <span data-testid="model-cost">{displayCost(cost)}</span></span>
  </span>;
}
