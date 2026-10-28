/** Orders two `EventFabric-Position` tokens (base64url of `transactionId:sequence`). */
export function comparePositions(a: string, b: string): number {
  const parts = (token: string) => atob(token.replace(/-/g, "+").replace(/_/g, "/")).split(":").map(BigInt);
  const [ta, sa] = parts(a), [tb, sb] = parts(b);
  if (ta !== tb) return ta! < tb! ? -1 : 1;
  return sa === sb ? 0 : sa! < sb! ? -1 : 1;
}
