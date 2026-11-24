<script setup lang="ts">
import { computed, ref } from 'vue';
import { t } from '../i18n';
import { ansiToHtml, isEditTool, presentTool } from '../utils';
import Icon from './Icon.vue';

const props = defineProps<{
  name: string;
  input: Record<string, unknown>;
  result?: { content: string; isError?: boolean };
  parentToolUseId?: string | null;
}>();

const presentation = computed(() => presentTool(props.name, props.input));
const isBash = computed(() => ['bash', 'shell', 'exec'].includes(props.name.toLowerCase()));
const open = ref(isEditTool(props.name) || !!props.result?.isError);
const copied = ref(false);
const showRaw = ref(false);

const diffLines = computed(() => presentation.value.diff?.slice(0, 400) ?? []);
const diffTruncated = computed(() => (presentation.value.diff?.length ?? 0) > 400);

const resultContent = computed(() => props.result?.content ?? '');
const resultTruncated = computed(() => resultContent.value.length > 30_000);
const displayResult = computed(() =>
  resultTruncated.value
    ? `${resultContent.value.slice(0, 30_000)}\n\n${t('… 其余内容已省略，可复制完整输出')}`
    : resultContent.value,
);
const resultHtml = computed(() => (isBash.value ? ansiToHtml(displayResult.value) : ''));

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

      <div v-if="resultContent" class="tool-result">
        <div class="result-head">
          <span>{{ t('输出') }}</span>
          <button class="raw-toggle" @click="copy(resultContent)">
            <Icon :name="copied ? 'check' : 'copy'" :size="13" />
            {{ copied ? t('已复制') : t('复制') }}
          </button>
        </div>
        <pre v-if="isBash" class="tool-output ansi" v-html="resultHtml" />
        <pre v-else class="tool-output">{{ displayResult }}</pre>
      </div>

      <div v-if="!resultContent && presentation.command && !presentation.diff" class="tool-pending">
        {{ t('等待执行结果…') }}
      </div>
    </div>
  </div>
</template>
