/**
 * Classe base para violações de regras de domínio. `code` é estável e legível por
 * máquina; os adapters o traduzem em respostas do transporte.
 */
export abstract class DomainError extends Error {
  abstract readonly code: string;

  constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}
