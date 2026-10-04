import { Readable } from 'stream';
import { pipe } from 'fp-ts/function';
import * as A from 'fp-ts/Array';
import * as TE from 'fp-ts/TaskEither';
import * as T from 'fp-ts/Task';
import { logger } from '../utils/logger';

export interface Transaction {
  TransactionID: string;
  TransactionDT: number;
  TransactionAmt: number;
  ProductCD: string;
  card1: string;
  card2: string;
  card3: string;
  card4: string;
  card5: string;
  card6: string;
  addr1: string;
  addr2: string;
  dist1: number;
  dist2: number;
  P_emaildomain: string;
  R_emaildomain: string;
  [key: string]: string | number;
}

interface BatchOptions {
  batchSize: number;
  workers: number;
  maxQueueSize: number;
}

const DEFAULT_OPTIONS: BatchOptions = {
  batchSize: 10000,
  workers: 4,
  maxQueueSize: 100,
};

/***
 * Creates an async iterator that yields batches of transactions with backpressure handling.
 * Uses fp-ts TaskEither for error handling and functional composition.
 */
export async function* pipeline(
  transactions: Transaction[],
  batchSize: number = DEFAULT_OPTIONS.batchSize,
  workers: number = DEFAULT_OPTIONS.workers
): AsyncGenerator<Transaction[], void, unknown> {
  const options = { ...DEFAULT_OPTIONS, batchSize, workers };
  
  // Split transactions into batches
  const batches = pipe(
    transactions,
    A.chunk(batchSize)
  );

  logger.debug('Created batches', { batchCount: batches.length, batchSize });

  // Process batches with controlled concurrency (backpressure)
  const semaphore = createSemaphore(options.workers);
  const queue: Array<() => Promise<void>> = [];
  let batchIndex = 0;
  let isProcessing = false;

  const processNext = async (): Promise<void> => {
    if (batchIndex >= batches.length) return;
    
    const currentBatch = batches[batchIndex++];
    const release = await semaphore.acquire();
    
    try {
      yield currentBatch;
    } finally {
      release();
      if (batchIndex < batches.length) {
        await processNext();
      }
    }
  };

  // Yield batches with worker pool backpressure
  for (const batch of batches) {
    await semaphore.acquire();
    try {
      yield batch;
    } finally {
      semaphore.release();
    }
  }
}

/***
 * Simple semaphore for controlling concurrent batch processing
 */
function createSemaphore(permits: number) {
  let available = permits;
  const waitQueue: Array<() => void> = [];

  return {
    async acquire(): Promise<() => void> {
      if (available > 0) {
        available--;
        return () => {
          available++;
          if (waitQueue.length > 0) {
            const next = waitQueue.shift()!;
            next();
          }
        };
      }

      return new Promise<() => void>((resolve) => {
        waitQueue.push(() => {
          available--;
          resolve(() => {
            available++;
            if (waitQueue.length > 0) {
              const next = waitQueue.shift()!;
              next();
            }
          });
        });
      });
    },
    release() {
      available++;
      if (waitQueue.length > 0) {
        const next = waitQueue.shift()!;
        next();
      }
    },
  };
}

/***
 * Transforms a batch through a series of pure functions using fp-ts pipe
 */
export function transformBatch<T, R>(
  batch: T[],
  ...fns: Array<(items: T[]) => R[]>
): R[] {
  return pipe(
    batch,
    ...fns
  );
}

/***
 * Filters transactions by a predicate, preserving fp-ts style
 */
export function filterBatch<T>(
  batch: T[],
  predicate: (item: T) => boolean
): T[] {
  return batch.filter(predicate);
}

/***
 * Maps transactions with a transformation function
 */
export function mapBatch<T, R>(
  batch: T[],
  transform: (item: T) => R
): R[] {
  return batch.map(transform);
}
