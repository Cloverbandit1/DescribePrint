import "./mock";
import "./bambu-lan";

export type {
  AmsMapping,
  AmsMappingMatch,
  AmsSlotStatus,
  CommandResult,
  CommandRisk,
  ConnectionState,
  DesignFilament,
  FilamentPlan,
  LiveMachineStatus,
  MachineCredentials,
  MidPrintCommand,
  PrintState,
  RemainingLayerReshapePlan,
  ReshapeAction,
} from "./types";

export {
  createMachineAdapter,
  defaultAdapterId,
  emptyAmsSlots,
  listMachineAdapters,
  midPrintCommandRisk,
  registerMachineAdapter,
  RESERVED_BAMBU_LAN_ADAPTER_ID,
  validateLanCredentials,
  type MachineAdapter,
  type MachineAdapterFactory,
} from "./adapter";

export { MockMachineAdapter } from "./mock";
export { BambuLanMachineAdapter } from "./bambu-lan";
export {
  BAMBU_LAN_ADAPTER_ID,
  INCOMPLETE_LAN_HINT,
  isBambuLanMqttEnabled,
  machineLanHint,
  machineLanSource,
  readBambuLanCredentials,
  readLiveCredentials,
  resolveActiveAdapterId,
  resolveMachineAdapterId,
} from "./config";
export {
  credentialsComplete,
  getMachineUiSession,
  resetMachineUiSession,
  setMachineUiSession,
} from "./session";
export {
  MACHINE_LAN_STORAGE_KEY,
  defaultMachineLanPrefs,
  parseMachineLanPrefs,
  serializeMachineLanPrefs,
} from "./prefs";
export { parseMachineConfigure, commandFromBody } from "./api";
export {
  bambuTopics,
  buildBambuCommandPayload,
  buildPushAllRequest,
  parseBambuPrintReport,
  percentToBambuSpeedLevel,
  physicalStepsForCommand,
} from "./bambu-protocol";
export { redactSecrets, safeErrorMessage } from "./redact";
export { getSharedMachine, isLiveMachineSelected, resetSharedMachine } from "./runtime";
export { mapDesignFilamentsToAms } from "./ams";
export { planRemainingLayerReshape, type ReshapePlannerInput } from "./reshape";
