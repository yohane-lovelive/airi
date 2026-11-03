function padDatePart(value: number): string {
  return value.toString().padStart(2, '0')
}

/**
 * Formats a timestamp as `[YYYY-MM-DD HH:MM] ` in the user's local timezone.
 *
 * Use when:
 * - Annotating user messages so the model has a concrete time anchor on
 *   every turn — historic and current user turns use the same shape so that
 *   prefix-cache stays valid when a "current" turn becomes "historic" on
 *   the next send.
 * - Not used for assistant messages — that caused the model to mirror the
 *   prefix into its own output.
 *
 * Returns:
 * - String including a trailing space, e.g. `"[2026-04-25 18:47] "`.
 *
 * Before:
 * - createdAt = 1745570820000  (a Unix ms in Asia/Shanghai)
 *
 * After:
 * - "[2026-04-25 18:47] "
 */
export function formatTimePrefix(createdAt: number): string {
  const date = new Date(createdAt)
  const year = date.getFullYear()
  const month = padDatePart(date.getMonth() + 1)
  const day = padDatePart(date.getDate())
  const hour = padDatePart(date.getHours())
  const minute = padDatePart(date.getMinutes())

  return `[${year}-${month}-${day} ${hour}:${minute}] `
}

const TIME_PREFIX = /^\[\d{4}-\d{2}-\d{2} \d{2}:\d{2}\] /

/**
 * Removes the {@link formatTimePrefix} prefix from the start of a user text.
 *
 * Use when:
 * - A reader of the request text needs only the owner's words, for example a search of memories by meaning.
 *
 * Before:
 * - "[2026-04-25 18:47] 好きな食べ物は？"
 *
 * After:
 * - "好きな食べ物は？"
 */
export function withoutTimePrefix(text: string): string {
  return text.replace(TIME_PREFIX, '')
}
