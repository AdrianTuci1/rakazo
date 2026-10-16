import { ManagedSandboxEmulator } from "./e2b-emulator.js";

/** Modal computer without a Modal account, for offline development and conformance runs. */
export class ModalSandboxEmulator extends ManagedSandboxEmulator {
  constructor() {
    super({ id: "modal-emulator", kind: "modal" });
  }
}
