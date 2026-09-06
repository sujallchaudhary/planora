/** Escape Telegram Markdown (v1) special characters in dynamic text. */
export function md(text: string | undefined | null): string {
  return String(text ?? '').replace(/[_*[\]`]/g, '\\$&');
}
