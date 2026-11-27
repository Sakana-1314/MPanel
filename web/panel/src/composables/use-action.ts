import { ref, shallowRef } from 'vue';
import { useMessage } from 'naive-ui';
import { useQueryClient } from '@tanstack/vue-query';
import { AppError, describeError } from '../api/errors';

export interface ActionOptions<TArgs extends unknown[], TResult> {
  success?: string | ((result: TResult, ...args: TArgs) => string);
  successDescription?: string | ((result: TResult, ...args: TArgs) => string | undefined);
  errorTitle?: string;
  /** 失败时使用的固定提示；用于不向普通用户暴露底层错误详情的操作。 */
  errorMessage?: string;
  /** 成功后要失效的查询 key（数组的数组）。 */
  invalidate?: readonly (readonly unknown[])[];
}

/**
 * 统一动作包装：pending 状态、成功 toast、失败 toast（含 UNAVAILABLE hint）、缓存失效。
 * 失败时返回 undefined，调用方无需重复 try/catch。
 */
export function useAction<TArgs extends unknown[], TResult>(
  fn: (...args: TArgs) => Promise<TResult>,
  options: ActionOptions<TArgs, TResult> = {},
) {
  const message = useMessage();
  const queryClient = useQueryClient();
  const pending = ref(false);
  const error = shallowRef<AppError | null>(null);

  async function run(...args: TArgs): Promise<TResult | undefined> {
    if (pending.value) return undefined;
    pending.value = true;
    error.value = null;
    try {
      const result = await fn(...args);
      if (options.success !== undefined) {
        const title =
          typeof options.success === 'function'
            ? options.success(result, ...args)
            : options.success;
        const description =
          typeof options.successDescription === 'function'
            ? options.successDescription(result, ...args)
            : options.successDescription;
        message.success(
          description === undefined || description.length === 0 ? title : `${title} · ${description}`,
          { duration: 4000 },
        );
      }
      for (const key of options.invalidate ?? []) {
        void queryClient.invalidateQueries({ queryKey: key });
      }
      return result;
    } catch (raw) {
      const appError =
        raw instanceof AppError
          ? raw
          : new AppError('INTERNAL', raw instanceof Error ? raw.message : String(raw));
      error.value = appError;
      const described = describeError(appError, options.errorTitle ?? '操作失败');
      message.error(options.errorMessage ?? `${described.title}：${described.description}`, {
        duration: 6000,
        closable: true,
      });
      return undefined;
    } finally {
      pending.value = false;
    }
  }

  return { run, pending, error };
}
