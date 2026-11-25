<script setup lang="ts">
import { computed, onUnmounted, ref, watch } from 'vue';
import { toolImageUrl } from '../api';
import { t } from '../i18n';
import type { ToolImageRef } from '../types';
import { ansiToHtml, isEditTool, presentTool } from '../utils';
import Icon from './Icon.vue';

const props = defineProps<{
  name: string;
  input: Record<string, unknown>;
  result?: { content: string; isError?: boolean; images?: ToolImageRef[] };
  parentToolUseId?: string | null;
  sessionId?: string;
}>();

const presentation = computed(() => presentTool(props.name, props.input));
const isBash = computed(() => ['bash', 'shell', 'exec'].includes(props.name.toLowerCase()));
const open = ref(isEditTool(props.name) || !!props.result?.isError);
const copied = ref(false);
const showRaw = ref(false);
const previewImage = ref<ToolImageRef | null>(null);

const diffLines = computed(() => presentation.value.diff?.slice(0, 400) ?? []);
const diffTruncated = computed(() => (presentation.value.diff?.length ?? 0) > 400);

const resultContent = computed(() => props.result?.content ?? '');
const toolImages = computed(() => props.result?.images ?? []);
/**
 * The text placeholder exists only so older transcripts still say something
 * where an image was. When real image descriptors are present, hide it and
 * let the thumbnails carry the output instead.
 */
const textResult = computed(() => {
  if (toolImages.value.length === 0) return resultContent.value;
  return resultContent.value.replace(/\[图片\]\s*/g, '').trim();
});
const hasResult = computed(() => !!resultContent.value || toolImages.value.length > 0);
const resultTruncated = computed(() => textResult.value.length > 30_000);
const displayResult = computed(() =>
  resultTruncated.value
    ? `${textResult.value.slice(0, 30_000)}\n\n${t('… 其余内容已省略，可复制完整输出')}`
    : textResult.value,
);
const resultHtml = computed(() => (isBash.value ? ansiToHtml(displayResult.value) : ''));

function imageUrl(image: ToolImageRef): string {
  return props.sessionId ? toolImageUrl(props.sessionId, image.id) : '';
}

function openPreview(image: ToolImageRef): void {
  if (!props.sessionId) return;
  previewImage.value = image;
}

function closePreview(): void {
  previewImage.value = null;
}

function onKeydown(event: KeyboardEvent): void {
  if (event.key === 'Escape' && previewImage.value) {
    event.preventDefault();
    closePreview();
  }
}

// Register the global Escape listener only while this card actually has an
// open preview; long sessions can render hundreds of tool cards.
watch(previewImage, (value) => {
  if (value) window.addEventListener('keydown', onKeydown);
  else window.removeEventListener('keydown', onKeydown);
});
onUnmounted(() => window.removeEventListener('keydown', onKeydown));

function plainOutput(): string {
  // A text/plain tab should not show raw terminal colour escapes.
  return isBash.value
    ? textResult.value.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '')
    : textResult.value;
}

function openOutputInNewTab(): void {
  if (!textResult.value) return;
  const blob = new Blob([plainOutput()], { type: 'text/plain;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.target = '_blank';
  anchor.rel = 'noopener noreferrer';
  anchor.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

function iconName(): string {
  const name = props.name.toLowerCase();
  if (['bash', 'shell', 'exec'].includes(name)) return 'terminal';
  if (['read', 'write', 'edit', 'multiedit'].includes(name)) return 'file';
  if (['glob', 'grep'].includes(name)) return 'search';
  if (['webfetch', 'web_fetch', 'websearch', 'web_search'].includes(name)) return 'globe';
  if (['task', 'agent'].includes(name)) return 'spark';
  if (['todowrite', 'todo_write'].includes(name)) return 'list';
  if (name === 'askuserquestion') return 'info';
  return 'code';
}

async function copy(value: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(value);
    copied.value = true;
    window.setTimeout(() => (copied.value = false), 1400);
  } catch {
    copied.value = false;
  }
}
</script>

<template>
  <div class="tool-card" :class="{ error: result?.isError, sub: !!parentToolUseId }">
    <button class="tool-head" type="button" @click="open = !open">
      <span class="tool-icon"><Icon :name="iconName()" :size="15" /></span>
      <span class="tool-label">{{ presentation.label }}</span>
      <span class="tool-summary">{{ presentation.summary }}</span>
      <span class="tool-state">
        <span v-if="!result" class="spinner tiny" />
        <Icon v-else-if="result.isError" name="alert" :size="15" class="state-error" />
        <Icon v-else name="check" :size="15" class="state-ok" />
      </span>
      <Icon class="tool-chevron" :name="open ? 'chevronUp' : 'chevronDown'" :size="14" />
    </button>

    <div v-if="open" class="tool-body">
      <div v-if="presentation.command" class="tool-command">
        <span class="command-prompt">$</span>
        <pre>{{ presentation.command }}</pre>
        <button class="icon-btn tiny" :title="t('复制命令')" @click="copy(presentation.command)">
          <Icon :name="copied ? 'check' : 'copy'" :size="14" />
        </button>
      </div>

      <div v-if="presentation.diff" class="diff-view">
        <div
          v-for="(line, index) in diffLines"
          :key="index"
          class="diff-line"
          :class="line.kind"
        >
          <span class="diff-sign">{{ line.kind === 'add' ? '+' : line.kind === 'del' ? '-' : ' ' }}</span>
          <span class="diff-text">{{ line.text }}</span>
        </div>
        <div v-if="diffLines.length === 0" class="diff-empty">{{ t('没有内容变化') }}</div>
        <div v-if="diffTruncated" class="diff-more">{{ t('仅显示前 400 行') }}</div>
      </div>

      <div v-else-if="presentation.todos" class="todo-list">
        <div v-for="(todo, index) in presentation.todos" :key="index" class="todo-row">
          <span class="todo-box" :class="todo.status" />
          <span :class="{ done: todo.status === 'completed' }">{{ todo.content }}</span>
        </div>
      </div>

      <div v-else-if="presentation.questions" class="question-list">
        <div v-for="(item, index) in presentation.questions" :key="index" class="question-row">
          <p>{{ item.question }}</p>
          <ul v-if="item.options?.length">
            <li v-for="(option, optionIndex) in item.options" :key="optionIndex">
              <strong>{{ option.label }}</strong>
              <span v-if="option.description">{{ option.description }}</span>
            </li>
          </ul>
        </div>
      </div>

      <div v-else-if="presentation.json && !resultContent" class="tool-json">
        <button class="raw-toggle" @click="showRaw = !showRaw">
          {{ showRaw ? t('收起参数') : t('查看参数') }}
        </button>
        <pre v-if="showRaw">{{ presentation.json }}</pre>
      </div>

      <div v-if="hasResult" class="tool-result">
        <div class="result-head">
          <span>{{ t('输出') }}</span>
          <div class="result-actions">
            <button v-if="textResult" class="raw-toggle" @click="openOutputInNewTab">
              <Icon name="external" :size="13" />
              {{ t('在新标签打开') }}
            </button>
            <button class="raw-toggle" @click="copy(resultContent)">
              <Icon :name="copied ? 'check' : 'copy'" :size="13" />
              {{ copied ? t('已复制') : t('复制') }}
            </button>
          </div>
        </div>
        <div v-if="toolImages.length" class="tool-images">
          <button
            v-for="image in toolImages"
            :key="image.id"
            type="button"
            class="tool-image-thumb"
            :title="t('点击预览图片')"
            @click="openPreview(image)"
          >
            <img
              v-if="imageUrl(image)"
              :src="imageUrl(image)"
              :alt="image.name"
              loading="lazy"
            />
          </button>
        </div>
        <pre v-if="textResult && isBash" class="tool-output ansi" v-html="resultHtml" />
        <pre v-else-if="textResult" class="tool-output">{{ displayResult }}</pre>
      </div>

      <div v-if="!hasResult && presentation.command && !presentation.diff" class="tool-pending">
        {{ t('等待执行结果…') }}
      </div>
    </div>

    <Teleport to="body">
      <div
        v-if="previewImage && imageUrl(previewImage)"
        class="image-lightbox"
        role="dialog"
        aria-modal="true"
        :aria-label="t('图片预览')"
        @click.self="closePreview"
      >
        <div class="image-lightbox-card" @click.stop>
          <div class="image-lightbox-head">
            <span class="image-lightbox-title">{{ previewImage.name }}</span>
            <div class="image-lightbox-actions">
              <a
                class="raw-toggle"
                :href="imageUrl(previewImage)"
                target="_blank"
                rel="noopener noreferrer"
              >
                <Icon name="external" :size="13" />
                {{ t('在新标签打开') }}
              </a>
              <button class="icon-btn tiny" :title="t('关闭预览')" @click="closePreview">
                <Icon name="x" :size="15" />
              </button>
            </div>
          </div>
          <img
            class="image-lightbox-img"
            :src="imageUrl(previewImage)"
            :alt="previewImage.name"
          />
        </div>
      </div>
    </Teleport>
  </div>
</template>
