export const resolvePlayerName = (...candidates: Array<string | null | undefined>): string =>
  candidates.find((name) => typeof name === 'string' && name.trim().length > 0)?.trim() ?? ''
