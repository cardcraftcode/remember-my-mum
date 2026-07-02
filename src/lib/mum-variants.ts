export const MUM_VARIANTS = [
  'Mom',
  'Mommy',
  'Stepmom',
  'Mam',
  'Mammy',
  'Stepmam',
  'Mum',
  'Mummy',
  'Stepmum',
  'Ma',
  'Mama',
  'Amma',
  'Ammi',
  'Maw',
  'Mother',
] as const

export type MumVariant = (typeof MUM_VARIANTS)[number]
