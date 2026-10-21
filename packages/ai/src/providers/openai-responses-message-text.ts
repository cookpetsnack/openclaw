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
  const citations = new Map(previous?.citations);
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
  // Terminal snapshots may add annotations, not replace already-delivered prose.
  if (previous && !prose.startsWith(previous.prose)) {
    return previous;
  }
  return {
    prose,
    citations,
    text: citations.size > 0 ? prose + " " + [...citations.values()].join(" ") : prose,
  };
}
