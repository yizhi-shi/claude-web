<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue';
import { attachmentUrl } from '../api';
import type { AssistantItem, ChatItem } from '../chatModel';
import { formatClock, formatCost, formatDuration, renderMarkdown } from '../utils';
import Icon from './Icon.vue';
import ToolCard from './ToolCard.vue';

const props = defineProps<{ item: ChatItem; sessionId?: string }>();
const copied = ref(false);
const thinkingEl = ref<HTMLElement | null>(null);
let thinkingStick = true;

const assistant = computed(() =>
  props.item.kind === 'assistant' ? (props.item as AssistantItem) : null,
);
const assistantText = computed(() => {
  const item = assistant.value;
  if (!item) return '';
  const blocks = item.blocks.filter((block) => block.type === 'text').map((block) => block.text ?? '');
  return blocks.join('\n\n') || item.streamingText;
});
function onThinkingScroll(): void {
  const el = thinkingEl.value;
  if (!el) return;
  thinkingStick = el.scrollHeight - el.scrollTop - el.clientHeight < 32;
}

watch(
  () => assistant.value?.streamingThinking ?? '',
  async () => {
    await nextTick();
    const el = thinkingEl.value;
    if (el && thinkingStick) el.scrollTop = el.scrollHeight;
  },
  { immediate: true },
);

const displayedBlocks = computed(() => {
  const item = assistant.value;
  if (!item) return [];
  if (item.final) {
    return item.blocks.filter((block) => {
      if (block.type === 'thinking') return !!(block.thinking ?? '').trim();
      if (block.type === 'text') return !!(block.text ?? '').trim();
      return block.type === 'tool_use';
    });
  }
  const out = item.blocks.filter((block) => block.type === 'tool_use');
  return out;
});

async function copyText(): Promise<void> {
  const text = assistantText.value;
  if (!text) return;
  try {
    await navigator.clipboard.writeText(text);
    copied.value = true;
    window.setTimeout(() => (copied.value = false), 1400);
  } catch {
    copied.value = false;
  }
}
</script>

<template>
  <div v-if="item.kind === 'user'" class="msg msg-user">
    <div class="user-bubble">
      <div v-if="item.attachments?.length" class="user-attachments">
        <template v-for="attachment in item.attachments" :key="attachment.id">
          <a
            v-if="attachment.kind === 'image' && sessionId"
            :href="attachmentUrl(sessionId, attachment.id)"
            target="_blank"
            rel="noopener"
            class="user-attachment-image"
            :title="attachment.name"
          >
            <img
              :src="attachmentUrl(sessionId, attachment.id)"
              :alt="attachment.name"
              loading="lazy"
            />
          </a>
          <a
            v-else-if="sessionId"
            :href="attachmentUrl(sessionId, attachment.id)"
            target="_blank"
            rel="noopener"
            class="user-attachment-file"
            :title="attachment.name"
          >
            <Icon name="file" :size="14" />
            <span>{{ attachment.name }}</span>
          </a>
          <span v-else class="user-attachment-file">
            <Icon name="file" :size="14" />
            <span>{{ attachment.name }}</span>
          </span>
        </template>
      </div>
      <div v-if="item.text" class="user-bubble-text">{{ item.text }}</div>
      <div v-if="item.queued" class="user-msg-state queued">
        <Icon name="clock" :size="12" />
        <span>排队中，等待当前步骤结束</span>
      </div>
      <div v-else-if="item.failed" class="user-msg-state failed">
        <Icon name="alert" :size="12" />
        <span>未送达{{ item.failureReason ? `：${item.failureReason}` : '' }}</span>
      </div>
    </div>
    <span class="msg-time">{{ formatClock(item.ts) }}</span>
  </div>

  <div v-else-if="item.kind === 'assistant'" class="msg msg-assistant">
    <div class="assistant-head">
      <span class="assistant-avatar"><Icon name="brand" :size="20" /></span>
      <span class="assistant-name">Claude</span>
      <span v-if="item.model" class="assistant-model">{{ item.model }}</span>
      <span class="assistant-spacer" />
      <span class="msg-time">{{ formatClock(item.ts) }}</span>
      <button
        v-if="assistantText"
        class="icon-btn tiny copy-msg"
        :title="copied ? '已复制' : '复制回复'"
        @click="copyText"
      >
        <Icon :name="copied ? 'check' : 'copy'" :size="13" />
      </button>
    </div>

    <div class="assistant-body">
      <template v-if="!item.final">
        <details v-if="item.streamingThinking" class="thinking-block" open>
          <summary><Icon name="spark" :size="14" />思考过程</summary>
          <pre ref="thinkingEl" @scroll="onThinkingScroll">{{ item.streamingThinking }}</pre>
        </details>
        <div
          v-if="item.streamingText"
          class="msg-text markdown"
          v-html="renderMarkdown(item.streamingText)"
        />
        <ToolCard
          v-for="block in item.blocks.filter((b) => b.type === 'tool_use')"
          :key="String(block.id)"
          :name="String(block.name ?? 'tool')"
          :input="(block.input as Record<string, unknown>) ?? {}"
          :result="block.id ? item.toolResults.get(String(block.id)) : undefined"
        />
        <div
          v-if="
            !item.streamingText &&
            !item.streamingThinking &&
            !item.blocks.some((block) => block.type === 'tool_use')
          "
          class="typing-row"
        >
          <span class="spinner" />
          <span>正在思考…</span>
        </div>
      </template>

      <template v-else>
        <template v-for="(block, index) in displayedBlocks" :key="index">
          <details v-if="block.type === 'thinking'" class="thinking-block">
            <summary><Icon name="spark" :size="14" />思考过程</summary>
            <pre>{{ block.thinking }}</pre>
          </details>
          <div
            v-else-if="block.type === 'text'"
            class="msg-text markdown"
            v-html="renderMarkdown(block.text ?? '')"
          />
          <ToolCard
            v-else-if="block.type === 'tool_use'"
            :name="String(block.name ?? 'tool')"
            :input="(block.input as Record<string, unknown>) ?? {}"
            :result="block.id ? item.toolResults.get(String(block.id)) : undefined"
          />
        </template>
        <div v-if="displayedBlocks.length === 0 && assistantText" class="msg-text markdown" v-html="renderMarkdown(assistantText)" />
      </template>
    </div>
  </div>

  <div v-else-if="item.kind === 'notice'" class="notice-line" :class="item.level">
    <Icon :name="item.level === 'error' ? 'alert' : item.level === 'warn' ? 'alert' : 'info'" :size="14" />
    <span>{{ item.text }}</span>
  </div>

  <div v-else class="turn-line" :class="{ error: item.isError }">
    <Icon :name="item.isError ? 'alert' : 'check'" :size="13" />
    <span>{{ item.isError ? '回合结束（错误）' : '完成' }}</span>
    <span v-if="formatDuration(item.durationMs)">{{ formatDuration(item.durationMs) }}</span>
    <span v-if="formatCost(item.costUsd)">{{ formatCost(item.costUsd) }}</span>
  </div>
</template>
