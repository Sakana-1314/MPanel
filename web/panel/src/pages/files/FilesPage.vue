<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { useQuery, useQueryClient } from '@tanstack/vue-query';
import {
  NAlert,
  NButton,
  NCard,
  NCheckbox,
  NDrawer,
  NDrawerContent,
  NEmpty,
  NFormItem,
  NIcon,
  NInput,
  NModal,
  NSelect,
  NSwitch,
  NTable,
  NTooltip,
  useDialog,
  useMessage,
  NTag,
} from 'naive-ui';
import {
  ArrowBackOutline,
  ArrowUpOutline,
  CreateOutline,
  DocumentOutline,
  DownloadOutline,
  FolderOpenOutline,
  FolderOutline,
  RefreshOutline,
  SearchOutline,
  TrashOutline,
  CloudUploadOutline,
} from '@vicons/ionicons5';
import type { FileItem, FileReadResult, TrashEntry } from '@/api/types';
import { useMachineApi } from '@/lib/api';
import { machineKey } from '@/lib/query-keys';
import { useAction } from '@/composables/use-action';
import { formatBytes, formatDate } from '@/lib/format';
import { describeError } from '@/api/errors';
import PageHeader from '@/components/common/PageHeader.vue';
import ErrorState from '@/components/common/ErrorState.vue';
import CodeEditor from '@/components/common/CodeEditor.vue';
import CodeBlock from '@/components/common/CodeBlock.vue';
import RelativeTime from '@/components/common/RelativeTime.vue';

const route = useRoute();
const router = useRouter();
const dialog = useDialog();
const message = useMessage();
const queryClient = useQueryClient();
const machineId = String(route.params.machineId ?? '');
const api = useMachineApi(machineId);

const root = ref(typeof route.query.root === 'string' ? route.query.root : '');
const path = ref(typeof route.query.path === 'string' && route.query.path.startsWith('/') ? route.query.path : '/');
const showHidden = ref(false);
const uploadInput = ref<HTMLInputElement | null>(null);

const rootsQuery = useQuery({
  queryKey: computed(() => machineKey(machineId, 'files', 'roots')),
  queryFn: () => api.value.files.roots(),
  retry: 0,
});

const roots = computed(() => rootsQuery.data.value?.items ?? []);
const currentRoot = computed(() => roots.value.find((item) => item.name === root.value));

watch(
  roots,
  (items) => {
    if (items.length === 0) return;
    if (root.value.length === 0 || !items.some((item) => item.name === root.value)) {
      root.value = items.find((item) => item.writable)?.name ?? items[0]!.name;
    }
  },
  { immediate: true },
);

watch([root, path], () => {
  if (root.value.length === 0) return;
  const query = { ...route.query, root: root.value, path: path.value };
  if (route.query.root !== query.root || route.query.path !== query.path) {
    void router.replace({ query });
  }
});

const listQuery = useQuery({
  queryKey: computed(() => machineKey(machineId, 'files', 'list', { root: root.value, path: path.value, showHidden: showHidden.value, limit: 200 })),
  queryFn: () => api.value.files.list({ root: root.value, path: path.value, showHidden: showHidden.value, limit: 200 }),
  enabled: computed(() => root.value.length > 0),
  retry: 0,
});

const items = computed(() => listQuery.data.value?.items ?? []);
const available = computed(() => listQuery.data.value?.available !== false);
const sorted = computed(() =>
  [...items.value].sort((a, b) => {
    if (a.type === 'directory' && b.type !== 'directory') return -1;
    if (a.type !== 'directory' && b.type === 'directory') return 1;
    return a.name.localeCompare(b.name);
  }),
);

const breadcrumbs = computed(() => {
  const parts = path.value.split('/').filter((part) => part.length > 0);
  const crumbs = [{ label: currentRoot.value?.name ?? root.value, path: '/' }];
  let acc = '';
  for (const part of parts) {
    acc += `/${part}`;
    crumbs.push({ label: part, path: acc });
  }
  return crumbs;
});

function joinPath(base: string, name: string): string {
  const prefix = base.endsWith('/') ? base.slice(0, -1) : base;
  return `${prefix}/${name}`;
}

function openDir(item: FileItem): void {
  path.value = item.path;
}

function goUp(): void {
  if (path.value === '/' || path.value.length === 0) return;
  const parent = path.value.split('/').filter(Boolean).slice(0, -1).join('/');
  path.value = parent.length === 0 ? '/' : `/${parent}`;
}

function goPath(next: string): void {
  path.value = next;
}

function invalidate(): void {
  void queryClient.invalidateQueries({ queryKey: machineKey(machineId, 'files') });
}

/* --------------------------------- editor --------------------------------- */

const editorOpen = ref(false);
const editorItem = ref<FileItem | null>(null);
const editorContent = ref('');
const editorOriginal = ref('');
const editorRead = ref<FileReadResult | null>(null);
const editorBusy = ref(false);

async function openEditor(item: FileItem): Promise<void> {
  if (item.type !== 'file') return;
  editorBusy.value = true;
  editorItem.value = item;
  editorRead.value = null;
  editorContent.value = '';
  editorOriginal.value = '';
  editorOpen.value = true;
  try {
    const result = await api.value.files.read({ root: root.value, path: item.path });
    editorRead.value = result;
    if (result.isBinary) {
      message.warning('该文件看起来是二进制，编辑器不会覆盖写入。');
      return;
    }
    editorContent.value = result.content;
    editorOriginal.value = result.content;
  } catch (error) {
    message.error(describeError(error).description);
  } finally {
    editorBusy.value = false;
  }
}

const saveFileAction = useAction(
  () =>
    api.value.files.write({
      root: root.value,
      path: editorItem.value!.path,
      content: editorContent.value,
      encoding: 'utf8',
      overwrite: true,
      expectedMtime: editorRead.value?.mtime,
    }),
  {
    success: '文件已保存',
    successDescription: '使用 tmp + rename 原子写入。',
    invalidate: [machineKey(machineId, 'files')],
  },
);

async function saveFile(): Promise<void> {
  if (editorItem.value === null) return;
  const result = await saveFileAction.run();
  if (result !== undefined) {
    editorOriginal.value = editorContent.value;
    editorRead.value = { ...(editorRead.value as FileReadResult), mtime: result.mtime };
    void listQuery.refetch();
  }
}

const editorDirty = computed(() => editorContent.value !== editorOriginal.value);

function closeEditor(): void {
  if (editorDirty.value) {
    dialog.warning({
      title: '放弃未保存修改？',
      content: '关闭编辑器会丢失当前修改。',
      positiveText: '放弃修改',
      negativeText: '继续编辑',
      onPositiveClick: () => {
        editorOpen.value = false;
      },
    });
    return;
  }
  editorOpen.value = false;
}

/* -------------------------------- actions -------------------------------- */

const mkdirOpen = ref(false);
const mkdirName = ref('');

const mkdirAction = useAction(
  () => api.value.files.mkdir({ root: root.value, path: joinPath(path.value, mkdirName.value.trim()), recursive: false }),
  {
    success: '目录已创建',
    invalidate: [machineKey(machineId, 'files')],
  },
);

async function mkdir(): Promise<void> {
  if (mkdirName.value.trim().length === 0) return;
  const result = await mkdirAction.run();
  if (result !== undefined) {
    mkdirOpen.value = false;
    mkdirName.value = '';
    void listQuery.refetch();
  }
}

const newFileOpen = ref(false);
const newFileName = ref('');

const newFileAction = useAction(
  () => api.value.files.write({
    root: root.value,
    path: joinPath(path.value, newFileName.value.trim()),
    content: '',
    encoding: 'utf8',
    create: true,
    overwrite: false,
  }),
  {
    success: '文件已创建',
    invalidate: [machineKey(machineId, 'files')],
  },
);

async function createFile(): Promise<void> {
  if (newFileName.value.trim().length === 0) return;
  const result = await newFileAction.run();
  if (result !== undefined) {
    newFileOpen.value = false;
    newFileName.value = '';
    await listQuery.refetch();
    await openEditor(result);
  }
}

function chooseUpload(): void {
  uploadInput.value?.click();
}

const uploading = ref(false);

async function onUpload(event: Event): Promise<void> {
  const input = event.target as HTMLInputElement;
  const files = [...(input.files ?? [])];
  input.value = '';
  if (files.length === 0) return;
  uploading.value = true;
  let ok = 0;
  let failed = 0;
  for (const file of files) {
    try {
      await api.value.files.upload(root.value, joinPath(path.value, file.name), file);
      ok += 1;
    } catch (error) {
      failed += 1;
      message.error(`${file.name}: ${describeError(error).description}`);
    }
  }
  uploading.value = false;
  if (ok > 0) message.success(`已上传 ${ok} 个文件${failed > 0 ? `，失败 ${failed}` : ''}`);
  invalidate();
}

const renameOpen = ref(false);
const renameTarget = ref<FileItem | null>(null);
const renameName = ref('');

function openRename(item: FileItem): void {
  renameTarget.value = item;
  renameName.value = item.name;
  renameOpen.value = true;
}

const renameAction = useAction(
  () =>
    api.value.files.rename({
      root: root.value,
      from: renameTarget.value!.path,
      to: joinPath(path.value, renameName.value.trim()),
      overwrite: false,
    }),
  {
    success: '已重命名',
    invalidate: [machineKey(machineId, 'files')],
  },
);

async function rename(): Promise<void> {
  if (renameName.value.trim().length === 0) return;
  const result = await renameAction.run();
  if (result !== undefined) {
    renameOpen.value = false;
    void listQuery.refetch();
  }
}

const deleteAction = useAction(
  (input: { item: FileItem; permanent: boolean }) =>
    api.value.files.delete({ root: root.value, path: input.item.path, permanent: input.permanent }),
  {
    success: (result) => (result.trashed ? '已移入回收站' : '已永久删除'),
    invalidate: [machineKey(machineId, 'files')],
  },
);

function confirmDelete(item: FileItem): void {
  dialog.warning({
    title: '删除文件',
    content: `确定删除“${item.name}”？默认移入回收站，可在回收站恢复。`,
    positiveText: '移入回收站',
    negativeText: '取消',
    onPositiveClick: () => {
      void deleteAction.run({ item, permanent: false });
    },
  });
}

const chmodOpen = ref(false);
const chmodTarget = ref<FileItem | null>(null);
const chmodMode = ref('0644');

function openChmod(item: FileItem): void {
  chmodTarget.value = item;
  chmodMode.value = item.mode || '0644';
  chmodOpen.value = true;
}

const chmodAction = useAction(
  () => api.value.files.chmod({ root: root.value, path: chmodTarget.value!.path, mode: chmodMode.value.trim() }),
  {
    success: '权限已更新',
    invalidate: [machineKey(machineId, 'files')],
  },
);

async function chmod(): Promise<void> {
  const result = await chmodAction.run();
  if (result !== undefined) {
    chmodOpen.value = false;
    void listQuery.refetch();
  }
}

const downloading = ref<string | null>(null);
async function download(item: FileItem): Promise<void> {
  downloading.value = item.path;
  try {
    await api.value.files.download({ root: root.value, path: item.path });
  } catch (error) {
    message.error(describeError(error).description);
  } finally {
    downloading.value = null;
  }
}

/* --------------------------------- search --------------------------------- */

const searchOpen = ref(false);
const searchQuery = ref('');
const searchMode = ref<'name' | 'content'>('name');
const searchResults = ref<FileItem[]>([]);
const searching = ref(false);

async function runSearch(): Promise<void> {
  if (searchQuery.value.trim().length === 0) return;
  searching.value = true;
  try {
    const result = await api.value.files.search({
      root: root.value,
      path: path.value,
      q: searchQuery.value.trim(),
      mode: searchMode.value,
      limit: 100,
    });
    searchResults.value = result.items;
  } catch (error) {
    message.error(describeError(error).description);
  } finally {
    searching.value = false;
  }
}

function openSearchResult(item: FileItem): void {
  searchOpen.value = false;
  if (item.type === 'directory') path.value = item.path;
  else void openEditor(item);
}

/* --------------------------------- trash --------------------------------- */

const trashOpen = ref(false);
const trashQuery = useQuery({
  queryKey: computed(() => machineKey(machineId, 'files', 'trash', { limit: 100 })),
  queryFn: () => api.value.files.listTrash({ limit: 100 }),
  enabled: trashOpen,
  retry: 0,
});

const trashItems = computed(() => trashQuery.data.value?.items ?? []);

const restoreTrashAction = useAction((entry: TrashEntry) => api.value.files.restoreTrash({ trashId: entry.id }), {
  success: '已恢复',
  invalidate: [machineKey(machineId, 'files')],
});

const emptyTrashAction = useAction(() => api.value.files.emptyTrash({ all: true }), {
  success: (result) => `已清空回收站（删除 ${result.deleted} 项）`,
  invalidate: [machineKey(machineId, 'files')],
});

function confirmEmptyTrash(): void {
  dialog.warning({
    title: '清空回收站',
    content: '将永久删除回收站中的所有文件，无法恢复。',
    positiveText: '清空',
    negativeText: '取消',
    onPositiveClick: () => {
      void emptyTrashAction.run();
    },
  });
}

function typeIcon(item: FileItem): typeof DocumentOutline {
  return item.type === 'directory' ? FolderOutline : DocumentOutline;
}
</script>

<template>
  <div class="page">
    <PageHeader
      title="文件"
      subtitle="沙箱文件浏览、编辑、上传与回收站。所有路径都经过 realpath 前缀校验；请求经 core 代理到当前标签绑定的机器。"
    >
      <template #actions>
        <n-button size="small" secondary :loading="listQuery.isFetching.value" @click="listQuery.refetch()">
          <template #icon><n-icon :component="RefreshOutline" /></template>
          刷新
        </n-button>
        <n-button size="small" secondary :loading="uploading" @click="chooseUpload">
          <template #icon><n-icon :component="CloudUploadOutline" /></template>
          上传
        </n-button>
        <n-button size="small" type="primary" @click="mkdirOpen = true">
          <template #icon><n-icon :component="FolderOpenOutline" /></template>
          新建目录
        </n-button>
        <n-button size="small" secondary @click="newFileOpen = true">
          <template #icon><n-icon :component="DocumentOutline" /></template>
          新建文件
        </n-button>
        <n-button size="small" quaternary @click="trashOpen = true">回收站</n-button>
        <input ref="uploadInput" type="file" multiple hidden @change="onUpload" />
      </template>
    </PageHeader>

    <n-alert v-if="rootsQuery.data.value?.available === false" type="warning" :bordered="true" title="文件能力不可用">
      {{ rootsQuery.data.value.reason ?? '至少一个文件根需要通过 realpath 校验。' }}
    </n-alert>

    <error-state v-if="rootsQuery.isError.value" :error="rootsQuery.error.value" @retry="rootsQuery.refetch()" />
    <error-state v-else-if="listQuery.isError.value" :error="listQuery.error.value" @retry="listQuery.refetch()" />

    <n-card size="small">
      <div class="toolbar">
        <n-select
          v-model:value="root"
          style="width: 190px"
          placeholder="选择文件根"
          :options="roots.map((item) => ({ label: `${item.name}${item.writable ? '' : '（只读）'}`, value: item.name }))"
        />
        <n-button size="small" quaternary :disabled="path === '/'" title="上一级" @click="goUp">
          <template #icon><n-icon :component="ArrowUpOutline" /></template>
        </n-button>
        <div class="breadcrumbs">
          <button
            v-for="(crumb, index) in breadcrumbs"
            :key="crumb.path"
            type="button"
            class="crumb"
            @click="goPath(crumb.path)"
          >
            {{ crumb.label }}
            <span v-if="index < breadcrumbs.length - 1" class="muted">/</span>
          </button>
        </div>
        <div class="spacer" />
        <n-switch v-model:value="showHidden" size="small" />
        <span class="small muted">显示隐藏项</span>
        <n-button size="small" quaternary @click="searchOpen = true">
          <template #icon><n-icon :component="SearchOutline" /></template>
          搜索
        </n-button>
      </div>
      <div v-if="currentRoot" class="root-meta tiny muted">
        根路径 <code class="mono">{{ currentRoot.path }}</code>
        <span v-if="currentRoot.freeBytes !== null && currentRoot.freeBytes !== undefined">
          · 可用 {{ formatBytes(currentRoot.freeBytes) }} / {{ formatBytes(currentRoot.totalBytes ?? 0) }}
        </span>
      </div>
    </n-card>

    <n-empty v-if="roots.length === 0 && !rootsQuery.isLoading.value" description="没有可用的文件根">
      <template #extra>
        <p class="small muted">请检查 agent 的 MPANEL_FILES_ROOTS 配置与目录权限。</p>
      </template>
    </n-empty>

    <n-card v-else size="small" :content-style="{ padding: '0' }">
      <n-table :single-line="false" size="small">
        <thead>
          <tr>
            <th style="min-width: 240px">名称</th>
            <th style="width: 110px">大小</th>
            <th style="width: 130px">修改时间</th>
            <th style="width: 90px">权限</th>
            <th style="width: 240px">操作</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="item in sorted" :key="item.path">
            <td>
              <button type="button" class="file-name" @click="item.type === 'directory' ? openDir(item) : openEditor(item)">
                <n-icon :component="typeIcon(item)" />
                <span class="truncate">{{ item.name }}</span>
                <span v-if="item.isSymlink" class="tiny muted">→ {{ item.targetType ?? 'symlink' }}</span>
              </button>
            </td>
            <td class="small">{{ item.type === 'directory' ? '—' : formatBytes(item.size) }}</td>
            <td><RelativeTime :value="item.mtime" /></td>
            <td><code class="tiny">{{ item.mode }}</code></td>
            <td>
              <div class="actions">
                <n-button v-if="item.type === 'directory'" size="tiny" quaternary @click="openDir(item)">打开</n-button>
                <n-button v-else size="tiny" quaternary @click="openEditor(item)">编辑</n-button>
                <n-tooltip>
                  <template #trigger>
                    <n-button size="tiny" quaternary :loading="downloading === item.path" @click="download(item)">
                      <template #icon><n-icon :component="DownloadOutline" /></template>
                    </n-button>
                  </template>
                  下载
                </n-tooltip>
                <n-tooltip>
                  <template #trigger>
                    <n-button size="tiny" quaternary @click="openRename(item)">
                      <template #icon><n-icon :component="CreateOutline" /></template>
                    </n-button>
                  </template>
                  重命名
                </n-tooltip>
                <n-button size="tiny" quaternary @click="openChmod(item)">权限</n-button>
                <n-tooltip>
                  <template #trigger>
                    <n-button size="tiny" quaternary type="error" @click="confirmDelete(item)">
                      <template #icon><n-icon :component="TrashOutline" /></template>
                    </n-button>
                  </template>
                  删除
                </n-tooltip>
              </div>
            </td>
          </tr>
        </tbody>
      </n-table>
      <div v-if="sorted.length === 0" class="empty-row small muted">{{ listQuery.isLoading.value ? '加载中…' : '目录为空。' }}</div>
    </n-card>

    <!-- 编辑器 -->
    <n-drawer v-model:show="editorOpen" :width="820" placement="right">
      <n-drawer-content :title="editorItem?.name ?? '编辑文件'" closable>
        <div class="editor">
          <div class="toolbar">
            <span class="mono tiny muted">{{ editorItem?.path }}</span>
            <div class="spacer" />
            <n-tag v-if="editorDirty" size="tiny" type="warning" :bordered="false">未保存</n-tag>
            <n-button size="small" secondary :disabled="!editorDirty" :loading="saveFileAction.pending.value" @click="saveFile">保存</n-button>
            <n-button size="small" quaternary @click="closeEditor">关闭</n-button>
          </div>
          <n-alert v-if="editorRead?.truncated" type="warning" :bordered="false">
            文件过大，只读取了前 {{ formatBytes(editorRead.size) }} 的一部分；保存会覆盖原文件。
          </n-alert>
          <n-alert v-if="editorRead?.isBinary" type="info" :bordered="false">
            二进制文件不支持编辑；仅可下载。
          </n-alert>
          <code-editor
            v-if="!editorRead?.isBinary"
            v-model="editorContent"
            language="text"
            height="600px"
          />
          <code-block v-else :text="`二进制文件 · ${editorItem?.size ?? 0} bytes`" />
        </div>
      </n-drawer-content>
    </n-drawer>

    <!-- 新建目录 -->
    <n-modal v-model:show="mkdirOpen" preset="card" title="新建目录" style="width: 460px">
      <n-input v-model:value="mkdirName" placeholder="目录名称" @keydown.enter="mkdir" />
      <template #footer>
        <div class="toolbar" style="justify-content: flex-end">
          <n-button quaternary @click="mkdirOpen = false">取消</n-button>
          <n-button type="primary" :loading="mkdirAction.pending.value" @click="mkdir">创建</n-button>
        </div>
      </template>
    </n-modal>

    <!-- 新建文件 -->
    <n-modal v-model:show="newFileOpen" preset="card" title="新建文件" style="width: 460px">
      <n-input v-model:value="newFileName" placeholder="文件名，例如 README.md" @keydown.enter="createFile" />
      <template #footer>
        <div class="toolbar" style="justify-content: flex-end">
          <n-button quaternary @click="newFileOpen = false">取消</n-button>
          <n-button type="primary" :loading="newFileAction.pending.value" @click="createFile">创建</n-button>
        </div>
      </template>
    </n-modal>

    <!-- 重命名 -->
    <n-modal v-model:show="renameOpen" preset="card" title="重命名" style="width: 460px">
      <n-input v-model:value="renameName" placeholder="新名称" @keydown.enter="rename" />
      <template #footer>
        <div class="toolbar" style="justify-content: flex-end">
          <n-button quaternary @click="renameOpen = false">取消</n-button>
          <n-button type="primary" :loading="renameAction.pending.value" @click="rename">保存</n-button>
        </div>
      </template>
    </n-modal>

    <!-- chmod -->
    <n-modal v-model:show="chmodOpen" preset="card" title="修改权限" style="width: 420px">
      <n-input v-model:value="chmodMode" placeholder="0644" class="mono" />
      <template #footer>
        <div class="toolbar" style="justify-content: flex-end">
          <n-button quaternary @click="chmodOpen = false">取消</n-button>
          <n-button type="primary" :loading="chmodAction.pending.value" @click="chmod">保存</n-button>
        </div>
      </template>
    </n-modal>

    <!-- 搜索 -->
    <n-modal v-model:show="searchOpen" preset="card" title="搜索文件" style="width: 760px; max-width: calc(100vw - 24px)">
      <div class="toolbar">
        <n-input v-model:value="searchQuery" placeholder="文件名或内容…" style="flex: 1" @keydown.enter="runSearch" />
        <n-select v-model:value="searchMode" style="width: 120px" :options="[{ label: '名称', value: 'name' }, { label: '内容', value: 'content' }]" />
        <n-button type="primary" :loading="searching" @click="runSearch">搜索</n-button>
      </div>
      <div class="search-results">
        <button
          v-for="item in searchResults"
          :key="item.path"
          type="button"
          class="search-item"
          @click="openSearchResult(item)"
        >
          <n-icon :component="typeIcon(item)" />
          <span class="mono tiny">{{ item.path }}</span>
        </button>
        <span v-if="searchResults.length === 0" class="small muted">没有结果。</span>
      </div>
    </n-modal>

    <!-- 回收站 -->
    <n-drawer v-model:show="trashOpen" :width="680" placement="right">
      <n-drawer-content title="回收站" closable>
        <div class="toolbar" style="margin-bottom: 8px">
          <span class="small muted">共 {{ trashItems.length }} 项</span>
          <div class="spacer" />
          <n-button size="small" secondary :loading="trashQuery.isFetching.value" @click="trashQuery.refetch()">刷新</n-button>
          <n-button size="small" quaternary type="error" @click="confirmEmptyTrash">清空</n-button>
        </div>
        <error-state v-if="trashQuery.isError.value" :error="trashQuery.error.value" @retry="trashQuery.refetch()" />
        <n-empty v-else-if="trashItems.length === 0" description="回收站为空" />
        <n-table v-else :single-line="false" size="small">
          <thead>
            <tr>
              <th style="min-width: 220px">原路径</th>
              <th style="width: 100px">类型</th>
              <th style="width: 100px">大小</th>
              <th style="width: 120px">删除时间</th>
              <th style="width: 90px">操作</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="entry in trashItems" :key="entry.id">
              <td><span class="mono tiny">{{ entry.originalPath }}</span></td>
              <td class="small">{{ entry.type }}</td>
              <td class="small">{{ formatBytes(entry.sizeBytes) }}</td>
              <td><RelativeTime :value="entry.trashedAt" /></td>
              <td><n-button size="tiny" secondary @click="restoreTrashAction.run(entry)">恢复</n-button></td>
            </tr>
          </tbody>
        </n-table>
      </n-drawer-content>
    </n-drawer>
  </div>
</template>

<style scoped>
.breadcrumbs {
  display: flex;
  align-items: center;
  gap: 2px;
  flex-wrap: wrap;
  min-width: 0;
}
.crumb {
  border: 0;
  background: transparent;
  color: var(--mpanel-muted);
  font-size: 12px;
  cursor: pointer;
  padding: 2px 3px;
  border-radius: 4px;
}
.crumb:hover {
  color: var(--mpanel-accent);
  background: color-mix(in srgb, var(--mpanel-accent) 8%, transparent);
}
.root-meta {
  margin-top: 6px;
}
.file-name {
  display: flex;
  align-items: center;
  gap: 6px;
  border: 0;
  background: transparent;
  color: var(--mpanel-text);
  font-size: 13px;
  cursor: pointer;
  padding: 0;
  max-width: 380px;
  text-align: left;
}
.file-name:hover {
  color: var(--mpanel-accent);
}
.actions {
  display: flex;
  flex-wrap: wrap;
  gap: 2px;
}
.empty-row {
  padding: 18px;
  text-align: center;
}
.editor {
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.search-results {
  display: flex;
  flex-direction: column;
  gap: 2px;
  margin-top: 10px;
  max-height: 400px;
  overflow: auto;
}
.search-item {
  display: flex;
  align-items: center;
  gap: 6px;
  border: 0;
  background: transparent;
  color: var(--mpanel-text);
  text-align: left;
  padding: 6px;
  border-radius: 6px;
  cursor: pointer;
}
.search-item:hover {
  background: var(--mpanel-surface-soft);
}
</style>
