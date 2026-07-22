import { ref, computed } from 'vue';

/**
 * 文件剪贴板（模块级单例）。
 *
 * 用于右键菜单的「复制 / 粘贴」：复制把文件 ID 放入剪贴板，
 * 粘贴时调用后端复制接口在目标文件夹生成真正的文件副本。
 * 使用模块级 ref 而非组件状态，保证在列表刷新、弹窗开合之间保持。
 */
const copiedFileIds = ref<string[]>([]);

export function useFileClipboard() {
  /** 复制（可多个），替换剪贴板内容 */
  function copyFiles(fileIds: string[]) {
    copiedFileIds.value = [...fileIds];
  }

  /** 清空剪贴板 */
  function clearClipboard() {
    copiedFileIds.value = [];
  }

  /** 剪贴板是否为空（用于禁用「粘贴」菜单项） */
  const hasCopiedFiles = computed(() => copiedFileIds.value.length > 0);

  return {
    copiedFileIds,
    hasCopiedFiles,
    copyFiles,
    clearClipboard,
  };
}
