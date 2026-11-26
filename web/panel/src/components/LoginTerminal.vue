<script setup lang="ts">
import { onMounted, onUnmounted, ref } from 'vue';

const prompts = [
  '帮我把所有站点的证书检查一遍',
  '哪台服务器的磁盘快满了？',
  '把容器重启一下并检查日志',
  '汇总今天的备份结果',
  '看看最近一次计划任务的状态',
];

const display = ref('');
const index = ref(0);
const typing = ref(true);

let timer: ReturnType<typeof setTimeout> | null = null;
let stopped = false;

function schedule(fn: () => void, delay: number): void {
  timer = setTimeout(fn, delay);
}

function next(): void {
  index.value = (index.value + 1) % prompts.length;
  typeCurrent();
}

function typeCurrent(): void {
  if (stopped) return;
  const full = prompts[index.value] ?? '';
  let position = 0;
  display.value = '';
  typing.value = true;

  const step = (): void => {
    if (stopped) return;
    position += 1;
    display.value = full.slice(0, position);
    if (position < full.length) {
      schedule(step, 42 + Math.random() * 40);
      return;
    }
    typing.value = false;
    schedule(next, 2300);
  };

  schedule(step, 220);
}

onMounted(() => {
  const reduceMotion =
    typeof window.matchMedia === 'function' &&
    window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  if (reduceMotion) {
    display.value = prompts[0] ?? '';
    typing.value = false;
    const rotate = (): void => {
      index.value = (index.value + 1) % prompts.length;
      display.value = prompts[index.value] ?? '';
      schedule(rotate, 4000);
    };
    schedule(rotate, 4000);
    return;
  }

  typeCurrent();
});

onUnmounted(() => {
  stopped = true;
  if (timer !== null) clearTimeout(timer);
});
</script>

<template>
  <div class="terminal">
    <div class="terminal-head">
      <span class="lights">
        <i class="light red" />
        <i class="light yellow" />
        <i class="light green" />
      </span>
      <span class="terminal-title">MPanel Copilot · AI</span>
    </div>
    <div class="terminal-body">
      <span class="prompt">&gt;</span>
      <span class="typed">{{ display }}</span>
      <span class="caret" :class="{ steady: !typing }" />
    </div>
  </div>
</template>

<style scoped>
.terminal {
  width: min(100%, 460px);
  border: 1px solid rgb(255 255 255 / 10%);
  border-radius: 14px;
  background: rgb(8 13 22 / 62%);
  box-shadow:
    0 18px 44px rgb(0 0 0 / 28%),
    inset 0 1px 0 rgb(255 255 255 / 4%);
  backdrop-filter: blur(12px);
  overflow: hidden;
}
.terminal-head {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 10px 14px;
  border-bottom: 1px solid rgb(255 255 255 / 6%);
}
.lights {
  display: flex;
  align-items: center;
  gap: 5px;
}
.light {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  display: block;
}
.light.red {
  background: #ff5f57;
}
.light.yellow {
  background: #febc2e;
}
.light.green {
  background: #28c840;
}
.terminal-title {
  font-family: 'JetBrains Mono', 'Cascadia Code', Consolas, ui-monospace, monospace;
  font-size: 11.5px;
  letter-spacing: 0.02em;
  color: rgb(230 237 243 / 52%);
}
.terminal-body {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  min-height: 68px;
  padding: 16px;
  font-family: 'JetBrains Mono', 'Cascadia Code', Consolas, ui-monospace, monospace;
  font-size: 13px;
  line-height: 1.6;
  color: #c9d1d9;
}
.prompt {
  color: #79c0ff;
  flex: 0 0 auto;
}
.typed {
  white-space: pre-wrap;
  word-break: break-word;
}
.caret {
  width: 7px;
  height: 15px;
  margin-top: 3px;
  flex: 0 0 auto;
  background: #79c0ff;
  animation: blink 1.1s steps(2, start) infinite;
}
.caret.steady {
  animation-duration: 1.4s;
}
@keyframes blink {
  50% {
    opacity: 0;
  }
}
@media (prefers-reduced-motion: reduce) {
  .caret {
    animation: none;
    opacity: 0.7;
  }
}
</style>
