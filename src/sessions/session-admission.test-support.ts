import { createDeferred } from "../../test/helpers/promise.js";
import { beginSessionEffect } from "./session-controller.lifecycle.js";

export function admissionGate() {
  const entered = createDeferred();
  const release = createDeferred();
  return {
    entered: entered.promise,
    release: release.resolve,
    wait: async () => {
      entered.resolve();
      await release.promise;
    },
  };
}

export const admitSession = (params: Parameters<typeof beginSessionEffect>[0]) =>
  beginSessionEffect({ assertAllowed: () => {}, ...params });

export function admissionTarget(scope: string, ...identities: (string | undefined)[]) {
  return { scope, identities };
}
