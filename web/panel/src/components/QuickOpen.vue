<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { NButton, NModal, NSelect, NSwitch, NTag } from 'naive-ui';
import { MACHINE_AREAS, openMachinePage } from '@/lib/navigation';
import { useMachinesQuery } from '@/lib/machines';
import { activeTab } from '@/lib/workspace';
import { machineStatusLabel, machineStatusType } from '@/lib/status';

const props = defineProps<{ show: boolean }>();
const emit = defineEmits<{ 'update:show': [value: boolean] }>();

const machinesQuery = useMachinesQuery();
const machineId = ref<string | null>(null);
const area = ref('sites');
const forceNew = ref(true);

const machines = computed(() => machinesQuery.data.value?.items ?? []);

const machineOptions = computed(() =>
  machines.value.map((machine) => ({
    label: `${machine.name} · ${machineStatusLabel(machine.status)} · ${machine.transport}`,
    value: machine.id,
  })),
);

const areaOptions = MACHINE_AREAS.map((item) => ({
  label: `${item.title} — ${item.description}`,
  value: item.area,
}));

watch(
  () => props.show,
  (show) => {
    if (!show) return;
    if (machineId.value === null || !machines.value.some((m) => m.id === machineId.value)) {
      machineId.value =
        activeTab.value?.machineId ??
        machines.value.find((machine) => machine.status === 'online')?.id ??
        machines.value[0]?.id ??
        null;
    }
    area.value = routeArea();
  },
);

function routeArea(): string {
  const title = activeTab.value?.pageTitle;
  const matched = MACHINE_AREAS.find((item) => item.title === title);
  return matched?.area ?? 'sites';
}

function close(): void {
  emit('update:show', false);
}

function submit(): void {
  if (machineId.value === null) return;
  openMachinePage(machineId.value, area.value, { forceNew: forceNew.value });
  close();
}

const selectedMachine = computed(() =>
  machines.value.find((machine) => machine.id === machineId.value),
);
</script>

<template>
  <n-modal
    :show="props.show"
    preset="card"
    title="打开机器页面"
    style="width: 640px; max-width: calc(100vw - 24px)"
    @update:show="emit('update:show', $event)"
  >
    <div class="quick-form">
      <div class="field">
        <span class="label">目标机器</span>
        <n-select
          v-model:value="machineId"
          filterable
          placeholder="选择机器"
          :options="machineOptions"
          :loading="machinesQuery.isLoading.value"
        />
        <div v-if="selectedMachine" class="selected">
          <n-tag
            :type="machineStatusType(selectedMachine.status)"
            size="small"
            round
            :bordered="false"
          >
            {{ machineStatusLabel(selectedMachine.status) }}
          </n-tag>
          <span class="tiny muted">{{ selectedMachine.transport }} · {{ selectedMachine.endpoint ?? 'stdio' }}</span>
        </div>
      </div>

      <div class="field">
        <span class="label">页面</span>
        <n-select v-model:value="area" :options="areaOptions" />
      </div>

      <div class="field row">
        <n-switch v-model:value="forceNew" />
        <span class="small">总是新建标签页（同一机器也可同时打开多个页面）</span>
      </div>

      <div class="tip small muted">
        每个标签页绑定一台机器；切换机器不会替换当前标签。已打开相同路径时会自动聚焦。
      </div>
    </div>

    <template #footer>
      <div class="footer">
        <n-button quaternary @click="close">取消</n-button>
        <n-button type="primary" :disabled="machineId === null" @click="submit">打开</n-button>
      </div>
    </template>
  </n-modal>
</template>

<style scoped>
.quick-form {
  display: flex;
  flex-direction: column;
  gap: 16px;
}
.field {
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.field.row {
  flex-direction: row;
  align-items: center;
  gap: 10px;
}
.label {
  font-size: 12px;
  color: var(--mpanel-muted);
}
.selected {
  display: flex;
  align-items: center;
  gap: 8px;
}
.tip {
  line-height: 1.6;
  padding: 8px 10px;
  border-radius: 8px;
  background: var(--mpanel-surface-soft);
}
.footer {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
}
</style>
