import { addYears, format, isBefore, isEqual, startOfDay, parseISO } from 'date-fns'

/**
 * Given a birthday date (e.g. "1990-05-15"), return the next upcoming
 * occurrence as "YYYY-MM-DD".
 */
export function nextBirthday(birthdayIso: string, from = new Date()): string {
  const parsed = parseISO(birthdayIso)
  const today = startOfDay(from)
  const thisYear = today.getFullYear()

  const candidate = new Date(thisYear, parsed.getMonth(), parsed.getDate())
  const candidateDay = startOfDay(candidate)

  if (isBefore(candidateDay, today) || isEqual(candidateDay, today)) {
    return format(addYears(candidate, 1), 'yyyy-MM-dd')
  }

  return format(candidate, 'yyyy-MM-dd')
}

/**
 * UK Mother's Day is the 4th Sunday of Lent.
 * This uses the Western Christian date for Easter.
 */
export function ukMothersDay(year: number): Date {
  // Gauss Easter computation for Western churches.
  const a = year % 19
  const b = Math.floor(year / 100)
  const c = year % 100
  const d = Math.floor(b / 4)
  const e = b % 4
  const f = Math.floor((b + 8) / 25)
  const g = Math.floor((b - f + 1) / 3)
  const h = (19 * a + b - d - g + 15) % 30
  const i = Math.floor(c / 4)
  const k = c % 4
  const l = (32 + 2 * e + 2 * i - h - k) % 7
  const m = Math.floor((a + 11 * h + 22 * l) / 451)
  const month = Math.floor((h + l - 7 * m + 114) / 31) - 1 // 0-indexed
  const day = ((h + l - 7 * m + 114) % 31) + 1

  const easter = new Date(year, month, day)

  // Mothering Sunday = 4th Sunday of Lent = Easter - 21 days
  return new Date(easter.getTime() - 21 * 24 * 60 * 60 * 1000)
}

export function formatDateIso(date: Date): string {
  return format(date, 'yyyy-MM-dd')
}
