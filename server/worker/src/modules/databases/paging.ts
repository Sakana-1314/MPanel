import { badRequest } from '@mpanel/shared';
import type { ListResult, PageQuery } from '@mpanel/shared';

export interface PageParams {
  limit: number;
  offset: number;
}

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

/**
 * 游标是不透明字符串，当前实现为排序后数组的偏移量；客户端只回传服务端给的
 * nextCursor，不接受负数或非整数。
 */
export function readPage(q: PageQuery): PageParams {
  const rawLimit = q.limit === undefined ? DEFAULT_LIMIT : q.limit;
  const limit =
    Number.isInteger(rawLimit) && rawLimit >= 1 && rawLimit <= MAX_LIMIT
      ? rawLimit
      : DEFAULT_LIMIT;
  if (q.cursor === undefined || q.cursor.length === 0) return { limit, offset: 0 };
  const offset = Number.parseInt(q.cursor, 10);
  if (!Number.isInteger(offset) || offset < 0 || String(offset) !== q.cursor) {
    throw badRequest('分页游标无效', { cursor: q.cursor });
  }
  return { limit, offset };
}

export function pageSlice<T>(items: T[], q: PageQuery): ListResult<T> {
  const { limit, offset } = readPage(q);
  const slice = items.slice(offset, offset + limit);
  const consumed = offset + slice.length;
  return {
    available: true,
    items: slice,
    nextCursor: consumed < items.length ? String(consumed) : null,
    total: items.length,
  };
}
