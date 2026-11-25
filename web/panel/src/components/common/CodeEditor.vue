<script setup lang="ts">
import { computed } from 'vue';
import { Codemirror } from 'vue-codemirror';
import { json } from '@codemirror/lang-json';
import { sql } from '@codemirror/lang-sql';
import { oneDark } from '@codemirror/theme-one-dark';
import type { Extension } from '@codemirror/state';
import { useTheme } from '@/lib/theme';

const props = withDefaults(
  defineProps<{
    modelValue: string;
    language?: 'json' | 'sql' | 'text';
    readonly?: boolean;
    height?: string;
    placeholder?: string;
  }>(),
  { language: 'text', readonly: false, height: '320px', placeholder: '' },
);

const emit = defineEmits<{ 'update:modelValue': [value: string] }>();
const { isDark } = useTheme();

const extensions = computed<Extension[]>(() => {
  const list: Extension[] = [];
  if (props.language === 'json') list.push(json());
  if (props.language === 'sql') list.push(sql());
  if (isDark.value) list.push(oneDark);
  return list;
});

const value = computed({
  get: () => props.modelValue,
  set: (next: string) => emit('update:modelValue', next),
});
</script>

<template>
  <codemirror
    v-model="value"
    :extensions="extensions"
    :disabled="readonly"
    :placeholder="placeholder"
    :indent-with-tab="true"
    :tab-size="2"
    :style="{ height }"
  />
</template>
