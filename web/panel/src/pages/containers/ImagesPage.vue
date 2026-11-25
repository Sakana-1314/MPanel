<script setup lang="ts">
import { computed, ref } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { useQuery } from '@tanstack/vue-query';
import {
  NAlert,
  NButton,
  NCard,
  NCheckbox,
  NEmpty,
  NIcon,
  NInput,
  NModal,
  NSelect,
  NTable,
  NTooltip,
  useDialog,
  NTag,
} from 'naive-ui';
import {
  CloudDownloadOutline,
  RefreshOutline,
  TrashOutline,
} from '@vicons/ionicons5';
import type { ImageSummary } from '@/api/types';
import { useMachineApi } from '@/lib/api';
import { machineKey } from '@/lib/query-keys';
import { useAction } from '@/composables/use-action';
import { formatBytes, formatDate } from '@/lib/format';
import PageHeader from '@/components/common/PageHeader.vue';
import ErrorState from '@/components/common/ErrorState.vue';

const route = useRoute();
const router = useRouter();
const dialog = useDialog();
const machineId = String(route.params.machineId ?? '');
const api = useMachineApi(machineId);

const search = ref('');
const filter = ref('all');
const pullOpen = ref(false);
const pullReference = ref('');
const pruneDanglingOnly = ref(true);

const imagesQuery = useQuery({
  queryKey: computed(() => machineKey(machineId, 'images', 'list', { all: true, limit: 200 })),
  queryFn: () => api.value.images.list({ all: true, limit: 200 }),
  retry: 1,
});

const images = computed(() => imagesQuery.data.value?.items ?? []);
const available = computed(() => imagesQuery.data.value?.available !== false);

const filtered = computed(() => {
  const needle = search.value.trim().toLowerCase();
  return images.value.filter((image) => {
    if (filter.value === 'dangling' && !image.dangling) return false;
    if (filter.value === 'tagged' && image.dangling) return false;
    if (needle.length === 0) return true;
    return (
      image.repoTags.some((tag) => tag.toLowerCase().includes(needle)) ||
      image.repoDigests.some((digest) => digest.toLowerCase().includes(needle)) ||
      image.id.toLowerCase().includes(needle)
    );
  });
});

const totalSize = computed(() => images.value.reduce((sum, image) => sum + image.sizeBytes, 0));

const pullAction = useAction((reference: string) => api.value.images.pull(reference), {
  success: (result) => `已拉取 ${result.image.repoTags[0] ?? result.image.id.slice(0, 12)}`,
  successDescription: '镜像已就绪，可用于容器或 Compose。',
  invalidate: [machineKey(machineId, 'images')],
});

async function pull(): Promise<void> {
  const reference = pullReference.value.trim();
  if (reference.length === 0) return;
  const result = await pullAction.run(reference);
  if (result !== undefined) {
    pullOpen.value = false;
    pullReference.value = '';
  }
}

const removeAction = useAction((image: ImageSummary) => api.value.images.remove(image.id, true), {
  success: () => '镜像已删除',
  invalidate: [machineKey(machineId, 'images')],
});

function confirmRemove(image: ImageSummary): void {
  dialog.warning({
    title: '删除镜像',
    content: `确定删除 ${image.repoTags[0] ?? image.id.slice(0, 12)}？正在使用该镜像的容器可能导致删除失败。`,
    positiveText: '删除',
    negativeText: '取消',
    onPositiveClick: () => {
      void removeAction.run(image);
    },
  });
}

const pruneAction = useAction(() => api.value.images.prune({ danglingOnly: pruneDanglingOnly.value }), {
  success: (result) => `清理完成：删除 ${result.deleted} 个镜像，回收 ${formatBytes(result.reclaimedBytes)}`,
  invalidate: [machineKey(machineId, 'images')],
});

function confirmPrune(): void {
  dialog.warning({
    title: '清理镜像',
    content: pruneDanglingOnly.value ? '将删除所有悬空（dangling）镜像。' : '将删除所有未被容器使用的镜像。',
    positiveText: '清理',
    negativeText: '取消',
    onPositiveClick: () => {
      void pruneAction.run();
    },
  });
}
</script>

<template>
  <div class="page">
    <PageHeader title="镜像" subtitle="Docker 镜像拉取、删除与清理。请求经 core 代理到当前标签绑定的机器。">
      <template #actions>
        <n-button size="small" secondary :loading="imagesQuery.isFetching.value" @click="imagesQuery.refetch()">
          <template #icon><n-icon :component="RefreshOutline" /></template>
          刷新
        </n-button>
        <n-button size="small" secondary @click="confirmPrune">清理</n-button>
        <n-button size="small" type="primary" @click="pullOpen = true">
          <template #icon><n-icon :component="CloudDownloadOutline" /></template>
          拉取镜像
        </n-button>
        <n-button size="small" quaternary @click="router.push(`/m/${machineId}/containers`)">容器</n-button>
        <n-button size="small" quaternary @click="router.push(`/m/${machineId}/stacks`)">Compose 栈</n-button>
      </template>
    </PageHeader>

    <n-alert v-if="!available" type="warning" :bordered="true" title="Docker 不可用">
      {{ imagesQuery.data.value?.reason ?? 'agent 返回 available=false。' }}
    </n-alert>

    <error-state v-if="imagesQuery.isError.value" :error="imagesQuery.error.value" @retry="imagesQuery.refetch()" />

    <n-card size="small">
      <div class="toolbar">
        <n-input v-model:value="search" placeholder="搜索 tag / digest / id…" clearable style="max-width: 300px" />
        <n-select
          v-model:value="filter"
          style="width: 150px"
          :options="[
            { label: '全部镜像', value: 'all' },
            { label: '有标签', value: 'tagged' },
            { label: '悬空镜像', value: 'dangling' },
          ]"
        />
        <div class="spacer" />
        <span class="small muted">共 {{ images.length }} 个 · {{ formatBytes(totalSize) }}</span>
      </div>
    </n-card>

    <n-empty v-if="images.length === 0 && !imagesQuery.isLoading.value" description="没有镜像">
      <template #extra>
        <n-button type="primary" @click="pullOpen = true">拉取第一个镜像</n-button>
      </template>
    </n-empty>

    <n-card v-else size="small" :content-style="{ padding: '0' }">
      <n-table :single-line="false" size="small">
        <thead>
          <tr>
            <th style="min-width: 220px">Tag</th>
            <th style="min-width: 160px">镜像 ID</th>
            <th style="width: 100px">大小</th>
            <th style="width: 150px">创建时间</th>
            <th style="width: 80px">类型</th>
            <th style="width: 70px">操作</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="image in filtered" :key="image.id">
            <td>
              <div class="cell">
                <span class="mono small truncate" style="max-width: 300px">{{ image.repoTags.join(', ') || '<none>' }}</span>
                <span v-if="image.repoDigests.length > 0" class="mono tiny muted truncate" style="max-width: 300px">
                  {{ image.repoDigests[0] }}
                </span>
              </div>
            </td>
            <td><span class="mono tiny muted">{{ image.id.replace('sha256:', '').slice(0, 16) }}</span></td>
            <td class="small">{{ formatBytes(image.sizeBytes) }}</td>
            <td><span class="small muted">{{ formatDate(image.createdAt) }}</span></td>
            <td>
              <n-tag size="tiny" round :bordered="false" :type="image.dangling ? 'warning' : 'default'">
                {{ image.dangling ? '悬空' : '有标签' }}
              </n-tag>
            </td>
            <td>
              <n-tooltip>
                <template #trigger>
                  <n-button size="tiny" quaternary type="error" @click="confirmRemove(image)">
                    <template #icon><n-icon :component="TrashOutline" /></template>
                  </n-button>
                </template>
                删除镜像
              </n-tooltip>
            </td>
          </tr>
        </tbody>
      </n-table>
      <div v-if="filtered.length === 0" class="empty-row small muted">没有匹配的镜像。</div>
    </n-card>

    <n-modal v-model:show="pullOpen" preset="card" title="拉取镜像" style="width: 560px; max-width: calc(100vw - 24px)">
      <div class="pull-form">
        <n-input v-model:value="pullReference" placeholder="例如 nginx:latest / ghcr.io/owner/app:v1" @keydown.enter="pull" />
        <p class="tiny muted">拉取可能需要几分钟；请求超时单独放宽到 620 秒。</p>
      </div>
      <template #footer>
        <div class="toolbar" style="justify-content: flex-end">
          <n-button quaternary @click="pullOpen = false">取消</n-button>
          <n-button type="primary" :loading="pullAction.pending.value" :disabled="pullReference.trim().length === 0" @click="pull">拉取</n-button>
        </div>
      </template>
    </n-modal>
  </div>
</template>

<style scoped>
.cell {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
}
.empty-row {
  padding: 18px;
  text-align: center;
}
.pull-form {
  display: flex;
  flex-direction: column;
  gap: 8px;
}
</style>
