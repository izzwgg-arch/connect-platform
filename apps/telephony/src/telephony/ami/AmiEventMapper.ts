import type { AmiFrame } from "./AmiTypes";
import type {
  AmiCoreShowChannel,
  AmiNewchannel,
  AmiNewstate,
  AmiDialBegin,
  AmiDialEnd,
  AmiBridgeEnter,
  AmiBridgeLeave,
  AmiHangup,
  AmiCdr,
  AmiQueueCallerJoin,
  AmiQueueCallerLeave,
  AmiQueueMemberStatus,
  AmiQueueMemberPaused,
  AmiExtensionStatus,
  AmiPeerStatus,
  AmiContactStatus,
  AmiAttendedTransfer,
  AmiBlindTransfer,
  AmiMessageWaiting,
  TypedAmiEvent,
} from "./AmiTypes";

// Maps a raw AmiFrame to a typed event object, or null if the event
// is not one we handle or the frame is malformed.
export function mapAmiFrame(frame: AmiFrame): TypedAmiEvent | null {
  const event = frame["Event"];
  if (!event) return null;

  const g = (key: string) => frame[key] ?? "";

  switch (event) {
    case "Newchannel":
      return {
        event: "Newchannel",
        channel: g("Channel"),
        uniqueid: g("Uniqueid"),
        linkedid: g("Linkedid"),
        channelState: g("ChannelState"),
        channelStateDesc: g("ChannelStateDesc"),
        callerIDNum: g("CallerIDNum"),
        callerIDName: g("CallerIDName"),
        connectedLineNum: g("ConnectedLineNum"),
        connectedLineName: g("ConnectedLineName"),
        context: g("Context"),
        exten: g("Exten"),
        priority: g("Priority"),
      } satisfies AmiNewchannel;

    // CoreShowChannel is the response to the CoreShowChannels bootstrap action.
    // Asterisk may use UniqueID / LinkedID (capital) so we fall back.
    case "CoreShowChannel":
      return {
        event: "CoreShowChannel",
        channel: g("Channel"),
        uniqueid: g("Uniqueid") || g("UniqueID"),
        linkedid: g("Linkedid") || g("LinkedID"),
        channelState: g("ChannelState"),
        channelStateDesc: g("ChannelStateDesc"),
        callerIDNum: g("CallerIDNum"),
        callerIDName: g("CallerIDName"),
        connectedLineNum: g("ConnectedLineNum"),
        connectedLineName: g("ConnectedLineName"),
        context: g("Context"),
        exten: g("Exten"),
        priority: g("Priority"),
      } satisfies AmiCoreShowChannel;

    case "Newstate":
      return {
        event: "Newstate",
        channel: g("Channel"),
        uniqueid: g("Uniqueid"),
        linkedid: g("Linkedid"),
        channelState: g("ChannelState"),
        channelStateDesc: g("ChannelStateDesc"),
        callerIDNum: g("CallerIDNum"),
        callerIDName: g("CallerIDName"),
        connectedLineNum: g("ConnectedLineNum"),
        connectedLineName: g("ConnectedLineName"),
        context: g("Context"),
        exten: g("Exten"),
      } satisfies AmiNewstate;

    case "DialBegin":
      return {
        event: "DialBegin",
        channel: g("Channel"),
        destination: g("Destination"),
        callerIDNum: g("CallerIDNum"),
        callerIDName: g("CallerIDName"),
        uniqueid: g("Uniqueid"),
        linkedid: g("Linkedid"),
        destUniqueid: g("DestUniqueid"),
        dialString: g("DialString"),
      } satisfies AmiDialBegin;

    case "DialEnd":
      return {
        event: "DialEnd",
        channel: g("Channel"),
        destChannel: g("DestChannel"),
        dialStatus: g("DialStatus"),
        uniqueid: g("Uniqueid"),
        linkedid: g("Linkedid"),
      } satisfies AmiDialEnd;

    case "BridgeEnter":
      return {
        event: "BridgeEnter",
        bridgeUniqueid: g("BridgeUniqueid"),
        bridgeNumChannels: g("BridgeNumChannels"),
        bridgeType: g("BridgeType"),
        channel: g("Channel"),
        uniqueid: g("Uniqueid"),
        linkedid: g("Linkedid"),
        callerIDNum: g("CallerIDNum"),
        callerIDName: g("CallerIDName"),
        connectedLineNum: g("ConnectedLineNum"),
        connectedLineName: g("ConnectedLineName"),
      } satisfies AmiBridgeEnter;

    case "BridgeLeave":
      return {
        event: "BridgeLeave",
        bridgeUniqueid: g("BridgeUniqueid"),
        channel: g("Channel"),
        uniqueid: g("Uniqueid"),
        linkedid: g("Linkedid"),
      } satisfies AmiBridgeLeave;

    case "Hangup":
      return {
        event: "Hangup",
        channel: g("Channel"),
        uniqueid: g("Uniqueid"),
        linkedid: g("Linkedid"),
        cause: g("Cause"),
        causeTxt: g("Cause-txt"),
        callerIDNum: g("CallerIDNum"),
        callerIDName: g("CallerIDName"),
        connectedLineNum: g("ConnectedLineNum"),
        connectedLineName: g("ConnectedLineName"),
      } satisfies AmiHangup;

    case "Cdr":
      return {
        event: "Cdr",
        source: g("Source"),
        destination: g("Destination"),
        dcontext: g("Dcontext"),
        accountCode: g("AccountCode"),
        channel: g("Channel"),
        destChannel: g("DestinationChannel"),
        uniqueid: g("UniqueID"),
        linkedid: g("LinkedID"),
        startTime: g("StartTime"),
        answerTime: g("AnswerTime"),
        endTime: g("EndTime"),
        duration: g("Duration"),
        billableSeconds: g("BillableSeconds"),
        disposition: g("Disposition"),
      } satisfies AmiCdr;

    case "QueueCallerJoin":
      return {
        event: "QueueCallerJoin",
        channel: g("Channel"),
        queue: g("Queue"),
        position: g("Position"),
        callerIDNum: g("CallerIDNum"),
        callerIDName: g("CallerIDName"),
        uniqueid: g("Uniqueid"),
        linkedid: g("Linkedid"),
      } satisfies AmiQueueCallerJoin;

    case "QueueCallerLeave":
      return {
        event: "QueueCallerLeave",
        channel: g("Channel"),
        queue: g("Queue"),
        position: g("Position"),
        uniqueid: g("Uniqueid"),
        linkedid: g("Linkedid"),
      } satisfies AmiQueueCallerLeave;

    case "QueueMemberStatus":
      return {
        event: "QueueMemberStatus",
        queue: g("Queue"),
        memberName: g("MemberName"),
        interface: g("Interface"),
        membership: g("Membership"),
        status: g("Status"),
        paused: g("Paused"),
        pausedReason: g("PausedReason"),
        callsTaken: g("CallsTaken"),
        lastCall: g("LastCall"),
        inCall: g("InCall"),
      } satisfies AmiQueueMemberStatus;

    case "QueueMemberPaused":
      return {
        event: "QueueMemberPaused",
        queue: g("Queue"),
        memberName: g("MemberName"),
        interface: g("Interface"),
        paused: g("Paused"),
        pausedReason: g("PausedReason"),
      } satisfies AmiQueueMemberPaused;

    case "ExtensionStatus":
      return {
        event: "ExtensionStatus",
        exten: g("Exten"),
        context: g("Context"),
        hint: g("Hint"),
        status: g("Status"),
        statusText: g("StatusText"),
      } satisfies AmiExtensionStatus;

    case "PeerStatus":
      return {
        event: "PeerStatus",
        channelType: g("ChannelType"),
        peer: g("Peer"),
        peerStatus: g("PeerStatus"),
        cause: g("Cause"),
        address: g("Address"),
        port: g("Port"),
        time: g("Time"),
      } satisfies AmiPeerStatus;

    case "ContactStatus":
      return {
        event: "ContactStatus",
        uri: g("URI"),
        contactStatus: g("ContactStatus"),
        aor: g("AOR"),
        userAgent: g("UserAgent"),
        roundtripUsec: g("RoundtripUsec"),
      } satisfies AmiContactStatus;

    case "AttendedTransfer":
      return {
        event: "AttendedTransfer",
        origTransfererChannel: g("OrigTransfererChannel"),
        origTransfererLinkedid: g("OrigTransfererLinkedid"),
        secondTransfererChannel: g("SecondTransfererChannel"),
        secondTransfererLinkedid: g("SecondTransfererLinkedid"),
        transfereeChannel: g("TransfereeChannel"),
        transfereeLinkedid: g("TransfereeLinkedid"),
        result: g("Result"),
      } satisfies AmiAttendedTransfer;

    case "BlindTransfer":
      return {
        event: "BlindTransfer",
        transfererChannel: g("TransfererChannel"),
        transfererLinkedid: g("TransfererLinkedid"),
        transfereeChannel: g("TransfereeChannel"),
        transfereeLinkedid: g("TransfereeLinkedid"),
        context: g("Context"),
        extension: g("Extension"),
        result: g("Result"),
      } satisfies AmiBlindTransfer;

    case "MessageWaiting":
      return {
        event: "MessageWaiting",
        mailbox: g("Mailbox"),
        waiting: g("Waiting"),
        new: g("New"),
        old: g("Old"),
      } satisfies AmiMessageWaiting;

    default:
      return null;
  }
}
