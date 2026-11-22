import type { GenerationOperationReceipt, ProseOperationRequest } from './api';

export const GENERATION_RECEIPT_PREFIX = 'proser:generation:';
export const GENERATION_RECEIPTS_CHANGED = 'proser:generation-receipts-changed';

export type RetainedGenerationState =
  'creating' | 'watching' | 'detached' | 'unresolved' | 'completed' | 'failed' | 'cancelled';

export interface RetainedGenerationReceipt {
  version: 1;
  idempotencyKey: string;
  request: ProseOperationRequest;
  state: RetainedGenerationState;
  createdAt: number;
  updatedAt: number;
  operationId?: string;
  operationStatus?: GenerationOperationReceipt['status'];
  artifact?: string;
  artifactHash?: string;
  terminalMessage?: string;
}

function storageAvailable(): boolean {
  return typeof window !== 'undefined' && Boolean(window.sessionStorage);
}

function notify(): void {
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new Event(GENERATION_RECEIPTS_CHANGED));
  }
}

export function generationReceiptStorageKey(idempotencyKey: string): string {
  return `${GENERATION_RECEIPT_PREFIX}${idempotencyKey}`;
}

function parseRecord(raw: string | null): RetainedGenerationReceipt | null {
  if (!raw) return null;
  try {
    const value = JSON.parse(raw) as Partial<RetainedGenerationReceipt>;
    if (
      value.version !== 1 ||
      typeof value.idempotencyKey !== 'string' ||
      !value.idempotencyKey ||
      !value.request ||
      typeof value.request.bookId !== 'number' ||
      !Number.isFinite(value.createdAt) ||
      !Number.isFinite(value.updatedAt) ||
      ![
        'creating',
        'watching',
        'detached',
        'unresolved',
        'completed',
        'failed',
        'cancelled',
      ].includes(value.state ?? '')
    )
      return null;
    return value as RetainedGenerationReceipt;
  } catch {
    return null;
  }
}

export function listGenerationReceipts(): RetainedGenerationReceipt[] {
  if (!storageAvailable()) return [];
  const records: RetainedGenerationReceipt[] = [];
  const invalidKeys: string[] = [];
  for (let index = 0; index < window.sessionStorage.length; index += 1) {
    const storageKey = window.sessionStorage.key(index);
    if (!storageKey?.startsWith(GENERATION_RECEIPT_PREFIX)) continue;
    const record = parseRecord(window.sessionStorage.getItem(storageKey));
    if (record) records.push(record);
    else invalidKeys.push(storageKey);
  }
  for (const storageKey of invalidKeys) window.sessionStorage.removeItem(storageKey);
  return records.sort((left, right) => right.updatedAt - left.updatedAt);
}

export function saveGenerationReceipt(record: RetainedGenerationReceipt): void {
  if (!storageAvailable()) return;
  window.sessionStorage.setItem(
    generationReceiptStorageKey(record.idempotencyKey),
    JSON.stringify(record),
  );
  notify();
}

export function updateGenerationReceipt(
  idempotencyKey: string,
  update: Partial<
    Omit<RetainedGenerationReceipt, 'version' | 'idempotencyKey' | 'request' | 'createdAt'>
  >,
): void {
  if (!storageAvailable()) return;
  const storageKey = generationReceiptStorageKey(idempotencyKey);
  const current = parseRecord(window.sessionStorage.getItem(storageKey));
  if (!current) return;
  saveGenerationReceipt({ ...current, ...update, updatedAt: Date.now() });
}

export function removeGenerationReceipt(idempotencyKey: string): void {
  if (!storageAvailable()) return;
  window.sessionStorage.removeItem(generationReceiptStorageKey(idempotencyKey));
  notify();
}

export function isTerminalGenerationStatus(status: GenerationOperationReceipt['status']): boolean {
  return status === 'completed' || status === 'failed' || status === 'cancelled';
}
