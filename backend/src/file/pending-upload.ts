import { join } from 'node:path';

export function pendingUploadName(fileId: string, uploadVersion: number): string {
  return `${fileId}.v${uploadVersion}`;
}

export function pendingUploadDirectory(): string {
  return join(process.cwd(), 'tmp', 'uploads', 'pending');
}

export function parsePendingUploadName(name: string): { id: string; version?: number } | undefined {
  const match = /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(?:\.v(\d+))?$/i.exec(name);
  if (match) return { id: match[1], version: match[2] === undefined ? undefined : Number(match[2]) };
  return undefined;
}
