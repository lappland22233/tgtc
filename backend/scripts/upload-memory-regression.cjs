#!/usr/bin/env node
/**
 * 上传内存回归压测工具（显式运行，不进入默认测试）。
 *
 * 用法（在 backend/ 目录下，需先 npm run build）：
 *   node scripts/upload-memory-regression.cjs --size-bytes 2000000000 --rounds 5 --concurrency 1
 *   node scripts/upload-memory-regression.cjs --size-bytes 2000000000 --rounds 3 --concurrency 2 --idle-seconds 120
 *
 * 架构（上传端与接收端分离进程）：
 *   父进程 ─┬─ fork --receiver   回环 HTTP 接收端（增量消费请求体，不做整包缓存）
 *           └─ fork --child      加载 dist 中的 TelegramService 真实上传，
 *                                按阶段采样 RSS/匿名页/swap/heap/external/FD，
 *                                结束后把报告 JSON 写入 --report 指定文件。
 *
 * 阶段：cold → warmup(16MiB) → round 1..N → idle（默认 120 秒静置观测）。
 * 指标（Linux 额外）：/proc/self/status 的 VmRSS、RssAnon、VmSwap 与 /proc/self/fd 计数。
 * 注意：arrayBuffers 已包含在 external 中，分析时禁止二者相加。
 */

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { fork } = require('child_process');

const SAMPLE_INTERVAL_MS = 1000;
const WARMUP_BYTES = 16 * 1024 * 1024;
const RECEIVER_FILE_ID = 'mem-regression';

function mb(bytes) {
  return Math.round((bytes / (1024 * 1024)) * 10) / 10;
}

function parseArgs(argv) {
  const args = { sizeBytes: 256 * 1024 * 1024, rounds: 5, concurrency: 1, idleSeconds: 120, report: '' };
  for (let i = 2; i < argv.length; i++) {
    const key = argv[i];
    const value = argv[i + 1];
    if (key === '--size-bytes') args.sizeBytes = Number(value);
    else if (key === '--rounds') args.rounds = Number(value);
    else if (key === '--concurrency') args.concurrency = Number(value);
    else if (key === '--idle-seconds') args.idleSeconds = Number(value);
    else if (key === '--report') args.report = value;
    else if (key === '--receiver' || key === '--child') args[key.slice(2)] = true;
    if (value !== undefined) i++;
  }
  return args;
}

/** 进程级内存采样（Linux 额外读取 /proc） */
function sampleProcess() {
  const m = process.memoryUsage();
  const sample = {
    rssMB: mb(m.rss),
    heapUsedMB: mb(m.heapUsed),
    heapTotalMB: mb(m.heapTotal),
    externalMB: mb(m.external),
    arrayBuffersMB: mb(m.arrayBuffers),
    maxRssMB: null,
    procRssMB: null,
    anonMB: null,
    swapMB: null,
    fds: null,
  };
  try {
    sample.maxRssMB = mb(process.resourceUsage().maxRSS * 1024);
  } catch { /* 平台不支持 */ }
  if (process.platform === 'linux') {
    try {
      const status = fs.readFileSync('/proc/self/status', 'utf8');
      const procRss = /VmRSS:\s+(\d+) kB/.exec(status);
      const anon = /RssAnon:\s+(\d+) kB/.exec(status);
      const swap = /VmSwap:\s+(\d+) kB/.exec(status);
      if (procRss) sample.procRssMB = mb(Number(procRss[1]) * 1024);
      if (anon) sample.anonMB = mb(Number(anon[1]) * 1024);
      if (swap) sample.swapMB = mb(Number(swap[1]) * 1024);
      sample.fds = fs.readdirSync('/proc/self/fd').length;
    } catch { /* 非 Linux */ }
  }
  return sample;
}

/* ---------------- 接收端：增量消费请求体，绝不整包缓存 ---------------- */

function runReceiver() {
  let totalBytes = 0;
  const server = http.createServer((req, res) => {
    if ((req.url || '').includes('/getFile')) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        ok: true,
        result: { file_id: RECEIVER_FILE_ID, file_path: 'documents/mem.bin', file_size: 1 },
      }));
      return;
    }
    // 增量消费：data 事件逐块计数后丢弃（保持默认流动模式，不缓存分片）
    req.on('data', (chunk) => { totalBytes += chunk.length; });
    req.on('end', () => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true, result: { document: { file_id: RECEIVER_FILE_ID } } }));
    });
    req.on('error', () => { /* 客户端中断属预期（取消/超时场景） */ });
  });

  server.listen(0, '127.0.0.1', () => {
    const { port } = server.address();
    process.stdout.write(`##READY ${port}\n`);
  });

  process.on('SIGTERM', () => {
    server.closeAllConnections();
    server.close(() => {
      process.stdout.write(`##RECEIVER-DONE bytes=${totalBytes}\n`);
      process.exit(0);
    });
  });
}

/* ---------------- 上传端子进程：加载真实 dist 构建产物 ---------------- */

function writeTempFile(sizeBytes) {
  const tmpPath = path.join(os.tmpdir(), `tgtc-mem-regression-${process.pid}.bin`);
  const chunk = Buffer.alloc(4 * 1024 * 1024, 0xa5);
  const fd = fs.openSync(tmpPath, 'w');
  let remaining = sizeBytes;
  while (remaining > 0) {
    const n = Math.min(chunk.length, remaining);
    fs.writeSync(fd, chunk, 0, n);
    remaining -= n;
  }
  fs.closeSync(fd);
  return tmpPath;
}

function runUploaderChild(args, receiverPort, reportPath) {
  const distService = path.join(__dirname, '..', 'dist', 'telegram', 'telegram.service.js');
  if (!fs.existsSync(distService)) {
    console.error(`[mem-regression] 未找到构建产物 ${distService}，请先在 backend/ 执行 npm run build`);
    process.exit(2);
  }
  // 延迟 require：确认构建产物存在后再加载（含 @nestjs 依赖）
  const { TelegramService } = require(distService);

  process.env.TELEGRAM_API_BASE = `http://127.0.0.1:${receiverPort}`;
  process.env.TELEGRAM_BOT_TOKEN = '0000000000:mem-regression-token';
  process.env.TELEGRAM_CHAT_ID = '1';

  const service = new TelegramService({ get: (key) => process.env[key] });
  const startedAt = Date.now();
  const timeline = [];
  let sampling = true;

  const sampler = setInterval(() => {
    if (!sampling) return;
    timeline.push({ tMs: Date.now() - startedAt, stage: currentStage, ...sampleProcess() });
  }, SAMPLE_INTERVAL_MS);
  sampler.unref?.();

  let currentStage = 'cold';
  timeline.push({ tMs: 0, stage: 'cold', ...sampleProcess() });

  const setStage = (stage) => {
    currentStage = stage;
    timeline.push({ tMs: Date.now() - startedAt, stage, ...sampleProcess() });
  };

  const runUpload = async (sizeBytes) => {
    const tmpPath = writeTempFile(sizeBytes);
    try {
      const { createReadStream } = require('fs');
      const result = await service.uploadFile(
        createReadStream(tmpPath),
        'mem-regression.bin',
        undefined,
        sizeBytes,
      );
      if (!result || result.file_id !== RECEIVER_FILE_ID) {
        throw new Error(`上传返回异常: ${JSON.stringify(result)}`);
      }
    } finally {
      fs.rmSync(tmpPath, { force: true });
    }
  };

  const runConcurrency = async (sizeBytes, concurrency) => {
    const started = Date.now();
    const metricsBefore = sampleProcess();
    await Promise.all(Array.from({ length: concurrency }, () => runUpload(sizeBytes)));
    return { durationMs: Date.now() - started, rssBeforeMB: metricsBefore.rssMB, anonBeforeMB: metricsBefore.anonMB };
  };

  (async () => {
    const rounds = [];
    try {
      setStage('warmup');
      await runConcurrency(WARMUP_BYTES, 1);

      for (let round = 1; round <= args.rounds; round++) {
        setStage(`round-${round}`);
        const stats = await runConcurrency(args.sizeBytes, args.concurrency);
        rounds.push({ round, ...stats });
        console.log(`[mem-regression] round ${round}/${args.rounds} 完成 (${stats.durationMs}ms)`);
      }

      setStage('idle');
      const idleUntil = Date.now() + args.idleSeconds * 1000;
      while (Date.now() < idleUntil) {
        await new Promise((resolve) => setTimeout(resolve, 500));
      }

      sampling = false;
      clearInterval(sampler);
      setStage('final');

      const peakOf = (key) => timeline.reduce((max, s) => (s[key] != null ? Math.max(max, s[key]) : max), 0);
      const lastOf = (key) => [...timeline].reverse().find((s) => s[key] != null)?.[key] ?? null;
      const warmupIndex = timeline.findIndex((s) => s.stage === 'round-1');
      const warmRss = warmupIndex >= 0 ? timeline[warmupIndex].rssMB : timeline[0].rssMB;

      const report = {
        startedAt: new Date(startedAt).toISOString(),
        platform: `${process.platform} node=${process.version}`,
        config: { sizeBytes: args.sizeBytes, rounds: args.rounds, concurrency: args.concurrency, idleSeconds: args.idleSeconds },
        note: 'arrayBuffers 已包含在 external 中，分析时禁止相加；anon/swap 仅 Linux 可用',
        rounds,
        summary: {
          warmBaselineRssMB: warmRss,
          peakRssMB: peakOf('rssMB'),
          peakAnonMB: peakOf('anonMB'),
          peakExternalMB: peakOf('externalMB'),
          peakArrayBuffersMB: peakOf('arrayBuffersMB'),
          peakSwapMB: peakOf('swapMB'),
          finalRssMB: lastOf('rssMB'),
          finalAnonMB: lastOf('anonMB'),
          finalSwapMB: lastOf('swapMB'),
          finalFds: lastOf('fds'),
        },
        timeline,
      };
      fs.writeFileSync(reportPath, JSON.stringify(report, null, 2));
      console.log(`[mem-regression] 报告已写入 ${reportPath}`);
      console.log('[mem-regression] summary=' + JSON.stringify(report.summary));
      process.exit(0);
    } catch (err) {
      sampling = false;
      clearInterval(sampler);
      console.error(`[mem-regression] 压测失败: ${err && err.message}`);
      process.exit(1);
    }
  })();
}

/* ---------------- 父进程：编排接收端与上传端 ---------------- */

async function runParent(args) {
  const reportPath = args.report
    || path.join(__dirname, '..', 'tmp', `upload-memory-report-${Date.now()}.json`);
  fs.mkdirSync(path.dirname(reportPath), { recursive: true });

  const receiver = fork(__filename, ['--receiver'], { stdio: ['ignore', 'pipe', 'inherit'] });
  const port = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('接收端启动超时')), 10000);
    receiver.stdout.on('data', (data) => {
      const match = /##READY (\d+)/.exec(String(data));
      if (match) {
        clearTimeout(timer);
        resolve(Number(match[1]));
      }
    });
    receiver.on('exit', (code) => reject(new Error(`接收端提前退出 (code=${code})`)));
  });
  console.log(`[mem-regression] 接收端就绪 127.0.0.1:${port}`);

  const child = fork(__filename, [
    '--child',
    '--size-bytes', String(args.sizeBytes),
    '--rounds', String(args.rounds),
    '--concurrency', String(args.concurrency),
    '--idle-seconds', String(args.idleSeconds),
    '--report', reportPath,
  ], { stdio: 'inherit', env: { ...process.env, MEM_REGRESSION_PORT: String(port) } });

  const exitCode = await new Promise((resolve) => child.on('exit', resolve));
  receiver.kill('SIGTERM');

  if (exitCode === 0 && fs.existsSync(reportPath)) {
    const report = JSON.parse(fs.readFileSync(reportPath, 'utf8'));
    console.log('\n[mem-regression] ===== 摘要 =====');
    for (const [key, value] of Object.entries(report.summary)) {
      console.log(`  ${key}: ${value}`);
    }
    console.log(`[mem-regression] 报告: ${reportPath}`);
    console.log('[mem-regression] 验收基准见 docs/upload-memory-repair.md §6（预算为预登记目标，非实测结论）');
  } else {
    console.error(`[mem-regression] 上传子进程异常退出 (code=${exitCode})`);
  }
  process.exit(exitCode || 0);
}

if (require.main !== module) {
  module.exports = { sampleProcess };
  return;
}

const args = parseArgs(process.argv);
if (args.receiver) {
  runReceiver();
} else if (args.child) {
  // 子进程模式需要接收端端口：由父进程经环境变量注入
  runUploaderChild(args, Number(process.env.MEM_REGRESSION_PORT), args.report);
} else {
  runParent(args).catch((err) => {
    console.error(`[mem-regression] ${err && err.message}`);
    process.exit(1);
  });
}
