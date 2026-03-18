// Raw AMI frame: a map of key→value parsed from the text protocol.
export type AmiFrame = Record<string, string>;

// Subset of events we actively process. The raw event type string
// comes from the "Event" field in the AMI frame.
export type AmiEventName =
  | "FullyBooted"
  | "Newchannel"
  | "CoreShowChannel"
  | "Newstate"
  | "NewConnectedLine"
  | "DialBegin"
  | "DialEnd"
  | "BridgeEnter"
  | "BridgeLeave"
  | "Hangup"
  | "Cdr"
  | "QueueCallerJoin"
  | "QueueCallerLeave"
  | "QueueMemberStatus"
  | "QueueMemberPaused"
  | "ExtensionStatus"
  | "PeerStatus"
  | "ContactStatus"
  | "VarSet"
  | "AttendedTransfer"
  | "BlindTransfer";

// Typed wrappers for the events we care about most. We keep them
// as plain objects with string fields (AMI is always text).

export interface AmiNewchannel {
  event: "Newchannel";
  channel: string;
  uniqueid: string;
  linkedid: string;
  channelState: string;
  channelStateDesc: string;
  callerIDNum: string;
  callerIDName: string;
  connectedLineNum: string;
  connectedLineName: string;
  context: string;
  exten: string;
  priority: string;
}

export interface AmiNewstate {
  event: "Newstate";
  channel: string;
  uniqueid: string;
  linkedid: string;
  channelState: string;
  channelStateDesc: string;
  callerIDNum: string;
  callerIDName: string;
  connectedLineNum: string;
  connectedLineName: string;
  context: string;
  exten: string;
}

export interface AmiDialBegin {
  event: "DialBegin";
  channel: string;
  destination: string;
  callerIDNum: string;
  callerIDName: string;
  uniqueid: string;
  linkedid: string;
  destUniqueid: string;
  dialString: string;
}

export interface AmiDialEnd {
  event: "DialEnd";
  channel: string;
  destChannel: string;
  dialStatus: string;
  uniqueid: string;
  linkedid: string;
}

export interface AmiBridgeEnter {
  event: "BridgeEnter";
  bridgeUniqueid: string;
  bridgeNumChannels: string;
  bridgeType: string;
  channel: string;
  uniqueid: string;
  linkedid: string;
  callerIDNum: string;
  callerIDName: string;
  connectedLineNum: string;
  connectedLineName: string;
}

export interface AmiBridgeLeave {
  event: "BridgeLeave";
  bridgeUniqueid: string;
  channel: string;
  uniqueid: string;
  linkedid: string;
}

export interface AmiHangup {
  event: "Hangup";
  channel: string;
  uniqueid: string;
  linkedid: string;
  cause: string;
  causeTxt: string;
  callerIDNum: string;
  callerIDName: string;
  connectedLineNum: string;
  connectedLineName: string;
}

export interface AmiCdr {
  event: "Cdr";
  source: string;
  destination: string;
  dcontext: string;      // destination context — useful for direction inference
  accountCode: string;   // VitalPBX tenant account code
  channel: string;
  destChannel: string;
  uniqueid: string;
  linkedid: string;
  startTime: string;
  answerTime: string;
  endTime: string;
  duration: string;
  billableSeconds: string;
  disposition: string;
}

export interface AmiQueueCallerJoin {
  event: "QueueCallerJoin";
  channel: string;
  queue: string;
  position: string;
  callerIDNum: string;
  callerIDName: string;
  uniqueid: string;
  linkedid: string;
}

export interface AmiQueueCallerLeave {
  event: "QueueCallerLeave";
  channel: string;
  queue: string;
  position: string;
  uniqueid: string;
  linkedid: string;
}

export interface AmiQueueMemberStatus {
  event: "QueueMemberStatus";
  queue: string;
  memberName: string;
  interface: string;
  membership: string;
  status: string;
  paused: string;
  pausedReason: string;
  callsTaken: string;
  lastCall: string;
  inCall: string;
}

export interface AmiQueueMemberPaused {
  event: "QueueMemberPaused";
  queue: string;
  memberName: string;
  interface: string;
  paused: string;
  pausedReason: string;
}

export interface AmiExtensionStatus {
  event: "ExtensionStatus";
  exten: string;
  context: string;
  hint: string;
  status: string;
  statusText: string;
}

export interface AmiPeerStatus {
  event: "PeerStatus";
  channelType: string;
  peer: string;
  peerStatus: string;
  cause: string;
  address: string;
  port: string;
  time: string;
}

export interface AmiContactStatus {
  event: "ContactStatus";
  uri: string;
  contactStatus: string;
  aor: string;
  userAgent: string;
  roundtripUsec: string;
}

export interface AmiAttendedTransfer {
  event: "AttendedTransfer";
  origTransfererChannel: string;
  origTransfererLinkedid: string;
  secondTransfererChannel: string;
  secondTransfererLinkedid: string;
  transfereeChannel: string;
  transfereeLinkedid: string;
  result: string;
}

export interface AmiBlindTransfer {
  event: "BlindTransfer";
  transfererChannel: string;
  transfererLinkedid: string;
  transfereeChannel: string;
  transfereeLinkedid: string;
  context: string;
  extension: string;
  result: string;
}

// CoreShowChannel — response to CoreShowChannels action; one per active channel.
// Structurally identical to Newchannel but uses UniqueID/LinkedID (capital) in some
// Asterisk builds. Mapper handles both spellings via fallback.
export interface AmiCoreShowChannel {
  event: "CoreShowChannel";
  channel: string;
  uniqueid: string;
  linkedid: string;
  channelState: string;
  channelStateDesc: string;
  callerIDNum: string;
  callerIDName: string;
  connectedLineNum: string;
  connectedLineName: string;
  context: string;
  exten: string;
  priority: string;
}

// Union of all typed AMI events
export type TypedAmiEvent =
  | AmiCoreShowChannel
  | AmiNewchannel
  | AmiNewstate
  | AmiDialBegin
  | AmiDialEnd
  | AmiBridgeEnter
  | AmiBridgeLeave
  | AmiHangup
  | AmiCdr
  | AmiQueueCallerJoin
  | AmiQueueCallerLeave
  | AmiQueueMemberStatus
  | AmiQueueMemberPaused
  | AmiExtensionStatus
  | AmiPeerStatus
  | AmiContactStatus
  | AmiAttendedTransfer
  | AmiBlindTransfer;
