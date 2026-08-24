import { describe, expect, it } from 'vitest';
import type { Folder } from '../stores/folders';
import { getParentFolderId } from './folder-navigation';

const folder = (id: string, parentId: string | null, children: Folder[] = []): Folder => ({
  id,
  name: id,
  ownerId: 'owner',
  parentId,
  isDeleted: false,
  createdAt: '',
  updatedAt: '',
  children,
});

describe('getParentFolderId', () => {
  it('returns the parent from the loaded tree', () => {
    const tree = [folder('a', null, [folder('b', 'a')])];
    expect(getParentFolderId(tree, 'b')).toBe('a');
    expect(getParentFolderId(tree, 'a')).toBeNull();
    expect(getParentFolderId(tree, null)).toBeNull();
  });

  it('uses the current breadcrumb node when the tree is incomplete', () => {
    expect(getParentFolderId([], 'deep', { id: 'deep', parentId: 'middle' })).toBe('middle');
    expect(getParentFolderId([], 'deep', { id: 'other', parentId: 'middle' })).toBeNull();
  });
});
