/**
 * The Loopcom Coworker deterministic core.
 *
 * Everything exported here is PURE: no network, no filesystem, no clock of its own,
 * no database. That is what makes it exhaustively testable, and it is exhaustively
 * tested — because this layer, not the model, is the security boundary.
 *
 * ⛔ Runtime code (Electron main, the API, the worker) imports from here. Nothing
 * here imports runtime code. If you find yourself needing `fs` or `fetch` in this
 * folder, the logic belongs in the caller and the DECISION belongs here.
 */

export * from "./types";
export * from "./taskState";
export * from "./policy";
export * from "./trustBoundary";
export * from "./redaction";
export * from "./paths";
export * from "./resourceGuard";
export * from "./audit";

// The evidence-based diagnostic engine. Kept as a subpath rather than a flat
// re-export so a consumer that only needs policy does not pull in the rule set.
export * from "./diagnostics/signals";
export * from "./diagnostics/rules";
