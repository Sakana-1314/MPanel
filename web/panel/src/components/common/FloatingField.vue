<script setup lang="ts">
import { computed, ref, useSlots } from 'vue';
import { NInput } from 'naive-ui';

const props = withDefaults(
  defineProps<{
    modelValue: string;
    label: string;
    type?: 'text' | 'password';
    autocomplete?: string;
    inputProps?: Record<string, unknown>;
    showPasswordOn?: 'click' | 'mousedown';
    disabled?: boolean;
    size?: 'small' | 'medium' | 'large';
  }>(),
  {
    type: 'text',
    autocomplete: 'off',
    inputProps: () => ({}),
    disabled: false,
    size: 'large',
  },
);

const emit = defineEmits<{
  'update:modelValue': [value: string];
  focus: [];
  blur: [];
}>();

const slots = useSlots();
const focused = ref(false);
const inputId = `mf-${Math.random().toString(36).slice(2, 9)}`;

const hasPrefix = computed(() => slots.prefix !== undefined);
const floating = computed(() => focused.value || props.modelValue.length > 0);
const mergedInputProps = computed(() => ({
  autocomplete: props.autocomplete,
  spellcheck: false,
  ...props.inputProps,
  id: inputId,
}));
</script>

<template>
  <div
    class="floating-field"
    :class="{ 'has-prefix': hasPrefix, 'is-floating': floating, 'is-focused': focused, 'is-disabled': disabled }"
  >
    <n-input
      :value="modelValue"
      :type="type"
      :size="size"
      :disabled="disabled"
      :show-password-on="showPasswordOn"
      :input-props="mergedInputProps"
      placeholder=""
      @update:value="emit('update:modelValue', $event)"
      @focus="focused = true; emit('focus')"
      @blur="focused = false; emit('blur')"
    >
      <template v-if="hasPrefix" #prefix><slot name="prefix" /></template>
      <template v-if="$slots.suffix" #suffix><slot name="suffix" /></template>
    </n-input>
    <label :for="inputId">{{ label }}</label>
  </div>
</template>

<style scoped>
.floating-field {
  position: relative;
  width: 100%;
}
.floating-field :deep(.n-input),
.floating-field :deep(.n-input-wrapper),
.floating-field :deep(.n-input__input-el) {
  height: 46px;
}
.floating-field label {
  position: absolute;
  top: 50%;
  left: 12px;
  z-index: 1;
  max-width: calc(100% - 24px);
  padding: 0 4px;
  border-radius: 4px;
  background: transparent;
  color: var(--mpanel-muted);
  font-size: 13px;
  line-height: 1.2;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  pointer-events: none;
  transform: translateY(-50%);
  transform-origin: left center;
  transition:
    top 0.16s ease,
    left 0.16s ease,
    transform 0.16s ease,
    color 0.16s ease,
    background-color 0.16s ease,
    font-size 0.16s ease;
}
.floating-field.has-prefix label {
  left: 38px;
}
.floating-field.is-floating label {
  top: 0;
  left: 10px;
  background: var(--mpanel-surface);
  font-size: 11px;
}
.floating-field.is-focused label {
  color: var(--mpanel-accent);
}
.floating-field.is-disabled label {
  opacity: 0.6;
}
</style>
