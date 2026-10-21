import type {
  AttachmentSidebarRuntime,
  ChatDetailPanelContent,
} from "./chat-sidebar-content-types.ts";
import type { ChatDetailPanel, ChatDetailPanelProps } from "./chat-sidebar-view-types.ts";

const retireOperations = new WeakMap<ChatDetailPanel, () => void>();

export function registerDetailPanelRetirement(
  host: ChatDetailPanel,
  previousContent: () => ChatDetailPanelContent | null | undefined,
  previousRuntime: () => AttachmentSidebarRuntime | undefined,
  retire: () => void,
) {
  retireOperations.set(host, () => {
    const runtime = previousRuntime();
    const current = host.attachmentRuntime;
    if (
      !host.isConnected ||
      host.content !== previousContent() ||
      current.connectionEpoch !== runtime?.connectionEpoch ||
      current.sessionKey !== runtime?.sessionKey ||
      current.agentId !== runtime?.agentId
    ) {
      retire();
    }
  });
  return () => retireOperations.delete(host);
}

export const detailPanelOperationLifetime = {
  propertyChanged(host: ChatDetailPanel, key: keyof ChatDetailPanelProps) {
    if (key === "content" || key === "attachmentRuntime") {
      retireOperations.get(host)?.();
    }
  },
  disconnected(host: ChatDetailPanel) {
    retireOperations.get(host)?.();
  },
};
