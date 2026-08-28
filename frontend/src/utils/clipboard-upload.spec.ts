import { describe, expect, it } from 'vitest';
import { extractPastedMediaFiles } from './clipboard-upload';

describe('extractPastedMediaFiles', () => {
  it('仅提取图片和视频，忽略文本及其他文件', () => {
    const image = new File(['image'], 'image.png', { type: 'image/png' });
    const video = new File(['video'], 'video.mp4', { type: 'video/mp4' });
    const text = new File(['text'], 'note.txt', { type: 'text/plain' });
    const binary = new File(['binary'], 'archive.zip', { type: 'application/zip' });

    expect(extractPastedMediaFiles([image, text, video, binary])).toEqual([image, video]);
  });

  it('没有媒体文件时返回空数组', () => {
    expect(extractPastedMediaFiles([new File(['text'], 'note.txt', { type: 'text/plain' })])).toEqual([]);
  });
});
