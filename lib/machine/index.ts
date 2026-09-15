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
  isBambuLanMqttEnabled,
  readBambuLanCredentials,
  resolveMachineAdapterId,
} from "./config";
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
