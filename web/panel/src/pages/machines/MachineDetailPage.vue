<script setup lang="ts">
import { computed, ref } from 'vue';
import { useRoute } from 'vue-router';
import {
  NAlert,
  NButton,
  NCard,
  NDescriptions,
  NDescriptionsItem,
  NIcon,
  NTag,
} from 'naive-ui';
import { RefreshOutline, OpenOutline } from '@vicons/ionicons5';
import { useMachineQuery } from '@/lib/machines';
import { useCoreApi } from '@/lib/api';
import { useAction } from '@/composables/use-action';
import { coreKey } from '@/lib/query-keys';
import { formatBytes, formatDate, formatUptime, machineAddressLabel, transportLabel } from '@/lib/format';
import { MACHINE_NAV_ITEMS, openMachineNavItem, openMachinePage } from '@/lib/navigation';
import PageHeader from '@/components/common/PageHeader.vue';
import ErrorState from '@/components/common/ErrorState.vue';
import MachineStatusTag from '@/components/common/MachineStatusTag.vue';

const route = useRoute();
const machineId = String(route.params.machineId ?? '');
const machineQuery = useMachineQuery(machineId);
const api = useCoreApi();
const machine = computed(() => machineQuery.data.value);

const connectAction = useAction(() => api.value.machines.connect(machineId), {
  success: '已请求连接机器',
  errorMessage: '连接失败，请确认服务器在线后重试',
  invalidate: [coreKey('machines', 'list', { limit: 200 }), coreKey('machines', 'detail', machineId)],
});

const testResult = ref<string | null>(null);
const testAction = useAction(() => api.value.machines.test(machineId), {
  success: (result) => (result.reachable ? `可达 · ${result.latencyMs ?? '?'} ms` : '暂时无法连接'),
  errorMessage: '连接失败，请确认服务器在线后重试',
  invalidate: [coreKey('machines', 'detail', machineId)],
});

async function test(): Promise<void> {
  const result = await testAction.run();
  if (result !== undefined) {
    testResult.value = result.reachable
      ? `可达 · ${result.latencyMs ?? '?'} ms`
      : '暂时无法连接';
  }
}

const CAPABILITY_LABELS: Record<string, string> = {
  caddy: 'Caddy',
  docker: 'Docker',
  postgres: 'PostgreSQL',
  redis: 'Redis',
  pty: '终端',
};

const capabilities = computed(() => {
  const caps = machine.value?.capabilities;
  if (caps === null || caps === undefined) return [];
  return (Object.keys(caps) as Array<keyof typeof caps>).map((key) => ({
    key,
    label: CAPABILITY_LABELS[key] ?? key,
    status: caps[key],
  }));
});

const snapshot = computed(() => machine.value?.snapshot ?? null);
</script>

<template>
  <div class="page">
    <PageHeader title="机器详情">
      <template #meta>
        <n-tag size="small" round :bordered="false" class="mono">{{ machineId }}</n-tag>
      </template>
      <template #actions>
        <n-button size="small" secondary :loading="machineQuery.isFetching.value" @click="machineQuery.refetch()">
          <template #icon><n-icon :component="RefreshOutline" /></template>
          刷新
        </n-button>
        <n-button size="small" secondary :loading="testAction.pending.value" @click="test">测试连接</n-button>
        <n-button size="small" type="primary" @click="openMachinePage(machineId, 'sites')">
          <template #icon><n-icon :component="OpenOutline" /></template>
          打开工作台
        </n-button>
      </template>
    </PageHeader>

    <error-state
      v-if="machineQuery.isError.value"
      :error="machineQuery.error.value"
      @retry="machineQuery.refetch()"
    />

    <template v-if="machine">
      <n-card size="small">
        <div class="top">
          <div>
            <div class="title-row">
              <strong class="name">{{ machine.name }}</strong>
              <MachineStatusTag :status="machine.status" />
              <n-tag size="tiny" round :bordered="false">{{ transportLabel(machine.transport) }}</n-tag>
              <n-tag v-if="machine.edge" size="tiny" type="info" round :bordered="false">边缘</n-tag>
              <n-tag v-if="machine.group" size="tiny" round :bordered="false">{{ machine.group }}</n-tag>
            </div>
            <div class="tiny muted" style="margin-top: 4px">
              {{ machineAddressLabel(machine) }}
            </div>
          </div>
          <div class="toolbar">
            <n-button
              v-if="machine.status !== 'online'"
              size="small"
              type="primary"
              secondary
              :loading="connectAction.pending.value"
              @click="connectAction.run()"
            >
              连接
            </n-button>
            <n-button size="small" quaternary @click="testAction.run()">快速测试</n-button>
          </div>
        </div>

        <n-alert
          v-if="machine.lastError && machine.status !== 'online'"
          type="warning"
          :bordered="true"
          title="暂时无法连接"
          style="margin-top: 12px"
        >
          请确认服务器在线、面板地址正确后重试。
        </n-alert>

        <div class="descriptions">
          <n-descriptions label-placement="left" bordered size="small" :column="2">
            <n-descriptions-item label="机器 ID"><span class="mono">{{ machine.id }}</span></n-descriptions-item>
            <n-descriptions-item label="接入方式">{{ transportLabel(machine.transport) }}</n-descriptions-item>
            <n-descriptions-item label="启用">{{ machine.enabled ? '是' : '否' }}</n-descriptions-item>
            <n-descriptions-item label="期望状态">{{ machine.desiredState }}</n-descriptions-item>
            <n-descriptions-item label="创建时间">{{ formatDate(machine.createdAt) }}</n-descriptions-item>
            <n-descriptions-item label="更新时间">{{ formatDate(machine.updatedAt) }}</n-descriptions-item>
            <n-descriptions-item label="节点信息" :span="2">
              <template v-if="machine.worker">
                {{ machine.worker.platform }}/{{ machine.worker.arch }}
              </template>
              <span v-else class="muted">尚未上报</span>
            </n-descriptions-item>
            <n-descriptions-item v-if="testResult !== null" label="测试结果" :span="2">
              {{ testResult }}
            </n-descriptions-item>
          </n-descriptions>
        </div>

        <div class="caps">
          <span class="tiny muted">能力：</span>
          <n-tag
            v-for="cap in capabilities"
            :key="cap.key"
            size="small"
            round
            :bordered="false"
            :type="cap.status.available ? 'success' : 'default'"
            :title="cap.status.reason"
          >
            {{ cap.label }}<template v-if="cap.status.version"> {{ cap.status.version }}</template>
          </n-tag>
          <span v-if="capabilities.length === 0" class="tiny muted">能力尚未上报</span>
        </div>
      </n-card>

      <div class="split">
        <n-card size="small" title="节点快照">
          <template v-if="snapshot">
            <n-descriptions label-placement="left" bordered size="small" :column="1">
              <n-descriptions-item label="主机名">{{ snapshot.hostname }}</n-descriptions-item>
              <n-descriptions-item label="平台">{{ snapshot.platform }}/{{ snapshot.arch }}</n-descriptions-item>
              <n-descriptions-item label="发行版">{{ snapshot.release }}</n-descriptions-item>
              <n-descriptions-item label="CPU">{{ snapshot.cpuCount }} 核</n-descriptions-item>
              <n-descriptions-item label="负载">
                {{ snapshot.loadavg ? snapshot.loadavg.map((v) => v.toFixed(2)).join(' / ') : '—' }}
              </n-descriptions-item>
              <n-descriptions-item label="内存">
                {{ formatBytes(snapshot.memTotalBytes - snapshot.memFreeBytes) }} /
                {{ formatBytes(snapshot.memTotalBytes) }}
              </n-descriptions-item>
              <n-descriptions-item label="磁盘">
                <template v-if="snapshot.diskTotalBytes !== null && snapshot.diskFreeBytes !== null">
                  {{ formatBytes(snapshot.diskTotalBytes - snapshot.diskFreeBytes) }} /
                  {{ formatBytes(snapshot.diskTotalBytes) }}
                </template>
                <span v-else class="muted">未知</span>
              </n-descriptions-item>
              <n-descriptions-item label="运行时长">{{ formatUptime(snapshot.uptimeSec) }}</n-descriptions-item>
              <n-descriptions-item label="IP">{{ snapshot.ips.join(', ') || '—' }}</n-descriptions-item>
              <n-descriptions-item label="采集时间">{{ formatDate(snapshot.collectedAt) }}</n-descriptions-item>
            </n-descriptions>
          </template>
          <n-alert v-else type="info" :bordered="false">
            尚未采集到该机器的节点快照；机器在线后会自动刷新。
          </n-alert>
        </n-card>

        <n-card size="small" title="打开该机器的页面">
          <div class="area-grid">
            <n-button
              v-for="item in MACHINE_NAV_ITEMS"
              :key="item.key"
              size="small"
              secondary
              @click="openMachineNavItem(machineId, item)"
            >
              {{ item.title }}
            </n-button>
          </div>
        </n-card>
      </div>
    </template>
  </div>
</template>

<style scoped>
.top {
  display: flex;
  justify-content: space-between;
  gap: 12px;
  flex-wrap: wrap;
}
.title-row {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}
.name {
  font-size: 16px;
}
.descriptions {
  margin-top: 12px;
}
.caps {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-wrap: wrap;
  margin-top: 12px;
}
.area-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(120px, 1fr));
  gap: 8px;
}
</style>
