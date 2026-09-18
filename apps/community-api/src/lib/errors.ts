/**
 * Every refusal the api gives has a machine code and a human sentence. The web
 * and the apps render `message` verbatim — write it for the person reading it.
 */
export class ApiError extends Error {
  status: number;
  code: string;
  details?: unknown;
  constructor(status: number, code: string, message: string, details?: unknown) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export const badRequest = (code: string, message: string, details?: unknown) => new ApiError(400, code, message, details);
export const unauthorized = (message = "Sign in to continue.") => new ApiError(401, "unauthorized", message);
export const forbidden = (message = "You don't have access to that.") => new ApiError(403, "forbidden", message);
/** ⛔ Absence and refusal share this shape on purpose — never reveal which. */
export const notFound = (what = "That") => new ApiError(404, "not_found", `${what} wasn't found.`);
export const conflict = (code: string, message: string) => new ApiError(409, code, message);
export const tooMany = (message = "Slow down — try again in a minute.") => new ApiError(429, "rate_limited", message);
