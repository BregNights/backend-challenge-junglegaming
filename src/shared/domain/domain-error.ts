/**
 * Base class for violations of domain rules. `code` is stable and machine
 * readable; adapters map it to transport-level responses.
 */
export abstract class DomainError extends Error {
  abstract readonly code: string;

  constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}
