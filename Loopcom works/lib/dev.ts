/** True when running a local Next.js dev build (safe on client — inlined at compile time). */
export function isDevEnvironment(): boolean {
  return process.env.NODE_ENV === 'development'
}
