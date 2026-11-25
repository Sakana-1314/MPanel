<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';

const props = withDefaults(
  defineProps<{
    fontSize?: number;
    readonly?: boolean;
  }>(),
  { fontSize: 13, readonly: false },
);

const emit = defineEmits<{
  data: [data: string];
  resize: [size: { cols: number; rows: number }];
  ready: [];
}>();

const container = ref<HTMLDivElement | null>(null);
let terminal: Terminal | null = null;
let fitAddon: FitAddon | null = null;
let observer: ResizeObserver | null = null;

function fit(): void {
  if (terminal === null || fitAddon === null) return;
  try {
    fitAddon.fit();
    emit('resize', { cols: terminal.cols, rows: terminal.rows });
  } catch {
    // 容器不可见时 fit 可能失败，等下次 resize。
  }
}

function write(data: string): void {
  terminal?.write(data);
}

function writeln(data: string): void {
  terminal?.writeln(data);
}

function clear(): void {
  terminal?.clear();
}

function focus(): void {
  terminal?.focus();
}

onMounted(() => {
  const element = container.value;
  if (element === null) return;
  terminal = new Terminal({
    convertEol: true,
    cursorBlink: true,
    fontSize: props.fontSize,
    fontFamily: '"JetBrains Mono", "Cascadia Code", Consolas, monospace',
    scrollback: 5000,
    theme: {
      background: '#0b1120',
      foreground: '#dbe6ff',
      cursor: '#6f94ff',
    },
  });
  fitAddon = new FitAddon();
  terminal.loadAddon(fitAddon);
  terminal.open(element);
  fit();
  terminal.onData((data) => emit('data', data));
  terminal.onResize(({ cols, rows }) => emit('resize', { cols, rows }));
  observer = new ResizeObserver(() => fit());
  observer.observe(element);
  emit('ready');
});

onBeforeUnmount(() => {
  observer?.disconnect();
  observer = null;
  terminal?.dispose();
  terminal = null;
});

watch(
  () => props.fontSize,
  (size) => {
    if (terminal !== null) {
      terminal.options.fontSize = size;
      fit();
    }
  },
);

defineExpose({ write, writeln, clear, focus, fit });
</script>

<template>
  <div ref="container" class="xterm-host" />
</template>

<style scoped>
.xterm-host {
  width: 100%;
  height: 100%;
  min-height: 260px;
  padding: 8px;
  border-radius: 10px;
  background: #0b1120;
  overflow: hidden;
}
</style>
