import { useEffect, useMemo, useRef, useState } from 'react';
import { useQueries } from '@tanstack/react-query';
import { containersKeys, getContainerStats } from '../../api/containers';
import type { ContainerStats } from '../../api/types';

/** 行内迷你趋势保留的采样点数。 */
export const STATS_HISTORY_LIMIT = 30;

export interface StatsPoint {
  at: number;
  cpuPercent: number;
  memoryPercent: number;
  memoryUsageBytes: number;
  memoryLimitBytes: number;
}

export interface ContainerStatsSnapshot {
  statsById: ReadonlyMap<string, ContainerStats>;
  /** 内存中维护的最近 STATS_HISTORY_LIMIT 个采样点。 */
  historyById: ReadonlyMap<string, readonly StatsPoint[]>;
  errorById: ReadonlyMap<string, unknown>;
  loading: boolean;
}

export interface UseContainerStatsOptions {
  enabled?: boolean;
  /** 轮询间隔，默认 5 秒。 */
  intervalMs?: number;
}

/**
 * 按机器（当前连接/机器作用域）轮询多个容器的 stats。
 * 历史只保存在内存中，最多 30 个采样点，连接切换或页面卸载即丢弃。
 */
export function useContainerStats(
  ids: readonly string[],
  options: UseContainerStatsOptions = {},
): ContainerStatsSnapshot {
  const uniqueIds = useMemo(() => Array.from(new Set(ids.filter((id) => id.length > 0))), [ids]);
  const enabled = options.enabled !== false && uniqueIds.length > 0;

  const queries = useQueries({
    queries: uniqueIds.map((id) => ({
      queryKey: containersKeys.stats(id),
      queryFn: async (): Promise<ContainerStats> => {
        const result = await getContainerStats(id);
        return result.stats;
      },
      enabled,
      refetchInterval: enabled ? (options.intervalMs ?? 5000) : false,
      staleTime: 3000,
      retry: 0,
      refetchOnWindowFocus: false,
    })),
  });

  const [history, setHistory] = useState<Record<string, StatsPoint[]>>({});
  const seenStamps = useRef<Record<string, number>>({});
  const queriesRef = useRef(queries);
  queriesRef.current = queries;

  // dataUpdatedAt 变化说明拿到了新样本；只在此时追加，避免重复采样。
  const stamps = queries.map((query) => query.dataUpdatedAt).join('|');

  useEffect(() => {
    const current = queriesRef.current;
    setHistory((previous) => {
      let next: Record<string, StatsPoint[]> | null = null;
      uniqueIds.forEach((id, index) => {
        const query = current[index];
        const data = query?.data;
        if (data === undefined) return;
        const stamp = query?.dataUpdatedAt ?? 0;
        if (seenStamps.current[id] === stamp) return;
        seenStamps.current[id] = stamp;
        const point: StatsPoint = {
          at: stamp,
          cpuPercent: data.cpuPercent,
          memoryPercent: data.memoryPercent,
          memoryUsageBytes: data.memoryUsageBytes,
          memoryLimitBytes: data.memoryLimitBytes,
        };
        const source = next ?? previous;
        const series = [...(source[id] ?? []), point].slice(-STATS_HISTORY_LIMIT);
        next = { ...source, [id]: series };
      });
      return next ?? previous;
    });
  }, [stamps, uniqueIds]);

  const statsById = useMemo(() => {
    const map = new Map<string, ContainerStats>();
    uniqueIds.forEach((id, index) => {
      const data = queries[index]?.data;
      if (data !== undefined) map.set(id, data);
    });
    return map;
  }, [queries, uniqueIds]);

  const errorById = useMemo(() => {
    const map = new Map<string, unknown>();
    uniqueIds.forEach((id, index) => {
      const error = queries[index]?.error;
      if (error !== null && error !== undefined) map.set(id, error);
    });
    return map;
  }, [queries, uniqueIds]);

  const historyById = useMemo(() => {
    const map = new Map<string, readonly StatsPoint[]>();
    for (const id of uniqueIds) {
      const series = history[id];
      if (series !== undefined && series.length > 0) map.set(id, series);
    }
    return map;
  }, [history, uniqueIds]);

  return {
    statsById,
    historyById,
    errorById,
    loading: queries.some((query) => query.isLoading),
  };
}

/** 把最近 N 个采样点的值抽出来给 Sparkline 使用。 */
export function seriesValues(
  series: readonly StatsPoint[] | undefined,
  pick: (point: StatsPoint) => number,
): number[] {
  if (series === undefined) return [];
  return series.map(pick);
}
