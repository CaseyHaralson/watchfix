import type { Database } from '../db/index.js';
import { getErrorsByStatus, type ErrorRecord } from '../db/queries.js';

type FixQueueOptions = {
  onProcess?: (error: ErrorRecord) => Promise<void> | void;
};

export class FixQueue {
  private readonly db: Database;
  private readonly onProcess?: (error: ErrorRecord) => Promise<void> | void;
  private fixInProgress = false;
  private processingPromise: Promise<void> | null = null;

  constructor(db: Database, options?: FixQueueOptions) {
    this.db = db;
    this.onProcess = options?.onProcess;
  }

  getNext(): ErrorRecord | null {
    if (this.fixInProgress) {
      return null;
    }
    const errors = getErrorsByStatus(this.db, ['pending', 'suggested']);
    return errors[0] ?? null;
  }

  async processQueueIfReady(): Promise<void> {
    if (!this.onProcess) {
      return;
    }

    if (this.processingPromise) {
      // If already processing, wait for the current loop to finish and then
      // trigger a new check to ensure no items were missed in the window
      // between getNext() returning null and the promise resolving.
      await this.processingPromise;
      return this.processQueueIfReady();
    }

    this.processingPromise = (async () => {
      try {
        while (true) {
          const next = this.getNext();
          if (!next) {
            break;
          }

          this.fixInProgress = true;
          try {
            await this.onProcess?.(next);
          } finally {
            this.fixInProgress = false;
          }
        }
      } catch (err) {
        // We catch here to ensure the promise resolves and processingPromise is cleared
        // The error should ideally be logged by a real logger if available.
      }
    })();

    try {
      await this.processingPromise;
    } finally {
      this.processingPromise = null;
    }
  }
}