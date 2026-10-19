/**
 * Benchmark do pipeline da outbox no banco: `bun run test:load:outbox`.
 *
 * Isola exatamente o que as correções da outbox mudaram (índice do claim, tamanho
 * do lote, UPDATE em lote, frequência da contagem do backlog), trocando o broker
 * por um publisher falso que confirma na hora. Assim o resultado não depende do
 * emulador de SQS, cuja vazão cai com a profundidade da fila (ver docs/LOAD_TEST.md).
 *
 * Roda no banco de teste (wagering_test), recriado do zero: monta um histórico de
 * eventos já publicados e um backlog pendente, e mede quanto tempo 3 publishers
 * concorrentes (como as 3 réplicas) levam para drenar o backlog, em dois modos:
 *
 *   - legado: índice antigo, lotes de 10, um UPDATE por evento e a contagem do
 *     backlog depois de cada lote (o comportamento antes das correções);
 *   - atual: índice parcial, lotes de 100, um UPDATE por lote e a contagem do
 *     backlog no máximo uma vez por segundo (o OutboxPublisher de verdade).
 *
 * Variáveis: OUTBOX_BENCH_HISTORY (100000), OUTBOX_BENCH_PENDING (20000), OUTBOX_BENCH_WORKERS (3).
 */
import type { MikroORM } from "@mikro-orm/postgresql";
import { OutboxPublisher, type PublishResult } from "../../src/messaging/application/outbox-publisher";
import type { OutboxMessage } from "../../src/messaging/domain/outbox-message";
import { MikroOrmUnitOfWork } from "../../src/persistence/mikro-orm-unit-of-work";
import type { WageringMetrics } from "../../src/shared/application/metrics";
import { SystemClock } from "../../src/shared/infrastructure/runtime";
import { createTestOrm, resetSchema } from "../support/database";

const history = Number(process.env.OUTBOX_BENCH_HISTORY ?? 100_000);
const pending = Number(process.env.OUTBOX_BENCH_PENDING ?? 20_000);
const workers = Number(process.env.OUTBOX_BENCH_WORKERS ?? 3);

const noMetrics: WageringMetrics = {
  transactionDecided() {},
  duplicateDetected() {},
  processingObserved() {},
  lockConflict() {},
  reconciliationChecked() {},
  messageRetried() {},
  messageDeadLettered() {},
  outboxPublished() {},
  outboxPublishFailed() {},
  outboxBacklog() {},
};

/** Broker falso: confirma tudo na hora, para medir só o lado do banco. */
const instantBroker = {
  async publish(messages: readonly OutboxMessage[]): Promise<PublishResult> {
    return { published: new Set(messages.map((message) => message.id)), failed: new Map() };
  },
};

async function seed(orm: MikroORM): Promise<void> {
  await orm.em.execute(
    `insert into outbox_messages (id, aggregate_id, message_group_id, event_type, payload, occurred_at, next_attempt_at, published_at)
     select gen_random_uuid(), gen_random_uuid(), 'g' || (n % 200), 'Bench', '{"x":1}'::jsonb, now(), now(), now()
       from generate_series(1, ?) as n`,
    [history],
  );
  await orm.em.execute(
    `insert into outbox_messages (id, aggregate_id, message_group_id, event_type, payload, occurred_at, next_attempt_at)
     select gen_random_uuid(), gen_random_uuid(), 'g' || (n % 200), 'Bench', '{"x":1}'::jsonb, now(), now()
       from generate_series(1, ?) as n`,
    [pending],
  );
  await orm.em.execute("analyze outbox_messages");
}

/** O pipeline como era antes das correções, com as mesmas queries do código antigo. */
async function legacyBatch(orm: MikroORM, uow: MikroOrmUnitOfWork, clock: SystemClock): Promise<number> {
  const claimed = await uow.run(async (store) => {
    const now = clock.now();
    const messages = await store.outbox.claimDue(now, 10);
    for (const message of messages) {
      message.markPublished(now);
      await store.outbox.saveDeliveryState(message);
    }
    return messages.length;
  });
  await orm.em
    .fork()
    .execute(
      `select count(*)::int, coalesce(extract(epoch from (now() - min(occurred_at))), 0)::float8
         from outbox_messages where published_at is null`,
    );
  return claimed;
}

async function drain(label: string, batch: () => Promise<number>): Promise<number> {
  const started = performance.now();
  let published = 0;
  await Promise.all(
    Array.from({ length: workers }, async () => {
      for (;;) {
        const claimed = await batch();
        if (claimed === 0) return;
        published += claimed;
      }
    }),
  );
  const seconds = (performance.now() - started) / 1_000;
  const rate = published / seconds;
  console.log(`${label}: ${published} eventos em ${seconds.toFixed(1)} s → ${rate.toFixed(0)} eventos/s`);
  return rate;
}

const clock = new SystemClock();
console.log(`Histórico de ${history} eventos publicados, backlog de ${pending}, ${workers} publishers concorrentes.`);

// Uma instância de ORM por fase: o migrator guarda em cache que a tabela de migrations
// existe, e ela some quando o schema é recriado.
const legacyOrm = await createTestOrm();
await resetSchema(legacyOrm);
await legacyOrm.migrator.down(); // índice antigo: o claim atravessa o histórico publicado
await seed(legacyOrm);
const legacyUow = new MikroOrmUnitOfWork(legacyOrm.em, noMetrics);
const legacy = await drain("legado (índice antigo, lote de 10, UPDATE por evento)", () =>
  legacyBatch(legacyOrm, legacyUow, clock),
);
await legacyOrm.close(true);

const currentOrm = await createTestOrm();
await resetSchema(currentOrm); // índice parcial
await seed(currentOrm);
const publisher = new OutboxPublisher(new MikroOrmUnitOfWork(currentOrm.em, noMetrics), clock, instantBroker, noMetrics, {
  crashIf() {},
});
const current = await drain("atual (índice parcial, lote de 100, UPDATE em lote)", () => publisher.publishBatch(100));
await currentOrm.close(true);

console.log(`\nGanho no pipeline da outbox: ${(current / legacy).toFixed(1)}×`);
