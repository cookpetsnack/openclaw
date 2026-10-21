import type { GatewaySessionRow } from "../../api/types.ts";

/** Compare presentation values without treating read freshness as a content change. */
export function isShallowEqualSessionRow(
  incoming: GatewaySessionRow,
  existing: GatewaySessionRow,
): boolean {
  const incomingFields: Record<string, unknown> = incoming;
  const existingFields: Record<string, unknown> = existing;
  let fieldCount = 0;
  for (const key in incoming) {
    if (key === "snapshotAt") {
      continue;
    }
    fieldCount++;
    const a = incomingFields[key];
    const b = existingFields[key];
    // Fresh decoded snapshots need value comparison even without shared identities.
    if (
      a !== b &&
      (a === null ||
        b === null ||
        typeof a !== "object" ||
        typeof b !== "object" ||
        JSON.stringify(a) !== JSON.stringify(b))
    ) {
      return false;
    }
  }
  for (const key in existing) {
    if (key !== "snapshotAt") {
      fieldCount--;
    }
  }
  return fieldCount === 0;
}
