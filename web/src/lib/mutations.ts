import { useCallback } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { UseMutationResult } from '@tanstack/react-query';
import { describeError } from '../api/errors';
import { useToast } from '../components/ui/Toast';
import type { ToastApi } from '../components/ui/Toast';

/** 目标 queryKey（必须是 api/*.ts 里 keys 工厂产出的带连接作用域的 key）。 */
export type InvalidateTarget = readonly unknown[];

export interface AppMutationOptions<TData, TVariables> {
  mutationFn: (variables: TVariables) => Promise<TData>;
  successMessage?: string | ((data: TData, variables: TVariables) => string | undefined);
  successDescription?: string | ((data: TData, variables: TVariables) => string | undefined);
  errorMessage?: string;
  /** 成功后统一 invalidate 的 queryKey 列表。 */
  invalidate?: readonly InvalidateTarget[];
  onSuccess?: (data: TData, variables: TVariables) => void | Promise<void>;
  onError?: (error: unknown, variables: TVariables) => void;
  /** 某些内联操作不需要成功 toast。 */
  silentSuccess?: boolean;
  silentError?: boolean;
}

/**
 * 统一 mutation 行为：成功 toast + invalidate；失败 toast（含 UNAVAILABLE hint）。
 * 页面只需关心表单/本地状态。
 */
export function useAppMutation<TData, TVariables = void>(
  options: AppMutationOptions<TData, TVariables>,
): UseMutationResult<TData, Error, TVariables> {
  const toast = useToast();
  const queryClient = useQueryClient();

  return useMutation<TData, Error, TVariables>({
    mutationFn: options.mutationFn,
    onSuccess: async (data, variables) => {
      const message = resolve(options.successMessage, data, variables);
      if (options.silentSuccess !== true && message !== undefined) {
        toast.push({
          title: message,
          description: resolve(options.successDescription, data, variables),
          tone: 'success',
        });
      }
      if (options.invalidate !== undefined) {
        await Promise.all(
          options.invalidate.map((queryKey) => queryClient.invalidateQueries({ queryKey })),
        );
      }
      await options.onSuccess?.(data, variables);
    },
    onError: (error, variables) => {
      if (options.silentError !== true) {
        toastError(toast, error, options.errorMessage);
      }
      options.onError?.(error, variables);
    },
  });
}

export function toastError(toast: ToastApi, error: unknown, title?: string): void {
  const description = describeError(error);
  toast.push({
    title: title ?? description.title,
    description: `${description.description} ${description.hint}`.trim(),
    tone: 'error',
  });
}

export function useInvalidate(): (targets: readonly InvalidateTarget[]) => Promise<void> {
  const queryClient = useQueryClient();
  return useCallback(
    async (targets: readonly InvalidateTarget[]) => {
      await Promise.all(
        targets.map((queryKey) => queryClient.invalidateQueries({ queryKey })),
      );
    },
    [queryClient],
  );
}

function resolve<TData, TVariables>(
  source: string | ((data: TData, variables: TVariables) => string | undefined) | undefined,
  data: TData,
  variables: TVariables,
): string | undefined {
  if (source === undefined) return undefined;
  return typeof source === 'function' ? source(data, variables) : source;
}
