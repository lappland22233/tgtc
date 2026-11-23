import type { InjectionKey, Ref } from 'vue';

interface WorkspaceTransferPlacement {
  target: Ref<HTMLElement | null>;
  visible: Ref<boolean>;
}

export const WORKSPACE_TRANSFERS: InjectionKey<WorkspaceTransferPlacement> = Symbol('workspace transfers');
