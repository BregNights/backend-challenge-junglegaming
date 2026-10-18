import type { Logger } from "@nestjs/common";

/**
 * Runs `tick` repeatedly. A tick that reports more work (returns true) is
 * followed immediately by the next one, so backlogs drain at full speed;
 * otherwise the loop sleeps for `intervalMs`. `stop()` interrupts the sleep and
 * resolves once the tick in progress has finished.
 */
export class PollingLoop {
  private running = false;
  private current: Promise<void> | undefined;
  private wake: (() => void) | undefined;

  constructor(
    private readonly name: string,
    private readonly intervalMs: number,
    private readonly tick: () => Promise<boolean>,
    private readonly logger: Logger,
  ) {}

  start(): void {
    if (this.running) return;
    this.running = true;
    this.current = this.run();
  }

  async stop(): Promise<void> {
    this.running = false;
    this.wake?.();
    await this.current;
  }

  private async run(): Promise<void> {
    while (this.running) {
      let moreWork = false;
      try {
        moreWork = await this.tick();
      } catch (error) {
        this.logger.error({ msg: `${this.name} tick failed`, error: error instanceof Error ? error.message : String(error) });
      }
      if (this.running && !moreWork) await this.sleep(this.intervalMs);
    }
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const timer = setTimeout(resolve, ms);
      this.wake = () => {
        clearTimeout(timer);
        resolve();
      };
    });
  }
}
