// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mount, type VueWrapper } from '@vue/test-utils';
import { nextTick } from 'vue';
import Files from './Files.vue';
import * as adminFilesApi from '../../api/admin-files';
import type { FileVerifyTask } from '../../api/admin-files';
import MessagePlugin from '@/utils/message';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

vi.mock('../../api/admin-files', () => ({
  fetchAllAdminFiles: vi.fn(),
  createFileVerifyTask: vi.fn(),
  fetchActiveFileVerifyTask: vi.fn(),
  fetchFileVerifyTask: vi.fn(),
  cleanupStalePaths: vi.fn(),
}));

vi.mock('../../stores/auth', () => ({
  api: { get: vi.fn(), post: vi.fn(), delete: vi.fn() },
}));

vi.mock('@/utils/message', () => ({
  default: { success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() },
}));

vi.mock('../../composables/useMobile', async () => {
  const { ref } = await import('vue');
  return { useMobile: () => ref(false) };
});

vi.mock('../../composables/useCursorPagination', () => ({
  useCursorPagination: () => ({
    hasMore: { value: true },
    loading: { value: false },
    loadMore: vi.fn(async (fetchFn: (cursor: string | null, signal: AbortSignal) => Promise<unknown>) => {
      await fetchFn(null, new AbortController().signal);
    }),
    reset: vi.fn(),
  }),
}));

vi.mock('../../components/ThumbnailImg.vue', () => ({
  default: { name: 'ThumbnailImg', template: '<div class="thumbnail-img-stub" />' },
}));

// TDesign 组件按需 stub，仅保留体检流程所需的渲染与事件
vi.mock('tdesign-vue-next', () => {
  const Dialog = {
    name: 'TDialog',
    inheritAttrs: false,
    props: ['visible', 'header', 'confirmBtn', 'cancelBtn'],
    emits: ['update:visible', 'confirm', 'close'],
    template:
      '<div v-if="visible" class="t-dialog-stub">' +
      '<div class="t-dialog-header">{{ header }}</div>' +
      '<div class="t-dialog-body"><slot /></div>' +
      '<div v-if="confirmBtn" class="t-dialog-footer">' +
      '<button class="t-dialog-confirm" @click="$emit(\'confirm\')">{{ confirmBtn }}</button>' +
      '</div></div>',
  };
  const Button = {
    name: 'TButton',
    inheritAttrs: false,
    props: ['loading', 'disabled'],
    emits: ['click'],
    template:
      '<button class="t-button-stub" :disabled="loading || disabled" @click="$emit(\'click\')"><slot /></button>',
  };
  const Progress = {
    name: 'TProgress',
    inheritAttrs: false,
    props: ['percentage', 'label'],
    template: '<div class="t-progress-stub">{{ percentage }}</div>',
  };
  const Input = { name: 'TInput', inheritAttrs: false, template: '<input class="t-input-stub" />' };
  const Select = { name: 'TSelect', inheritAttrs: false, template: '<div class="t-select-stub"><slot /></div>' };
  const Option = { name: 'TOption', inheritAttrs: false, template: '<div class="t-option-stub"><slot /></div>' };
  const Tag = { name: 'TTag', inheritAttrs: false, template: '<span class="t-tag-stub"><slot /></span>' };
  const Loading = { name: 'TLoading', inheritAttrs: false, template: '<div class="t-loading-stub" />' };
  const Table = { name: 'TTable', inheritAttrs: false, template: '<div class="t-table-stub" />' };
  const Pagination = { name: 'TPagination', inheritAttrs: false, props: ['current', 'total', 'pageSize'], emits: ['change'], template: '<div class="t-pagination-stub" />' };
  const Checkbox = {
    name: 'TCheckbox',
    inheritAttrs: false,
    props: ['checked', 'modelValue'],
    emits: ['change', 'update:checked', 'update:modelValue'],
    template:
      '<label class="t-checkbox-stub"><input type="checkbox" :checked="checked ?? modelValue" @change="$emit(\'change\', $event.target.checked)" /><slot /></label>',
  };
  return {
    DialogPlugin: { confirm: vi.fn(), alert: vi.fn(), info: vi.fn(), warning: vi.fn() },
    Dialog,
    Button,
    Progress,
    Input,
    Select,
    Option,
    Tag,
    Loading,
    Table,
    Pagination,
    Checkbox,
  };
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTask(overrides: Partial<FileVerifyTask> = {}): FileVerifyTask {
  return {
    taskId: 'task-1',
    status: 'queued',
    mode: 'dry-run',
    allReady: false,
    limit: 0,
    concurrency: 1,
    totalCandidates: 0,
    processed: 0,
    progress: 0,
    valid: 0,
    invalid: 0,
    emptyFileId: 0,
    temporaryFailure: 0,
    sizeMismatch: 0,
    backfilled: 0,
    markedError: 0,
    errorSummary: null,
    createdAt: '2024-01-01T00:00:00.000Z',
    startedAt: null,
    completedAt: null,
    ...overrides,
  };
}

/** 刷新微任务队列（配合 fake timers，避免使用内部依赖 setImmediate 的 flushPromises） */
async function flushMicrotasks() {
  await Promise.resolve();
  await Promise.resolve();
  await nextTick();
}

function findButton(wrapper: VueWrapper, text: string) {
  const btns = wrapper.findAll('button.t-button-stub');
  const btn = btns.find((b) => b.text().includes(text));
  if (!btn) throw new Error(`找不到按钮：${text}`);
  return btn;
}

function dialogHeaders(wrapper: VueWrapper): string[] {
  return wrapper.findAll('.t-dialog-header').map((h) => h.text());
}

class IntersectionObserverStub {
  root = null;
  rootMargin = '';
  thresholds: number[] = [];
  observe() {}
  unobserve() {}
  disconnect() {}
  takeRecords() {
    return [];
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Files.vue 文件体检（异步任务）', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    vi.stubGlobal('IntersectionObserver', IntersectionObserverStub);
    vi.mocked(adminFilesApi.fetchAllAdminFiles).mockResolvedValue({ files: [], total: 0 });
    vi.mocked(adminFilesApi.fetchActiveFileVerifyTask).mockResolvedValue(null);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('点击 dry-run 创建 → 立即调用 createFileVerifyTask，确认弹窗关闭，进度弹窗打开', async () => {
    vi.mocked(adminFilesApi.createFileVerifyTask).mockResolvedValue({
      task: makeTask({ status: 'running', taskId: 't1', processed: 1, totalCandidates: 10, progress: 10 }),
      isNewTask: true,
    });
    vi.mocked(adminFilesApi.fetchFileVerifyTask).mockResolvedValue(
      makeTask({ status: 'running', taskId: 't1', processed: 1, totalCandidates: 10, progress: 10 }),
    );

    const wrapper = mount(Files);
    await flushMicrotasks();

    await findButton(wrapper, '文件体检').trigger('click');
    await flushMicrotasks();
    // 确认弹窗打开，包含 dry-run 按钮
    expect(dialogHeaders(wrapper)).toContain('文件体检');
    expect(wrapper.text()).toContain('仅预览统计');

    await findButton(wrapper, 'dry-run').trigger('click');
    await flushMicrotasks();

    expect(adminFilesApi.createFileVerifyTask).toHaveBeenCalledWith({ mode: 'dry-run' });
    // 确认弹窗关闭、进度弹窗打开
    expect(wrapper.text()).not.toContain('仅预览统计');
    expect(dialogHeaders(wrapper)).toContain('文件体检进度');
    // 立即发起一次精确轮询
    expect(adminFilesApi.fetchFileVerifyTask).toHaveBeenCalledTimes(1);
  });

  it('创建返回 isNewTask=false → 提示"已有体检任务"，仍进入跟踪', async () => {
    vi.mocked(adminFilesApi.createFileVerifyTask).mockResolvedValue({
      task: makeTask({ status: 'running', taskId: 't1', processed: 2, totalCandidates: 10, progress: 20 }),
      isNewTask: false,
    });
    vi.mocked(adminFilesApi.fetchFileVerifyTask).mockResolvedValue(
      makeTask({ status: 'running', taskId: 't1', processed: 2, totalCandidates: 10, progress: 20 }),
    );

    const wrapper = mount(Files);
    await flushMicrotasks();

    await findButton(wrapper, '文件体检').trigger('click');
    await flushMicrotasks();
    await findButton(wrapper, 'dry-run').trigger('click');
    await flushMicrotasks();

    expect(MessagePlugin.info).toHaveBeenCalledWith('已有体检任务正在进行，将跟踪当前任务');
    // 仍进入进度跟踪
    expect(dialogHeaders(wrapper)).toContain('文件体检进度');
    expect(adminFilesApi.fetchFileVerifyTask).toHaveBeenCalled();
  });

  it('轮询返回 running 且 processed/totalCandidates 变化 → 进度文本更新', async () => {
    vi.mocked(adminFilesApi.createFileVerifyTask).mockResolvedValue({
      task: makeTask({ status: 'running', taskId: 't1', processed: 1, totalCandidates: 10, progress: 10 }),
      isNewTask: true,
    });
    vi.mocked(adminFilesApi.fetchFileVerifyTask)
      .mockResolvedValueOnce(makeTask({ status: 'running', taskId: 't1', processed: 1, totalCandidates: 10, progress: 10 }))
      .mockResolvedValue(makeTask({ status: 'running', taskId: 't1', processed: 5, totalCandidates: 10, progress: 50 }));

    const wrapper = mount(Files);
    await flushMicrotasks();

    await findButton(wrapper, '文件体检').trigger('click');
    await flushMicrotasks();
    await findButton(wrapper, 'dry-run').trigger('click');
    await flushMicrotasks();

    // 首次轮询：1 / 10，进度 10%
    expect(wrapper.text()).toContain('已处理：1 / 10');
    expect(wrapper.text()).toContain('10%');
    expect(adminFilesApi.fetchFileVerifyTask).toHaveBeenCalledTimes(1);

    // 推进 1500ms，第二次轮询：5 / 10，进度 50%
    await vi.advanceTimersByTimeAsync(1500);
    expect(wrapper.text()).toContain('已处理：5 / 10');
    expect(wrapper.text()).toContain('50%');
    expect(adminFilesApi.fetchFileVerifyTask).toHaveBeenCalledTimes(2);
  });

  it('轮询返回 completed → 停止轮询、结果弹窗展示统计，apply 时关闭后 refreshList', async () => {
    vi.mocked(adminFilesApi.createFileVerifyTask).mockResolvedValue({
      task: makeTask({ status: 'running', taskId: 't1', mode: 'apply', processed: 10, totalCandidates: 10, progress: 100 }),
      isNewTask: true,
    });
    const completed = makeTask({
      status: 'completed',
      taskId: 't1',
      mode: 'apply',
      processed: 10,
      totalCandidates: 10,
      progress: 100,
      valid: 8,
      invalid: 2,
      emptyFileId: 1,
      temporaryFailure: 0,
      sizeMismatch: 1,
      backfilled: 7,
      markedError: 1,
    });
    vi.mocked(adminFilesApi.fetchFileVerifyTask).mockResolvedValue(completed);

    const wrapper = mount(Files);
    await flushMicrotasks();

    const fetchAllCallsBefore = vi.mocked(adminFilesApi.fetchAllAdminFiles).mock.calls.length;

    await findButton(wrapper, '文件体检').trigger('click');
    await flushMicrotasks();
    await findButton(wrapper, 'apply').trigger('click');
    await flushMicrotasks();

    // 进度弹窗关闭，结果弹窗展示统计
    expect(dialogHeaders(wrapper)).not.toContain('文件体检进度');
    expect(dialogHeaders(wrapper)).toContain('体检完成（已应用修复）');
    expect(wrapper.text()).toContain('本次检查候选：10 个');
    expect(wrapper.text()).toContain('已回填路径：7');
    expect(wrapper.text()).toContain('已标记 error：1');

    // 终态后推进时间不再轮询
    await vi.advanceTimersByTimeAsync(3000);
    expect(adminFilesApi.fetchFileVerifyTask).toHaveBeenCalledTimes(1);

    // 关闭结果弹窗（apply）→ refreshList → 重新拉取文件列表
    const confirmBtn = wrapper.find('.t-dialog-confirm');
    expect(confirmBtn.exists()).toBe(true);
    await confirmBtn.trigger('click');
    await flushMicrotasks();
    expect(vi.mocked(adminFilesApi.fetchAllAdminFiles).mock.calls.length).toBeGreaterThan(fetchAllCallsBefore);
  });

  it('轮询返回 failed → 停止轮询、展示 errorSummary', async () => {
    vi.mocked(adminFilesApi.createFileVerifyTask).mockResolvedValue({
      task: makeTask({ status: 'running', taskId: 't1', processed: 3, totalCandidates: 10, progress: 30 }),
      isNewTask: true,
    });
    vi.mocked(adminFilesApi.fetchFileVerifyTask).mockResolvedValue(
      makeTask({ status: 'failed', taskId: 't1', errorSummary: 'Telegram 校验超时' }),
    );

    const wrapper = mount(Files);
    await flushMicrotasks();

    await findButton(wrapper, '文件体检').trigger('click');
    await flushMicrotasks();
    await findButton(wrapper, 'dry-run').trigger('click');
    await flushMicrotasks();

    expect(dialogHeaders(wrapper)).not.toContain('文件体检进度');
    expect(MessagePlugin.error).toHaveBeenCalledWith('Telegram 校验超时');

    await vi.advanceTimersByTimeAsync(3000);
    expect(adminFilesApi.fetchFileVerifyTask).toHaveBeenCalledTimes(1);
  });

  it('刷新（重新 mount）时存在活动任务 → 自动进入进度跟踪', async () => {
    vi.mocked(adminFilesApi.fetchActiveFileVerifyTask).mockResolvedValue(
      makeTask({ status: 'running', taskId: 't-active', processed: 3, totalCandidates: 10, progress: 30 }),
    );
    vi.mocked(adminFilesApi.fetchFileVerifyTask).mockResolvedValue(
      makeTask({ status: 'running', taskId: 't-active', processed: 3, totalCandidates: 10, progress: 30 }),
    );

    const wrapper = mount(Files);
    await flushMicrotasks();

    expect(dialogHeaders(wrapper)).toContain('文件体检进度');
    expect(wrapper.text()).toContain('已处理：3 / 10');
    expect(adminFilesApi.fetchFileVerifyTask).toHaveBeenCalledWith('t-active', expect.any(AbortSignal));
  });

  it('unmount 后不再发起轮询请求', async () => {
    vi.mocked(adminFilesApi.createFileVerifyTask).mockResolvedValue({
      task: makeTask({ status: 'running', taskId: 't1', processed: 1, totalCandidates: 10, progress: 10 }),
      isNewTask: true,
    });
    vi.mocked(adminFilesApi.fetchFileVerifyTask).mockResolvedValue(
      makeTask({ status: 'running', taskId: 't1', processed: 1, totalCandidates: 10, progress: 10 }),
    );

    const wrapper = mount(Files);
    await flushMicrotasks();

    await findButton(wrapper, '文件体检').trigger('click');
    await flushMicrotasks();
    await findButton(wrapper, 'dry-run').trigger('click');
    await flushMicrotasks();

    const callsBefore = vi.mocked(adminFilesApi.fetchFileVerifyTask).mock.calls.length;
    expect(callsBefore).toBeGreaterThan(0);

    wrapper.unmount();
    await vi.advanceTimersByTimeAsync(3000);
    expect(vi.mocked(adminFilesApi.fetchFileVerifyTask).mock.calls.length).toBe(callsBefore);
  });
});

describe('Files.vue 存量旧路径清理', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    vi.stubGlobal('IntersectionObserver', IntersectionObserverStub);
    vi.mocked(adminFilesApi.fetchAllAdminFiles).mockResolvedValue({ files: [], total: 0 });
    vi.mocked(adminFilesApi.fetchActiveFileVerifyTask).mockResolvedValue(null);
    vi.mocked(adminFilesApi.cleanupStalePaths).mockResolvedValue({ mode: 'dry-run', matched: 42, updated: 0 });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('点击"清理失效路径"打开确认弹窗，展示说明文字', async () => {
    const wrapper = mount(Files);
    await flushMicrotasks();

    await findButton(wrapper, '清理失效路径').trigger('click');
    await flushMicrotasks();

    expect(dialogHeaders(wrapper)).toContain('清理失效路径');
    expect(wrapper.text()).toContain('/data/cb/tgtc-beta/');
    expect(wrapper.text()).toContain('仅预览统计');
    expect(wrapper.text()).toContain('清空路径');
  });

  it('dry-run：调用 cleanupStalePaths(mode dry-run)，展示命中统计，不刷新列表', async () => {
    const wrapper = mount(Files);
    await flushMicrotasks();

    await findButton(wrapper, '清理失效路径').trigger('click');
    await flushMicrotasks();
    await findButton(wrapper, 'dry-run').trigger('click');
    await flushMicrotasks();

    expect(adminFilesApi.cleanupStalePaths).toHaveBeenCalledWith('dry-run');
    expect(dialogHeaders(wrapper)).toContain('预览统计');
    expect(wrapper.text()).toContain('dry-run：命中 42 条旧路径，将清空为 NULL（不修改状态）。');
    // dry-run 不刷新列表
    expect(vi.mocked(adminFilesApi.fetchAllAdminFiles).mock.calls.length).toBe(1);
  });

  it('apply：二次确认后调用 cleanupStalePaths(mode apply)，展示结果并刷新列表', async () => {
    // 二次确认弹窗自动确认：延迟到 confirmDialog 初始化后再触发 onConfirm
    const mockedDialog = await import('tdesign-vue-next');
    vi.mocked(mockedDialog.DialogPlugin.confirm).mockImplementation(((options: any) => {
      queueMicrotask(() => options.onConfirm?.());
      return { destroy: vi.fn() };
    }) as any);

    vi.mocked(adminFilesApi.cleanupStalePaths).mockResolvedValue({ mode: 'apply', matched: 100, updated: 100 });

    const wrapper = mount(Files);
    await flushMicrotasks();

    const fetchAllCallsBefore = vi.mocked(adminFilesApi.fetchAllAdminFiles).mock.calls.length;

    await findButton(wrapper, '清理失效路径').trigger('click');
    await flushMicrotasks();
    await findButton(wrapper, 'apply').trigger('click');
    await flushMicrotasks();

    expect(adminFilesApi.cleanupStalePaths).toHaveBeenCalledWith('apply');
    expect(dialogHeaders(wrapper)).toContain('清理完成');
    expect(wrapper.text()).toContain('apply：已清空 100 条旧路径。');

    // 关闭结果弹窗 → refreshList → 重新拉取文件列表
    const confirmBtn = wrapper.find('.t-dialog-confirm');
    expect(confirmBtn.exists()).toBe(true);
    await confirmBtn.trigger('click');
    await flushMicrotasks();
    expect(vi.mocked(adminFilesApi.fetchAllAdminFiles).mock.calls.length).toBeGreaterThan(fetchAllCallsBefore);
  });

  it('防重复提交：cleanupRunning 期间重复点击不重复请求', async () => {
    const wrapper = mount(Files);
    await flushMicrotasks();

    await findButton(wrapper, '清理失效路径').trigger('click');
    await flushMicrotasks();
    // 请求挂起（pending）期间再次点击
    let resolveFn: (v: any) => void = () => {};
    vi.mocked(adminFilesApi.cleanupStalePaths).mockReturnValueOnce(new Promise((resolve) => { resolveFn = resolve; }));
    await findButton(wrapper, 'dry-run').trigger('click');
    await flushMicrotasks();
    await findButton(wrapper, 'dry-run').trigger('click');
    await flushMicrotasks();
    resolveFn({ mode: 'dry-run', matched: 42, updated: 0 });
    await flushMicrotasks();

    expect(adminFilesApi.cleanupStalePaths).toHaveBeenCalledTimes(1);
  });
});
