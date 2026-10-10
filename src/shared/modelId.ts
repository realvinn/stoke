/** A CLI model argument, including Windows batch-shim safety. */
export const MODEL_ID_MAX = 200
const MODEL_ID = /^[A-Za-z0-9_@][A-Za-z0-9._:/@+[\]-]*$/
export function isModelId(v: string): boolean {
  return v.length <= MODEL_ID_MAX && MODEL_ID.test(v)
}
