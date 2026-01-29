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
      await this.processingPromise;
      return;
    }

    this.processingPromise = (async () => {
      try {
        let keepGoing = true;
        while (keepGoing) {
          const next = this.getNext();
          if (!next) {
            keepGoing = false;
            return;
          }

          this.fixInProgress = true;
          try {
            await this.onProcess?.(next);
          } finally {
            this.fixInProgress = false;
          }
        }
      } finally {
        this.processingPromise = null;
      }
    })();

    await this.processingPromise;
  }
}
