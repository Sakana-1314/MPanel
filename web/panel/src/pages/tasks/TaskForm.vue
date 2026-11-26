<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import {
  NAlert,
  NButton,
  NCard,
  NFormItem,
  NIcon,
  NInput,
  NInputNumber,
  NSelect,
  NSwitch,
} from 'naive-ui';
import { AddOutline, TrashOutline } from '@vicons/ionicons5';
import { formatDate, formatRelativeTime } from '@/lib/format';
import {
  CRON_PRESETS,
  nextCronRuns,
  validateCronExpression,
} from '@/lib/cron';
import {
  envKeyIssue,
  hasTaskDraftErrors,
  validateTaskDraft,
  type TaskDraft,
} from './task-form';

const props = withDefaults(
  defineProps<{
    draft: TaskDraft;
    submitting?: boolean;
    mode?: 'create' | 'edit';
    submitLabel?: string;
    showCancel?: boolean;
  }>(),
  { submitting: false, mode: 'create', submitLabel: '保存', showCancel: true },
);

const emit = defineEmits<{ submit: []; cancel: [] }>();

const submitted = ref(false);

const cronCheck = computed(() => validateCronExpression(props.draft.schedule));
const errors = computed(() =>
  validateTaskDraft(
    props.draft,
    props.draft.schedule.trim().length === 0
      ? undefined
      : cronCheck.value.valid
        ? undefined
        : (cronCheck.value.error ?? 'cron 表达式无效'),
  ),
);
const hasErrors = computed(() => hasTaskDraftErrors(errors.value));

const nextRuns = computed<Date[]>(() => {
  if (!cronCheck.value.valid) return [];
  try {
    return nextCronRuns(props.draft.schedule, 5);
  } catch {
    return [];
  }
});

interface EnvRow {
  id: string;
  key: string;
  value: string;
}

let seq = 0;
function rowId(): string {
  seq += 1;
  return `env_${seq}`;
}

function toRows(env: Record<string, string>): EnvRow[] {
  return Object.entries(env).map(([key, value]) => ({ id: rowId(), key, value }));
}

const envRows = ref<EnvRow[]>(toRows(props.draft.env));

function envMap(rows: EnvRow[]): Record<string, string> {
  const result: Record<string, string> = {};
  for (const row of rows) {
    const key = row.key.trim();
    if (key.length > 0) result[key] = row.value;
  }
  return result;
}

watch(
  () => JSON.stringify(props.draft.env),
  (serialized) => {
    if (serialized !== JSON.stringify(envMap(envRows.value))) {
      envRows.value = toRows(props.draft.env);
    }
  },
);

const envRowErrors = computed(() => {
  const result: Record<string, string> = {};
  const seen = new Map<string, string>();
  for (const row of envRows.value) {
    const key = row.key.trim();
    if (key.length === 0) {
      if (row.value.length > 0) result[row.id] = '变量名不能为空';
      continue;
    }
    const issue = envKeyIssue(key);
    if (issue !== null) {
      result[row.id] = issue;
      continue;
    }
    if (row.value.length > 4096) {
      result[row.id] = '变量值最长 4096 个字符';
      continue;
    }
    const previous = seen.get(key);
    if (previous !== undefined) {
      result[row.id] = '变量名重复';
      if (result[previous] === undefined) result[previous] = '变量名重复';
      continue;
    }
    seen.set(key, row.id);
  }
  return result;
});

function commitEnv(): void {
  props.draft.env = envMap(envRows.value);
}

function addEnvRow(): void {
  envRows.value.push({ id: rowId(), key: '', value: '' });
}

function removeEnvRow(id: string): void {
  envRows.value = envRows.value.filter((row) => row.id !== id);
  commitEnv();
}

function applyPreset(value: string): void {
  if (typeof value === 'string' && value.length > 0) {
    props.draft.schedule = value;
  }
}

function submit(): void {
  submitted.value = true;
  if (hasErrors.value || Object.keys(envRowErrors.value).length > 0) return;
  emit('submit');
}
</script>

<template>
  <div class="task-form">
    <n-card size="small" title="基本信息">
      <div class="two">
        <n-form-item label="任务名称" required :feedback="submitted ? errors.name : undefined">
          <n-input v-model:value="props.draft.name" maxlength="120" placeholder="例如：每日备份" />
        </n-form-item>
        <n-form-item label="启用状态">
          <n-switch v-model:value="props.draft.enabled" />
          <span class="small muted" style="margin-left: 8px">{{ props.draft.enabled ? '已启用' : '已禁用' }}</span>
        </n-form-item>
      </div>
      <n-form-item label="描述" :feedback="submitted ? errors.description : undefined">
        <n-input
          v-model:value="props.draft.description"
          type="textarea"
          :rows="2"
          maxlength="2000"
          placeholder="可选，说明任务用途"
        />
      </n-form-item>
    </n-card>

    <n-card size="small" title="Cron 计划">
      <div class="two">
        <n-form-item label="cron 表达式" required :feedback="errors.schedule">
          <n-input v-model:value="props.draft.schedule" class="mono" placeholder="0 3 * * *">
            <template #prefix>cron</template>
          </n-input>
        </n-form-item>
        <n-form-item label="常用预设">
          <n-select placeholder="选择预设…" :options="CRON_PRESETS.map((p) => ({ label: `${p.label} · ${p.value}`, value: p.value }))" @update:value="applyPreset" />
        </n-form-item>
      </div>
      <div class="cron-info">
        <span class="small" :class="cronCheck.valid ? 'ok-text' : 'error-text'">
          {{ cronCheck.valid ? cronCheck.description : (cronCheck.error ?? '无效表达式') }}
        </span>
        <span v-if="cronCheck.advanced" class="tiny muted">（包含秒字段）</span>
      </div>
      <n-form-item label="时区" :feedback="submitted ? errors.timezone : undefined">
        <n-input v-model:value="props.draft.timezone" placeholder="Asia/Shanghai（留空使用服务端默认）" />
      </n-form-item>
      <div v-if="nextRuns.length > 0" class="next-runs">
        <span class="tiny muted">未来运行（浏览器本地时区预览）：</span>
        <div class="runs">
          <span v-for="run in nextRuns" :key="run.toISOString()" class="run">
            {{ formatDate(run.toISOString()) }}
            <span class="tiny muted">{{ formatRelativeTime(run) }}</span>
          </span>
        </div>
      </div>
    </n-card>

    <n-card size="small" title="执行命令">
      <n-form-item label="命令" required :feedback="submitted ? errors.command : undefined">
        <n-input
          v-model:value="props.draft.command"
          type="textarea"
          :rows="5"
          class="mono"
          placeholder="例如：/usr/local/bin/backup.sh --daily"
        />
      </n-form-item>
      <p class="tiny muted" style="margin: -8px 0 8px">
        命令由服务器的 shell 执行（POSIX sh -c / PowerShell），面板凭据会在运行时被移除。
      </p>
      <div class="two">
        <n-form-item label="工作目录" :feedback="submitted ? errors.cwd : undefined">
          <n-input v-model:value="props.draft.cwd" class="mono" placeholder="/opt/app（留空使用服务器默认）" />
        </n-form-item>
        <n-form-item label="超时（秒）" :feedback="submitted ? errors.timeoutSec : undefined">
          <n-input-number
            v-model:value="props.draft.timeoutSec"
            :min="1"
            :max="86400"
            clearable
            placeholder="服务端默认 300"
            style="width: 100%"
          />
        </n-form-item>
      </div>
      <n-form-item label="并发策略">
        <n-select
          v-model:value="props.draft.overlap"
          :options="[
            { label: 'skip · 上次未结束则跳过', value: 'skip' },
            { label: 'allow · 允许并发', value: 'allow' },
          ]"
        />
      </n-form-item>
    </n-card>

    <n-card size="small" title="环境变量">
      <div v-for="row in envRows" :key="row.id" class="env-row">
        <n-input v-model:value="row.key" placeholder="KEY" class="mono" style="width: 34%" @update:value="commitEnv" />
        <n-input v-model:value="row.value" placeholder="VALUE" class="mono" @update:value="commitEnv" />
        <n-button quaternary title="删除变量" @click="removeEnvRow(row.id)">
          <template #icon><n-icon :component="TrashOutline" /></template>
        </n-button>
        <span v-if="envRowErrors[row.id]" class="tiny error-text">{{ envRowErrors[row.id] }}</span>
      </div>
      <n-button quaternary size="small" @click="addEnvRow">
        <template #icon><n-icon :component="AddOutline" /></template>
        添加变量
      </n-button>
      <n-alert v-if="submitted && errors.env" type="error" :bordered="false" style="margin-top: 8px">
        {{ errors.env }}
      </n-alert>
    </n-card>

    <div class="footer">
      <n-button v-if="showCancel" quaternary :disabled="submitting" @click="emit('cancel')">取消</n-button>
      <div class="spacer" />
      <n-button type="primary" :loading="submitting" @click="submit">{{ submitLabel }}</n-button>
    </div>
  </div>
</template>

<style scoped>
.task-form {
  display: flex;
  flex-direction: column;
  gap: 12px;
}
.two {
  display: grid;
  grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
  gap: 0 12px;
}
@media (max-width: 720px) {
  .two {
    grid-template-columns: 1fr;
  }
}
.cron-info {
  margin: -8px 0 8px;
  display: flex;
  gap: 6px;
  flex-wrap: wrap;
}
.ok-text {
  color: var(--mpanel-success);
}
.error-text {
  color: var(--mpanel-danger);
  font-weight: 600;
}
.next-runs {
  display: flex;
  flex-direction: column;
  gap: 4px;
  padding: 8px 10px;
  border-radius: 8px;
  background: var(--mpanel-surface-soft);
  margin-bottom: 10px;
}
.runs {
  display: flex;
  flex-wrap: wrap;
  gap: 4px 12px;
}
.run {
  font-size: 12px;
}
.env-row {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-wrap: wrap;
  margin-bottom: 6px;
}
.env-row > :nth-child(2) {
  flex: 1;
}
.footer {
  display: flex;
  align-items: center;
  gap: 8px;
  padding-top: 4px;
}
.footer .spacer {
  flex: 1;
}
</style>
