import type { Logger } from "@nestjs/common";

/**
 * Executa `tick` repetidamente. Um tick que indica mais trabalho (devolve true) é
 * seguido na hora pelo próximo, para que o backlog escoe na velocidade máxima;
 * caso contrário, o loop dorme por `intervalMs`. `stop()` interrompe o sono e
 * resolve quando o tick em andamento termina.
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
