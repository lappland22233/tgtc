import type { Job } from 'bull';

const MINUTE_MS = 60_000;

/** The previous closed minute, anchored to this occurrence even when Bull retries it later. */
export function metricsWindowEnd(job: Job<{ windowTime?: string }>): Date {
  // Bull persists the scheduled instant even when adding a late occurrence clamps its delay to zero.
  const opts: (Job['opts'] & { prevMillis?: number }) | undefined = job.opts;
  const due = job.data?.windowTime
    ? Date.parse(job.data.windowTime)
    : opts?.prevMillis ?? ((job.timestamp ?? Date.now()) + (opts?.delay ?? 0));
  return new Date((Math.floor(due / MINUTE_MS) - 1) * MINUTE_MS);
}
