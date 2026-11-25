<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, watch } from 'vue';
import { useRoute } from 'vue-router';
import {
  NAlert,
  NButton,
  NCard,
  NEmpty,
  NIcon,
  NInput,
  NInputNumber,
  NModal,
  NSelect,
  NTabPane,
  NTabs,
  NTag,
} from 'naive-ui';
import {
  AddOutline,
  CloseOutline,
  RefreshOutline,
  TerminalOutline,
} from '@vicons/ionicons5';
import type { ShellInfo, TerminalCreateInput, TerminalSession } from '@/api/types';
import { useMachineApi } from '@/lib/api';
import { machineKey } from '@/lib/query-keys';
import { useQuery } from '@tanstack/vue-query';
import { useAction } from '@/composables/use-action';
import { usePageActive } from '@/composables/use-page-active';
import { connectWs, type WsSession } from '@/api/ws';
import { describeError } from '@/api/errors';
import PageHeader from '@/components/common/PageHeader.vue';
import ErrorState from '@/components/common/ErrorState.vue';
import XtermTerminal from '@/components/common/XtermTerminal.vue';

interface LiveSession {
  info: TerminalSession;
  ws: WsSession | null;
  status: 'connecting' | 'open' | 'closed' | 'error';
  error: string | null;
  exited: boolean;
}

const route = useRoute();
const machineId = String(route.params.machineId ?? '');
const api = useMachineApi(machineId);
const active = usePageActive();

const sessionsQuery = useQuery({
  queryKey: computed(() => machineKey(machineId, 'terminal', 'sessions')),
  queryFn: () => api.value.terminal.list(),
  enabled: active,
  refetchInterval: computed(() => (active.value ? 10_000 : false)),
  retry: 0,
});

const shellsQuery = useQuery({
  queryKey: computed(() => machineKey(machineId, 'terminal', 'shells')),
  queryFn: () => api.value.terminal.shells(),
  retry: 0,
});

const sessions = computed(() => sessionsQuery.data.value?.items ?? []);
const shells = computed(() => shellsQuery.data.value?.items ?? []);

const live = ref<Record<string, LiveSession>>({});
const tab = ref('');
const terminalRefs = new Map<string, InstanceType<typeof XtermTerminal>>();

function setTerminalRef(id: string, instance: unknown): void {
  if (instance === null || instance === undefined) terminalRefs.delete(id);
  else terminalRefs.set(id, instance as InstanceType<typeof XtermTerminal>);
}

function wsFeaturePath(id: string): string {
  return `/terminal/${encodeURIComponent(id)}`;
}

async function attach(session: TerminalSession): Promise<void> {
  const existing = live.value[session.id];
  if (existing !== undefined && existing.ws !== null) return;
  live.value[session.id] = {
    info: session,
    ws: null,
    status: 'connecting',
    error: null,
    exited: false,
  };
  tab.value = session.id;
  await nextTick();
  try {
    const ws = await connectWs(api.value, wsFeaturePath(session.id), {
      onMessage(data, binary) {
        const entry = live.value[session.id];
        if (entry === undefined) return;
        const text = binary ? new TextDecoder().decode(data as Uint8Array) : String(data);
        for (const line of text.split('\n')) {
          if (line.trim().length === 0) continue;
          try {
            const frame = JSON.parse(line) as {
              type?: string;
              data?: string;
              code?: number | null;
              message?: string;
            };
            if (frame.type === 'ready' && frame.data === undefined) continue;
            if (frame.type === 'output' && typeof frame.data === 'string') {
              terminalRefs.get(session.id)?.write(frame.data);
            } else if (frame.type === 'exit') {
              entry.exited = true;
              terminalRefs.get(session.id)?.writeln(`\r\n[进程已退出，代码 ${frame.code ?? '—'}]`);
            } else if (frame.type === 'error') {
              entry.error = frame.message ?? '终端错误';
              terminalRefs.get(session.id)?.writeln(`\r\n[错误] ${entry.error}`);
            }
          } catch {
            // 非 JSON 帧直接写入终端。
            terminalRefs.get(session.id)?.write(text);
          }
        }
      },
      onClose({ code, reason }) {
        const entry = live.value[session.id];
        if (entry === undefined) return;
        entry.status = 'closed';
        entry.ws = null;
        if (!entry.exited) {
          terminalRefs.get(session.id)?.writeln(`\r\n[连接关闭 ${code}${reason.length > 0 ? `：${reason}` : ''}]`);
        }
      },
      onError() {
        const entry = live.value[session.id];
        if (entry === undefined) return;
        entry.status = 'error';
      },
    });
    live.value[session.id] = {
      ...(live.value[session.id] as LiveSession),
      ws,
      status: 'open',
    };
  } catch (error) {
    live.value[session.id] = {
      ...(live.value[session.id] as LiveSession),
      status: 'error',
      error: describeError(error).description,
    };
  }
}

function detach(id: string): void {
  const entry = live.value[id];
  if (entry?.ws) {
    entry.ws.close(1000, 'detach');
    entry.ws = null;
  }
  delete live.value[id];
  terminalRefs.delete(id);
  if (tab.value === id) tab.value = Object.keys(live.value)[0] ?? '';
}

function sendInput(id: string, data: string): void {
  live.value[id]?.ws?.sendText(JSON.stringify({ type: 'input', data }));
}

function resize(id: string, cols: number, rows: number): void {
  live.value[id]?.ws?.sendText(JSON.stringify({ type: 'resize', cols, rows }));
}

const createOpen = ref(false);
const shell = ref('');
const cwd = ref('');
const cols = ref(120);
const rows = ref(32);

const createAction = useAction(
  (input: TerminalCreateInput) => api.value.terminal.create(input),
  {
    success: (session) => `已创建终端会话 ${session.id}`,
    successDescription: session => (session.pty ? 'PTY 会话' : '管道会话（pty=false）'),
    invalidate: [machineKey(machineId, 'terminal')],
  },
);

async function createSession(): Promise<void> {
  const input: TerminalCreateInput = { cols: cols.value, rows: rows.value };
  if (shell.value.length > 0) input.shell = shell.value;
  if (cwd.value.trim().length > 0) input.cwd = cwd.value.trim();
  const session = await createAction.run(input);
  if (session !== undefined) {
    createOpen.value = false;
    shell.value = '';
    cwd.value = '';
    await attach(session);
  }
}

async function openExisting(session: TerminalSession): Promise<void> {
  await attach(session);
}

const killAction = useAction((id: string) => api.value.terminal.close(id), {
  success: '会话已关闭',
  invalidate: [machineKey(machineId, 'terminal')],
});

async function kill(id: string): Promise<void> {
  const result = await killAction.run(id);
  if (result !== undefined) detach(id);
}

onBeforeUnmount(() => {
  for (const id of Object.keys(live.value)) detach(id);
});

watch(active, (value) => {
  if (!value) return;
  void sessionsQuery.refetch();
});

const shellOptions = computed(() =>
  shells.value.map((item: ShellInfo) => ({ label: `${item.name}（${item.path}）`, value: item.path })),
);
</script>

<template>
  <div class="page">
    <PageHeader
      title="终端"
      subtitle="经 core 代理的 PTY/管道会话。每个会话使用一次性 WS ticket；浏览器不直连 agent。"
    >
      <template #actions>
        <n-button size="small" secondary :loading="sessionsQuery.isFetching.value" @click="sessionsQuery.refetch()">
          <template #icon><n-icon :component="RefreshOutline" /></template>
          刷新
        </n-button>
        <n-button size="small" type="primary" @click="createOpen = true">
          <template #icon><n-icon :component="AddOutline" /></template>
          新建会话
        </n-button>
      </template>
    </PageHeader>

    <n-alert v-if="sessionsQuery.data.value?.available === false" type="warning" :bordered="true" title="终端不可用">
      {{ sessionsQuery.data.value.reason ?? 'agent 无法 spawn 进程。' }}
    </n-alert>

    <error-state v-if="sessionsQuery.isError.value" :error="sessionsQuery.error.value" @retry="sessionsQuery.refetch()" />

    <div class="terminal-layout">
      <n-card size="small" class="sessions-card">
        <div class="tiny muted" style="margin-bottom: 6px">活动会话（{{ sessions.length }}）</div>
        <n-empty v-if="sessions.length === 0" description="没有终端会话" size="small" />
        <div class="session-list">
          <button
            v-for="session in sessions"
            :key="session.id"
            type="button"
            class="session-item"
            :class="{ active: tab === session.id }"
            @click="openExisting(session)"
          >
            <div class="session-main">
              <span class="mono tiny">{{ session.shell }}</span>
              <span class="tiny muted truncate">{{ session.cwd }}</span>
              <span class="tiny muted">{{ session.cols }}×{{ session.rows }} · {{ session.pty ? 'PTY' : '管道' }}</span>
            </div>
            <n-tag size="tiny" :bordered="false" :type="session.status === 'running' ? 'success' : 'default'">
              {{ session.status }}
            </n-tag>
          </button>
        </div>
      </n-card>

      <n-card size="small" class="terminal-card">
        <n-tabs
          v-if="Object.keys(live).length > 0"
          v-model:value="tab"
          type="card"
          closable
          tab-style="min-width: 120px"
          @close="detach"
        >
          <n-tab-pane
            v-for="(entry, id) in live"
            :key="id"
            :name="id"
            :tab="`${entry.info.shell} · ${id.slice(-6)}`"
          >
            <div class="term-head">
              <n-tag size="tiny" :bordered="false" :type="entry.status === 'open' ? 'success' : entry.status === 'error' ? 'error' : 'warning'">
                {{ entry.status }}
              </n-tag>
              <span v-if="entry.error" class="tiny error-text">{{ entry.error }}</span>
              <div class="spacer" />
              <n-button size="tiny" quaternary @click="kill(id)">关闭会话</n-button>
            </div>
            <xterm-terminal
              :ref="(instance) => setTerminalRef(id, instance)"
              style="height: 560px"
              @data="(data: string) => sendInput(id, data)"
              @resize="(size) => resize(id, size.cols, size.rows)"
            />
          </n-tab-pane>
        </n-tabs>
        <n-empty v-else description="选择左侧会话，或新建一个终端">
          <template #extra>
            <n-button type="primary" @click="createOpen = true">
              <template #icon><n-icon :component="TerminalOutline" /></template>
              新建会话
            </n-button>
          </template>
        </n-empty>
      </n-card>
    </div>

    <n-modal v-model:show="createOpen" preset="card" title="新建终端会话" style="width: 560px; max-width: calc(100vw - 24px)">
      <div class="form">
        <n-select
          v-model:value="shell"
          :options="shellOptions"
          placeholder="默认 shell"
          clearable
        />
        <n-input v-model:value="cwd" placeholder="工作目录（可选）" class="mono" />
        <div class="two">
          <n-input-number v-model:value="cols" :min="20" :max="500" style="width: 100%">
            <template #prefix>cols</template>
          </n-input-number>
          <n-input-number v-model:value="rows" :min="5" :max="200" style="width: 100%">
            <template #prefix>rows</template>
          </n-input-number>
        </div>
        <p class="tiny muted">Windows 上 PTY 不可用时自动降级为管道并标注 pty=false。</p>
      </div>
      <template #footer>
        <div class="toolbar" style="justify-content: flex-end">
          <n-button quaternary @click="createOpen = false">取消</n-button>
          <n-button type="primary" :loading="createAction.pending.value" @click="createSession">创建</n-button>
        </div>
      </template>
    </n-modal>
  </div>
</template>

<style scoped>
.terminal-layout {
  display: grid;
  grid-template-columns: minmax(220px, 280px) minmax(0, 1fr);
  gap: 12px;
  align-items: start;
}
@media (max-width: 900px) {
  .terminal-layout {
    grid-template-columns: 1fr;
  }
}
.session-list {
  display: flex;
  flex-direction: column;
  gap: 4px;
  max-height: 60vh;
  overflow: auto;
}
.session-item {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 6px;
  border: 1px solid transparent;
  border-radius: 8px;
  background: transparent;
  color: var(--mpanel-text);
  padding: 6px 8px;
  text-align: left;
  cursor: pointer;
}
.session-item:hover,
.session-item.active {
  background: color-mix(in srgb, var(--mpanel-accent) 10%, transparent);
  border-color: color-mix(in srgb, var(--mpanel-accent) 35%, transparent);
}
.session-main {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
}
.term-head {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 6px;
}
.form {
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.two {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 10px;
}
.error-text {
  color: #e05561;
}
</style>
