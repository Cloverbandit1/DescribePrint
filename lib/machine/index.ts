import "./mock";
import "./bambu-lan";

export type {
  AmsHint,
  AmsHintKind,
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
export {
  commandFromBody,
  parseMachineConfigure,
  parsePrintDoctorBody,
  parseReshapeRemainingFromBody,
  parseReshapeRemainingFromRequest,
} from "./api";
export {
  AMS_FEED_LOOP_SENTINEL,
  amsFeedLoopPhysicalSteps,
  amsHintFromReport,
  detectsAmsFeedLoop,
  isAmsAutofixEnabled,
  isAmsPrintError,
  maybeAutofixAmsFeedLoop,
  trayIndexToSlot,
  type AmsAutofixResult,
} from "./ams-autofix";
export {
  MACHINE_CAMERA_STORAGE_KEY,
  cameraDetectCallCount,
  cameraStatusLine,
  currentStubCameraFrame,
  detectFailure,
  futureLanJpegUrl,
  injectStubCameraScene,
  isCameraDetectEnabled,
  isCameraStubEnabled,
  machineMonitorPollPath,
  maybeDetectFailure,
  mockCameraFrame,
  parseCameraStubPref,
  resetCameraDetectState,
  serializeCameraStubPref,
  toCameraDetectReport,
  type CameraDetectReport,
  type CameraFailureKind,
  type CameraFrame,
  type FailureDetection,
} from "./camera";
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
export {
  MACHINE_RESHAPE_STORAGE_KEY,
  isReshapeRemainingActive,
  isReshapeRemainingEnabled,
  maybeEmergencyReshapeRemaining,
  parseReshapeRemainingPref,
  peekLastReshapePlan,
  planRemainingLayerReshape,
  rememberReshapePlan,
  resetReshapeState,
  resolveCurrentZ,
  serializeReshapeRemainingPref,
  RESUME_IS_MANUAL,
  RESHAPE_LATER_OPTION,
  type ReshapePlannerInput,
  type CadReshapeHandoff,
  type EmergencyRemainingReshapePlan,
  type ReslicePlanStub,
  type StumpCutPlaneBoundsMm,
} from "./reshape";
export {
  CAD_RESHAPE_INSTRUCTION,
  buildCadReshapeHandoff,
  buildReslicePlanStub,
  isStumpCutPlaneBoundsMm,
} from "./reshape-plan";
