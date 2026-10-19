import { Migration } from "@mikro-orm/migrations";

/**
 * Índice para o claim da outbox, motivado pelo teste de carga (docs/LOAD_TEST.md).
 *
 * O claim ordena por `sequence` e filtra `published_at IS NULL`. Sem um índice
 * parcial em `sequence`, o planner percorria o índice único de `sequence` desde o
 * começo, descartando uma a uma as linhas já publicadas: o custo de cada claim
 * crescia com o histórico da outbox. Com o índice parcial, o claim só toca as
 * linhas pendentes. Ele também atende à contagem do backlog e substitui o índice
 * anterior, que não servia à ordenação.
 *
 * Em produção, com a tabela grande, o índice seria criado com CONCURRENTLY, numa
 * migration fora de transação.
 */
export class Migration20261019000000OutboxUnpublishedIndex extends Migration {
  override name = "Migration20261019000000OutboxUnpublishedIndex";

  override up(): void {
    this.addSql(`create index outbox_messages_unpublished_idx on outbox_messages (sequence) where published_at is null`);
    this.addSql(`drop index if exists outbox_messages_pending_idx`);
  }

  override down(): void {
    this.addSql(`
      create index outbox_messages_pending_idx on outbox_messages (next_attempt_at, sequence)
      where published_at is null
    `);
    this.addSql(`drop index if exists outbox_messages_unpublished_idx`);
  }
}
