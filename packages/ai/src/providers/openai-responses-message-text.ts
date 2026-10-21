import { isRecord } from "@openclaw/normalization-core/record-coerce";

export type ResponsesMessageText = {
  text: string;
  prose: string;
  citations: ReadonlyMap<string, string>;
};

/** Keep provider prose separate from source formatting so terminal annotations can extend it. */
export function renderResponsesMessageText(
  content: readonly unknown[],
  previous?: ResponsesMessageText,
): ResponsesMessageText {
  const citations = new Map<string, string>();
  const prose = content
    .map((part) => {
      if (!isRecord(part)) {
        return "";
      }
      if (part.type !== "output_text" && part.type !== "text") {
        return typeof part.refusal === "string" ? part.refusal : "";
      }
      for (const annotation of Array.isArray(part.annotations) ? part.annotations : []) {
        if (
          !isRecord(annotation) ||
          annotation.type !== "url_citation" ||
          typeof annotation.url !== "string"
        ) {
          continue;
        }
        let url: URL;
        try {
          url = new URL(annotation.url);
        } catch {
          continue;
        }
        if ((url.protocol !== "https:" && url.protocol !== "http:") || citations.has(url.href)) {
          continue;
        }
        const title = (
          typeof annotation.title === "string" && annotation.title.trim()
            ? annotation.title
            : url.hostname
        )
          .replace(/\s+/gu, " ")
          .replace(/[!-/:-@[-`{-~]/g, "\\$&");
        const href = url.href.replace(
          /[()<>\\\s]/gu,
          (character) => "%" + character.charCodeAt(0).toString(16).toUpperCase(),
        );
        citations.set(url.href, "[" + title + "](" + href + ")");
      }
      return typeof part.text === "string" ? part.text : "";
    })
    .join("");
  return extendResponsesMessageText({ prose, citations }, previous);
}

/** Merge source state only after matching cumulative provider prose, never formatted links. */
export function extendResponsesMessageText(
  next: Pick<ResponsesMessageText, "prose" | "citations">,
  previous?: ResponsesMessageText,
): ResponsesMessageText {
  // Terminal snapshots may add annotations, not replace already-delivered prose.
  if (previous && !next.prose.startsWith(previous.prose)) {
    return previous;
  }
  let citations = next.citations;
  if (previous) {
    const combined = new Map(previous.citations);
    for (const [url, link] of next.citations) {
      if (!combined.has(url)) {
        combined.set(url, link);
      }
    }
    citations = combined;
  }
  return {
    prose: next.prose,
    citations,
    // A separate paragraph cannot invalidate a closing fence or join a list/table row.
    text: citations.size > 0 ? next.prose + "\n\n" + [...citations.values()].join(" ") : next.prose,
  };
}
