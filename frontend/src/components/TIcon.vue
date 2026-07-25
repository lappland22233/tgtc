<script setup lang="ts">
/**
 * 通用图标组件 TIcon —— 修复 <t-icon name="..."> 无法渲染的问题。
 *
 * 背景：unplugin-vue-components 的 TDesignResolver 会把模板里的 <t-icon>
 * 解析成 tdesign-vue-next 导出的 `Icon`，而该导出实际是"Icon"这个具体图标
 * （指针图形），并不接受 name 属性，导致所有 <t-icon name="x"> 都渲染错误。
 *
 * 方案：在 vite.config.ts 中把 TIcon 从 TDesignResolver 排除，改为全局注册
 * 本组件；本组件按 name（kebab-case）映射到 tdesign-icons-vue-next 的独立
 * 图标组件，仅打包实际用到的图标（保持 tree-shaking 生效）。
 *
 * 用法保持不变：<t-icon name="folder" /> / <t-icon name="upload" size="16px" />
 */
import { computed } from 'vue';
import type { Component } from 'vue';
import {
  AddIcon,
  CaretDownSmallIcon,
  CaretUpSmallIcon,
  ChevronRightIcon,
  DeleteIcon,
  DownloadIcon,
  EditIcon,
  ErrorCircleIcon,
  FileCopyIcon,
  FilePasteIcon,
  FolderAddIcon,
  FolderIcon,
  FolderMoveIcon,
  FolderOpenIcon,
  HomeIcon,
  LinkIcon,
  LockOffIcon,
  LockOnIcon,
  RefreshIcon,
  RollbackIcon,
  SearchIcon,
  ShareIcon,
  TagIcon,
  TimeIcon,
  UploadIcon,
  ViewListIcon,
} from 'tdesign-icons-vue-next';

/** kebab-case 图标名 → 图标组件 映射表（新增图标时在此登记） */
const iconMap: Record<string, Component> = {
  'add': AddIcon,
  'caret-down-small': CaretDownSmallIcon,
  'caret-up-small': CaretUpSmallIcon,
  'chevron-right': ChevronRightIcon,
  'copy': FileCopyIcon,
  'delete': DeleteIcon,
  'download': DownloadIcon,
  'edit': EditIcon,
  'error-circle': ErrorCircleIcon,
  'file-copy': FileCopyIcon,
  'file-paste': FilePasteIcon,
  'folder': FolderIcon,
  'folder-add': FolderAddIcon,
  'folder-move': FolderMoveIcon,
  'folder-open': FolderOpenIcon,
  'folder-opened': FolderOpenIcon,
  'home': HomeIcon,
  'link': LinkIcon,
  'lock-off': LockOffIcon,
  'lock-on': LockOnIcon,
  'paste': FilePasteIcon,
  'refresh': RefreshIcon,
  'rollback': RollbackIcon,
  'search': SearchIcon,
  'share': ShareIcon,
  'tag': TagIcon,
  'time': TimeIcon,
  'upload': UploadIcon,
  'view-list': ViewListIcon,
};

const props = defineProps<{
  /** 图标名（kebab-case），见 iconMap */
  name: string;
  /** 图标尺寸，如 "16px" / "1.2em"；不传则继承字号（SVG 默认 1em） */
  size?: string;
}>();

const iconComp = computed<Component | null>(() => iconMap[props.name] ?? null);
</script>

<template>
  <component :is="iconComp" v-if="iconComp" :size="size" />
</template>
