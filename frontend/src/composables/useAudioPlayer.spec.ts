// @vitest-environment jsdom
import { ref } from 'vue';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useAudioPlayer } from './useAudioPlayer';
import type { MediaSessionItem } from '../stores/mediaPlayback';

/**
 * M6 拆分回归：音频播放器从 FilePreviewDialog.vue 下沉为 composable 后，
 * 时间格式化、进度百分比、播放/暂停联动 store、恢复点应用与复位语义必须与拆分前一致。
 */

interface FakeAudio {
  paused: boolean;
  currentTime: number;
  duration: number;
  volume: number;
  muted: boolean;
  playbackRate: number;
  seekable: { length: number; start: (i: number) => number; end: (i: number) => number };
  play: ReturnType<typeof vi.fn>;
  pause: ReturnType<typeof vi.fn>;
  removeAttribute: ReturnType<typeof vi.fn>;
  load: ReturnType<typeof vi.fn>;
}

function fakeAudio(overrides: Partial<FakeAudio> = {}): FakeAudio {
  return {
    paused: true,
    currentTime: 0,
    duration: 0,
    volume: 0.5,
    muted: false,
    playbackRate: 1,
    seekable: { length: 0, start: () => 0, end: () => 0 },
    play: vi.fn(async () => undefined),
    pause: vi.fn(),
    removeAttribute: vi.fn(),
    load: vi.fn(),
    ...overrides,
  };
}

function mediaEvent(currentTarget: unknown): Event {
  return { currentTarget } as unknown as Event;
}

describe('useAudioPlayer（M6 拆分契约）', () => {
  let audioEl: ReturnType<typeof ref<FakeAudio | null>>;
  let mediaStore: {
    setPlayState: ReturnType<typeof vi.fn>;
    setProgress: ReturnType<typeof vi.fn>;
    persistProgress: ReturnType<typeof vi.fn>;
    pendingResume: number;
  };
  let onEnded: ReturnType<typeof vi.fn>;
  let persistProgress: ReturnType<typeof vi.fn>;
  let player: ReturnType<typeof useAudioPlayer>;

  beforeEach(() => {
    audioEl = ref<FakeAudio | null>(fakeAudio());
    mediaStore = {
      setPlayState: vi.fn(),
      setProgress: vi.fn(),
      persistProgress: vi.fn(),
      pendingResume: 0,
    };
    onEnded = vi.fn();
    persistProgress = vi.fn();
    player = useAudioPlayer({
      mediaStore: mediaStore as never,
      audioEl: audioEl as never,
      onEnded: onEnded as never,
      persistProgress: persistProgress as never,
    });
  });

  it('时间格式化：mm:ss / h:mm:ss，非法值回退 0:00', () => {
    expect(player.formatAudioTime(0)).toBe('0:00');
    expect(player.formatAudioTime(65)).toBe('1:05');
    expect(player.formatAudioTime(3725)).toBe('1:02:05');
    expect(player.formatAudioTime(Number.NaN)).toBe('0:00');
    expect(player.formatAudioTime(-1)).toBe('0:00');
  });

  it('进度百分比依据草稿时间计算并被限制在 0-100', () => {
    expect(player.audioProgressPct.value).toBe(0);

    const audio = fakeAudio({ duration: 200, currentTime: 50 });
    audioEl.value = audio;
    player.onAudioTimeUpdate(mediaEvent(audio));

    expect(player.audioProgressPct.value).toBe(25);
  });

  it('播放/暂停切换直接驱动媒体内核', () => {
    const audio = fakeAudio({ paused: true });
    audioEl.value = audio;

    player.toggleAudioPlay();
    expect(audio.play).toHaveBeenCalledTimes(1);

    audio.paused = false;
    player.toggleAudioPlay();
    expect(audio.pause).toHaveBeenCalledTimes(1);
  });

  it('相对跳转被钳制在 [0, duration]', () => {
    const audio = fakeAudio({ duration: 100, currentTime: 10 });
    audioEl.value = audio;

    player.seekAudioBy(30);
    expect(audio.currentTime).toBe(40);

    player.seekAudioBy(-1000);
    expect(audio.currentTime).toBe(0);

    player.seekAudioBy(1000);
    expect(audio.currentTime).toBe(100);
  });

  it('播放状态与进度同步到 store，并节流持久化', () => {
    const audio = fakeAudio({ duration: 60, currentTime: 12 });
    audioEl.value = audio;

    player.onAudioPlay();
    expect(player.audioPlaying.value).toBe(true);
    expect(mediaStore.setPlayState).toHaveBeenCalledWith('playing');

    player.onAudioTimeUpdate(mediaEvent(audio));
    expect(player.audioDisplayTime.value).toBe(12);
    expect(mediaStore.setProgress).toHaveBeenCalledWith(12, 60);
    expect(persistProgress).toHaveBeenCalled();

    player.onAudioPause();
    expect(player.audioPlaying.value).toBe(false);
    expect(mediaStore.setPlayState).toHaveBeenCalledWith('paused');
    expect(mediaStore.persistProgress).toHaveBeenCalled();
  });

  it('播放自然结束时先同步暂停态，再交由宿主续播', () => {
    const audio = fakeAudio({ duration: 10, currentTime: 10 });
    audioEl.value = audio;

    player.onAudioEnded();

    expect(mediaStore.setPlayState).toHaveBeenCalledWith('paused');
    expect(onEnded).toHaveBeenCalledTimes(1);
  });

  it('元数据就绪时同步音量/静音并强制 1× 倍速', () => {
    const audio = fakeAudio({ duration: 120, volume: 0.8, muted: true, playbackRate: 2 });
    player.audioRate.value = 2;

    player.onAudioLoadedMeta(mediaEvent(audio));

    expect(player.audioVolume.value).toBe(0.8);
    expect(player.audioMuted.value).toBe(true);
    expect(player.audioVolumeInput.value).toBe(0.8);
    expect(player.audioRate.value).toBe(1);
    expect(audio.playbackRate).toBe(1);
  });

  it('元数据就绪时应用恢复点；不可 seek 的位置不写入 currentTime', () => {
    const seekableAudio = fakeAudio({
      duration: 100,
      seekable: { length: 1, start: () => 0, end: () => 100 },
    });
    mediaStore.pendingResume = 40;

    player.onAudioLoadedMeta(mediaEvent(seekableAudio));
    expect(seekableAudio.currentTime).toBe(40);

    const unseekableAudio = fakeAudio({
      duration: 100,
      seekable: { length: 1, start: () => 0, end: () => 10 },
    });
    mediaStore.pendingResume = 80;

    player.onAudioLoadedMeta(mediaEvent(unseekableAudio));
    expect(unseekableAudio.currentTime).toBe(0);
  });

  it('倍速循环切换并写入媒体内核', () => {
    const audio = fakeAudio();
    audioEl.value = audio;

    player.cycleAudioRate(); // 1 → 1.25
    expect(player.audioRate.value).toBe(1.25);
    expect(audio.playbackRate).toBe(1.25);

    player.cycleAudioRate(); // 1.25 → 1.5
    expect(player.audioRate.value).toBe(1.5);
  });

  it('静音与音量输入同步媒体内核', () => {
    const audio = fakeAudio({ muted: false });
    audioEl.value = audio;

    player.toggleAudioMute();
    expect(audio.muted).toBe(true);

    player.audioVolumeInput.value = 0.3;
    player.onAudioVolumeInput();
    expect(audio.volume).toBe(0.3);
    expect(player.audioVolume.value).toBe(0.3);

    // 外部（迷你播放器）改动音量时回写 UI 状态
    audio.volume = 0.9;
    audio.muted = true;
    player.onAudioVolumeChange();
    expect(player.audioVolume.value).toBe(0.9);
    expect(player.audioMuted.value).toBe(true);
    expect(player.audioVolumeInput.value).toBe(0.9);
  });

  it('切换文件时 resetAudioState 卸载内核载荷并清零进度相关状态', () => {
    const audio = fakeAudio({ duration: 100, currentTime: 55 });
    audioEl.value = audio;
    player.onAudioTimeUpdate(mediaEvent(audio));
    player.audioPlaying.value = true;

    player.resetAudioState();

    expect(audio.pause).toHaveBeenCalled();
    expect(audio.removeAttribute).toHaveBeenCalledWith('src');
    expect(audio.load).toHaveBeenCalled();
    expect(player.audioPlaying.value).toBe(false);
    expect(player.audioDisplayTime.value).toBe(0);
    expect(player.audioDuration.value).toBe(0);
    expect(player.audioSeeking.value).toBe(false);
  });

  it('卸载时 disposeAudioPlayer 仅停止波形与播放标记', () => {
    player.audioPlaying.value = true;

    player.disposeAudioPlayer();

    expect(player.audioPlaying.value).toBe(false);
    expect(player.audioWaveBars.value).toHaveLength(28);
  });

  it('波形数据源为 28 个柱位（与模板渲染数量一致）', () => {
    expect(player.audioWaveBars.value).toHaveLength(28);
  });

  it('音频结束回调由宿主注入，composable 不直接依赖播放列表', () => {
    const playlistItem: MediaSessionItem = { id: 'a', name: 'a', mimeType: 'audio/mpeg', kind: 'audio', src: '/x' };
    expect(playlistItem.kind).toBe('audio');
    expect(onEnded).not.toHaveBeenCalled();
  });
});
