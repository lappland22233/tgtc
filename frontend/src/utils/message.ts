/**
 * Centralized MessagePlugin — imports from TDesign subpath
 * to bypass the full package entry and enable better tree-shaking.
 *
 * Usage (same API as direct import):
 *   import MessagePlugin from '@/utils/message';
 *   MessagePlugin.success('saved');
 */
import { MessagePlugin } from 'tdesign-vue-next/es/message';

export default MessagePlugin;
