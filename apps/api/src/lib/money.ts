export function rublesToKopecks(amountRub: number) {
  return Math.round(amountRub * 100);
}

export function kopecksToRubles(amountKopecks: number) {
  return amountKopecks / 100;
}
