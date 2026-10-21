import { createMemo, Errored, isPending, latest, Loading } from "solid-js";
import { formatUiError } from "../../lib/format-error.ts";
import { t } from "../../lib/reactive/i18n.ts";
import { DeviceInventoryContent } from "./view-inventory.tsx";
import type { DevicesProps } from "./view.types.ts";

export function DeviceInventory(props: DevicesProps) {
  const scope = createMemo(() => props.inventoryScope);
  const readInventory = () => {
    latest(props.inventoryRead);
    return null;
  };
  return (
    <Errored
      fallback={(error, reset) => (
        <>
          <div class="callout danger" role="alert">
            {formatUiError(error())}{" "}
            <button
              class="btn btn--sm"
              onClick={() => {
                props.onReloadInventory();
                reset();
              }}
            >
              {t("common.retry")}
            </button>
          </div>
          <DeviceInventoryContent {...props} pending={false} />
        </>
      )}
    >
      <Loading on={latest(scope)} fallback={<DeviceInventoryContent {...props} pending={true} />}>
        {readInventory()}
        <DeviceInventoryContent {...props} pending={isPending(props.inventoryRead)} />
      </Loading>
    </Errored>
  );
}
