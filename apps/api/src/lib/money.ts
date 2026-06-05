export function rublesToKopecks(amountRub: number) {
  return Math.round(amountRub * 100);
}

export function kopecksToRubles(amountKopecks: number) {
  return amountKopecks / 100;
}

export function legacyWholeRublesFromKopecks(amountKopecks: number) {
  return Math.floor(Math.max(0, amountKopecks) / 100);
}

export function billingAmountRub(amountRub: number | null | undefined, amountKopecks: number | null | undefined) {
  return typeof amountKopecks === "number" ? kopecksToRubles(amountKopecks) : (amountRub ?? null);
}
