import { action, createMemo, createOptimistic, createStore, For, onSettled, Show } from "solid-js";
import type { NativeChromeExtensionSetupAction } from "../app/native-chrome-setup.ts";
import type { LegacyChromeInstallResult } from "../app/native-device-settings.ts";
import { projectNativeDeviceSettings } from "../lib/reactive/application-native.ts";
import { useOptionalApplication } from "../lib/reactive/context.ts";
import { t } from "../lib/reactive/i18n.ts";
import { ChromeSetupStatus, type ChromeSetupStatusProps } from "./chrome-setup-status.tsx";
import "./native-chrome-setup.css";

export function NativeChromeSetup() {
  let host!: HTMLElement;
  const capability = useOptionalApplication()?.nativeDeviceSettings;
  const projection = capability ? projectNativeDeviceSettings(capability) : undefined;
  const browser = () => projection?.read()?.browser;
  const [running, setRunning] = createOptimistic(false);
  const [state, setState] = createStore<Omit<ChromeSetupStatusProps, "running">>({
    failed: null,
    result: null,
    legacyResult: null,
  });
  let disposed = false;
  let pending = false;
  onSettled(() => () => {
    disposed = true;
  });
  const actions = createMemo<readonly NativeChromeExtensionSetupAction[]>(() => {
    const available = browser();
    if (!available || !capability) {
      return [];
    }
    if (available.chromeSetupActions) {
      return available.chromeSetupActions;
    }
    if (projection?.read()?.device.platform !== "macos") {
      return [];
    }
    return capability.installChromeExtension ? ["install"] : [];
  });
  const setup = action(function* (setupAction: NativeChromeExtensionSetupAction) {
    if (!host.isConnected || !capability || pending || !actions().includes(setupAction)) {
      return;
    }
    const isCurrent = () => !disposed && host.isConnected;
    pending = true;
    setRunning(true);
    setState((value) => {
      value.failed = null;
      value.result = null;
      value.legacyResult = null;
    });
    try {
      if (browser()?.chromeSetupActions === undefined) {
        let request: Promise<LegacyChromeInstallResult>;
        if (setupAction === "inspect" && capability.chromeExtensionStatus) {
          request = capability.chromeExtensionStatus();
        } else if (setupAction === "install" && capability.installChromeExtension) {
          request = capability.installChromeExtension();
        } else {
          return;
        }
        yield request.then((legacyResult) => {
          if (isCurrent() && actions().includes(setupAction)) {
            setState((value) => {
              value.legacyResult = legacyResult;
            });
          }
        });
      } else {
        yield capability.setupChromeExtension(setupAction).then((result) => {
          if (isCurrent() && actions().includes(setupAction)) {
            setState((value) => {
              value.result = result;
            });
          }
        });
      }
    } catch {
      if (isCurrent()) {
        setState((value) => {
          value.failed = "setup";
        });
      }
    } finally {
      pending = false;
    }
  });
  const visibleActions = () =>
    (
      [
        ["install", "chromeExtensionSetup"],
        ["inspect", "chromeExtensionRefresh"],
        ["verify", "chromeExtensionVerify"],
      ] as const
    ).filter(([setupAction]) => actions().includes(setupAction));
  return (
    <openclaw-native-chrome-setup ref={(element) => (host = element)}>
      <Show when={browser()}>
        <div class="native-chrome-setup">
          <p>{t("configPage.deviceSettings.chromeExtensionHint")}</p>
          <div class="native-chrome-setup__actions">
            <For each={visibleActions()}>
              {([setupAction, label]) => (
                <button
                  type="button"
                  class="btn"
                  disabled={running()}
                  onClick={() => void setup(setupAction)}
                >
                  {t(`configPage.deviceSettings.${label}`)}
                </button>
              )}
            </For>
          </div>
          <ChromeSetupStatus
            result={state.result}
            legacyResult={state.legacyResult}
            running={running()}
            failed={state.failed}
          />
        </div>
      </Show>
    </openclaw-native-chrome-setup>
  );
}
