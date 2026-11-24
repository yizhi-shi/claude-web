<script setup lang="ts">
import { computed, reactive, watch } from 'vue';
import type { PendingQuestionView, QuestionItem } from '../types';
import Icon from './Icon.vue';

const props = defineProps<{
  question: PendingQuestionView;
  busy?: boolean;
  timeoutMinutes?: number;
}>();

const emit = defineEmits<{
  submit: [answers: Record<string, string>];
  skip: [];
}>();

const selections = reactive<Record<string, string[]>>({});
const custom = reactive<Record<string, string>>({});

function reset(): void {
  for (const key of Object.keys(selections)) delete selections[key];
  for (const key of Object.keys(custom)) delete custom[key];
  for (const item of props.question.questions) {
    selections[item.question] = [];
    custom[item.question] = '';
  }
}

watch(() => props.question.requestId, reset, { immediate: true });

function selected(item: QuestionItem, label: string): boolean {
  return (selections[item.question] ?? []).includes(label);
}

function toggle(item: QuestionItem, label: string): void {
  if (props.busy) return;
  const current = selections[item.question] ?? [];
  if (item.multiSelect) {
    selections[item.question] = current.includes(label)
      ? current.filter((value) => value !== label)
      : [...current, label];
  } else {
    selections[item.question] = [label];
    custom[item.question] = '';
  }
}

function setCustom(item: QuestionItem, value: string): void {
  custom[item.question] = value;
  if (value.trim() && !item.multiSelect) selections[item.question] = [];
}

const complete = computed(() =>
  props.question.questions.every(
    (item) =>
      Boolean(custom[item.question]?.trim()) || (selections[item.question]?.length ?? 0) > 0,
  ),
);

function submit(): void {
  if (props.busy || !complete.value) return;
  const answers: Record<string, string> = {};
  for (const item of props.question.questions) {
    const typed = custom[item.question]?.trim();
    answers[item.question] = typed || (selections[item.question] ?? []).join(', ');
  }
  emit('submit', answers);
}
</script>

<template>
  <section class="permission-panel question-panel">
    <div class="permission-head">
      <span class="permission-icon question-icon"><Icon name="info" :size="18" /></span>
      <div class="permission-copy">
        <div class="permission-title">
          需要你的选择
          <span class="permission-tool">AskUserQuestion</span>
        </div>
        <p class="permission-desc">Claude 暂停在这里等待回答；也可以跳过，让它按最佳判断继续。</p>
      </div>
      <span class="permission-wait">任务已暂停</span>
    </div>

    <div class="question-list">
      <div v-for="item in question.questions" :key="item.question" class="question-block">
        <div class="question-head">
          <span class="question-chip">{{ item.header }}</span>
          <span v-if="item.multiSelect" class="question-multi">可多选</span>
        </div>
        <p class="question-text">{{ item.question }}</p>
        <div class="question-options" role="group" :aria-label="item.question">
          <button
            v-for="option in item.options"
            :key="option.label"
            type="button"
            class="question-option"
            :class="{ active: selected(item, option.label) }"
            :aria-pressed="selected(item, option.label)"
            :disabled="busy"
            @click="toggle(item, option.label)"
          >
            <span class="option-mark" :class="{ multi: item.multiSelect }">
              <Icon v-if="selected(item, option.label)" name="check" :size="12" />
            </span>
            <span class="option-copy">
              <span class="option-label">{{ option.label }}</span>
              <span v-if="option.description" class="option-desc">{{ option.description }}</span>
              <pre v-if="option.preview" class="option-preview">{{ option.preview }}</pre>
            </span>
          </button>
        </div>
        <label class="question-other">
          <span>其他答案（可选）</span>
          <input
            :value="custom[item.question]"
            type="text"
            placeholder="直接输入你的选择…"
            :disabled="busy"
            @input="setCustom(item, ($event.target as HTMLInputElement).value)"
          />
        </label>
      </div>
    </div>

    <div class="permission-foot">
      <p class="permission-note">
        回答会作为工具结果交给 Claude。超时 {{ timeoutMinutes ?? 30 }} 分钟将自动跳过。
      </p>
      <div class="permission-actions">
        <button class="btn ghost" :disabled="busy" @click="emit('skip')">跳过</button>
        <button class="btn primary" :disabled="busy || !complete" @click="submit">
          {{ busy ? '提交中…' : '提交回答' }}
        </button>
      </div>
    </div>
  </section>
</template>
