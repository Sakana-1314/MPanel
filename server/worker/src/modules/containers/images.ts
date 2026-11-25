import {
  isPanelError,
  type ImageSummary,
  type ListResult,
  type PageQuery,
} from '@mpanel/shared';
import { listResult, parsePage, unavailableList } from '../../util.js';
import {
  assertImageReference,
  decodeCursor,
  paginateDescending,
  type DockerClient,
} from './docker.js';

export interface ImageService {
  list(
    q: PageQuery & { all?: boolean; dangling?: boolean; q?: string },
  ): Promise<ListResult<ImageSummary>>;
  pull(reference: string): Promise<{ image: ImageSummary }>;
  remove(id: string, force?: boolean): Promise<{ deleted: true; id: string }>;
  prune(opts: { danglingOnly?: boolean }): Promise<{ deleted: number; reclaimedBytes: number }>;
}

export function createImageService(docker: DockerClient): ImageService {
  return {
    async list(q) {
      let images: ImageSummary[];
      try {
        images = await docker.listImages({
          all: q.all,
          dangling: q.dangling,
          ...(q.q !== undefined && q.q.trim() !== '' ? { q: q.q } : {}),
        });
      } catch (error) {
        if (isPanelError(error) && error.code === 'UNAVAILABLE') {
          return unavailableList(error.message);
        }
        throw error;
      }
      const sorted = [...images].sort(compareCreatedDesc);
      const page = parsePage(q);
      const cursor = decodeCursor(page.cursor);
      const result = paginateDescending(
        sorted,
        cursor,
        (item) => item.createdAt,
        (item) => item.id,
        page.limit,
      );
      return listResult(result.items, {
        nextCursor: result.nextCursor,
        total: sorted.length,
      });
    },

    async pull(reference) {
      assertImageReference(reference);
      const image = await docker.pull(reference);
      return { image };
    },

    async remove(id, force) {
      assertImageReference(id);
      await docker.removeImage(id, force);
      return { deleted: true, id };
    },

    async prune(opts) {
      return docker.pruneImages({ danglingOnly: opts.danglingOnly });
    },
  };
}

function compareCreatedDesc(left: ImageSummary, right: ImageSummary): number {
  if (left.createdAt === right.createdAt) return left.id.localeCompare(right.id);
  return left.createdAt < right.createdAt ? 1 : -1;
}
