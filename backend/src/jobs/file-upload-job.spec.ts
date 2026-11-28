import { readFileSync, readdirSync, statSync } from 'fs';
import { join } from 'path';
import { fileUploadJobId, fileUploadAdmissionJobId, FILE_UPLOAD_JOB_OPTIONS } from './file-upload-job';

/**
 * A-17 静态守卫：jobId 是幂等与取消的唯一键，格式必须只有一处定义。
 *
 * 事故形态：格式在多个文件手写时，任一处改动会让 abort / 僵尸恢复 / 回执恢复
 * 按旧格式 getJob 找不到任务，于是误判「已被 Worker 接管」——既不取消也不恢复，
 * 且不会报错（静默失效）。
 */
const SRC = join(__dirname, '..');

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) out.push(...walk(full));
    else if (name.endsWith('.ts') && !name.endsWith('.spec.ts')) out.push(full);
  }
  return out;
}

describe('file-upload jobId 单一事实来源（A-17）', () => {
  it('基础与派生 jobId 格式稳定', () => {
    expect(fileUploadJobId('f1', 2)).toBe('file-upload:f1:2');
    expect(fileUploadAdmissionJobId('f1', 2, 3)).toBe('file-upload:f1:2:admission:3');
    expect(fileUploadAdmissionJobId('f1', 2, 3).startsWith(fileUploadJobId('f1', 2))).toBe(true);
  });

  it('统一重试策略常量保持不变', () => {
    expect(FILE_UPLOAD_JOB_OPTIONS).toEqual({
      attempts: 3,
      backoff: { type: 'exponential', delay: 10000 },
      removeOnComplete: 100,
      removeOnFail: 50,
    });
  });

  it('除本模块外，任何源码不得再手写 file-upload jobId 模板', () => {
    const offenders = walk(SRC)
      .filter((file) => !file.endsWith('file-upload-job.ts'))
      .filter((file) => /file-upload:\$\{/.test(readFileSync(file, 'utf8')))
      .map((file) => file.slice(SRC.length + 1));
    expect(offenders).toEqual([]);
  });
});