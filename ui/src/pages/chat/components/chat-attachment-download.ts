import { action, createOptimistic, createSignal, onCleanup } from "solid-js";
import { t } from "../../../i18n/index.ts";
import { downloadBlobFile } from "../../../lib/download.ts";
import { formatUiError } from "../../../lib/format-error.ts";
import type {
  AttachmentSidebarRuntime,
  ChatDetailPanelContent,
} from "./chat-sidebar-content-types.ts";

export function createAttachmentDownload(
  content: () => ChatDetailPanelContent | null,
  runtime: () => AttachmentSidebarRuntime,
  isConnected: () => boolean,
) {
  let request: { controller: AbortController; retire: () => void } | null = null;
  const [pending, setPending] = createOptimistic(false);
  const [error, setError] = createSignal<string | null>(null, { ownedWrite: true });
  const retire = () => {
    request?.controller.abort();
    request?.retire();
    request = null;
  };
  onCleanup(retire);
  const presentDownload = action(function* (
    currentRequest: NonNullable<typeof request>,
    completion: Promise<void>,
    retired: Promise<void>,
  ) {
    if (request === currentRequest) {
      setPending(true);
    }
    yield Promise.race([completion, retired]);
  });

  return {
    get pending() {
      return pending();
    },
    get error() {
      return error();
    },
    cancel() {
      retire();
      setError(null);
    },
    onDownload: async () => {
      const attachment = content();
      if (attachment?.kind !== "attachment" || !attachment.download || request) {
        return;
      }
      const read = attachment.download;
      const retired = Promise.withResolvers<void>();
      const currentRequest = { controller: new AbortController(), retire: retired.resolve };
      const { connectionEpoch, sessionKey, agentId } = runtime();
      request = currentRequest;
      setError(null);
      const current = () => {
        const scope = runtime();
        return (
          isConnected() &&
          content() === attachment &&
          request === currentRequest &&
          scope.connectionEpoch === connectionEpoch &&
          scope.sessionKey === sessionKey &&
          scope.agentId === agentId &&
          !currentRequest.controller.signal.aborted
        );
      };
      const download = async () => {
        try {
          const blob = await read(currentRequest.controller.signal);
          if (!current()) {
            return;
          }
          if (!blob) {
            throw new Error(t("chat.attachments.unavailable"));
          }
          downloadBlobFile(attachment.title, blob);
        } catch (cause) {
          if (current()) {
            setError(formatUiError(cause));
          }
        } finally {
          if (request === currentRequest) {
            request = null;
          }
        }
      };
      const completion = download();
      await Promise.resolve();
      return presentDownload(currentRequest, completion, retired.promise);
    },
  };
}
