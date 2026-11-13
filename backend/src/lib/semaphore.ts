import { AppError } from './errors';

/** Bounded concurrency with a bounded queue: protects CPU/RAM from floods of expensive work (e.g. Argon2). */
export class Semaphore {
  private active = 0;
  private waiters: Array<() => void> = [];
  constructor(private max: number, private maxQueue = 200) {}

  async run<T>(fn: () => Promise<T>): Promise<T> {
    if (this.active >= this.max) {
      if (this.waiters.length >= this.maxQueue) throw new AppError(503, 'SERVER_BUSY', 'Server is busy, please retry shortly');
      await new Promise<void>((resolve) => this.waiters.push(resolve)); // slot is handed over by the releaser
    } else {
      this.active++;
    }
    try {
      return await fn();
    } finally {
      const next = this.waiters.shift();
      if (next) next();
      else this.active--;
    }
  }
}
