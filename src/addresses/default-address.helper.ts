import type { PrismaService } from '../prisma/prisma.service';

// Single canonical resolver for "what's user X's default delivery
// address?". Every consumer in the gift / order / user-check flow
// must go through this helper so the rule stays the same everywhere
// — diverging copies of `where: { userId, isDefault: true }` had
// already been the source of one production bug (a frontend mock
// was creating addresses that never persisted, the backend kept
// returning null, and the recipient looked address-less).
//
// Returns `null` when no default address exists. Caller decides the
// failure path (block send / show suspension banner / etc.).
//
// We deliberately only `select: { id }` — every existing caller only
// needs the id (to write into Gift.addressId) or wants to know
// existence. If a caller eventually needs the full address shape
// they can re-fetch by id; that keeps THIS helper allocation-cheap
// in the hot path and stops it from drifting into an N-field
// projection over time.
export async function getDefaultAddressForUser(
  prisma: PrismaService,
  userId: string,
): Promise<{ id: string } | null> {
  if (!userId) return null;
  const row = await prisma.address.findFirst({
    where: { userId, isDefault: true },
    select: { id: true },
  });
  return row;
}

// Boolean shorthand. Matches the shape every "does X have a default?"
// caller actually wants — they don't need the id, just the gate.
// Wraps the same query so any future change (e.g. excluding
// soft-deleted addresses if we ever add Address.deletedAt) lands in
// one place.
export async function userHasDefaultAddress(
  prisma: PrismaService,
  userId: string,
): Promise<boolean> {
  const row = await getDefaultAddressForUser(prisma, userId);
  return row !== null;
}
