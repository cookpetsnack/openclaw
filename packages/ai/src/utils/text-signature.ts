// `sources` is the rendered source-link suffix appended after the provider's text.
// Replay removes exactly that suffix so the provider sees the text it produced.
export function encodeTextSignatureV1(
  id: string,
  phase?: "commentary" | "final_answer",
  sources?: string,
): string {
  return JSON.stringify({ v: 1, id, ...(phase ? { phase } : {}), ...(sources ? { sources } : {}) });
}

/** Replace only the source suffix of a V1 signature; other signatures cannot carry one. */
export function withTextSignatureV1Sources(
  signature: string | undefined,
  sources: string | undefined,
): string | undefined {
  if (!signature?.startsWith("{")) {
    return signature;
  }
  try {
    const parsed: unknown = JSON.parse(signature);
    if (!parsed || typeof parsed !== "object" || !("v" in parsed) || parsed.v !== 1) {
      return signature;
    }
    const rest = Object.fromEntries(Object.entries(parsed).filter(([key]) => key !== "sources"));
    return JSON.stringify({ ...rest, ...(sources ? { sources } : {}) });
  } catch {
    return signature;
  }
}
