/** A refusal the Admin console can show: a stable `code`, an HTTP status and a human message. */
export class AdminError extends Error {
  constructor(
    readonly code: string,
    readonly status = 400,
    message?: string,
  ) {
    super(message ?? code);
  }
}
