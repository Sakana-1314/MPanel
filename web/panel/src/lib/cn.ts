import clsx, { type ClassValue } from 'clsx';

/** 组合 class 名；保留 false/null/undefined 过滤语义。 */
export function cn(...values: ClassValue[]): string {
  return clsx(values);
}
