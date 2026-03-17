// ARI REST + WebSocket type stubs.
// ARI is used only for call-control actions, not for primary monitoring.

export interface AriChannel {
  id: string;
  name: string;
  state: string;
  caller: { name: string; number: string };
  connected: { name: string; number: string };
  accountcode: string;
  dialplan: { context: string; exten: string; priority: number };
  creationtime: string;
  language: string;
}

export interface AriBridge {
  id: string;
  technology: string;
  bridge_type: string;
  bridge_class: string;
  creator: string;
  name: string;
  channels: string[];
  creationtime: string;
}

export interface AriEndpoint {
  technology: string;
  resource: string;
  state: string;
  channel_ids: string[];
}

// Raw ARI WebSocket event — shape varies by event type
export interface AriWsEvent {
  type: string;
  timestamp?: string;
  asterisk_id?: string;
  application?: string;
  channel?: AriChannel;
  bridge?: AriBridge;
  [key: string]: unknown;
}

export interface AriOriginateParams {
  endpoint: string;
  extension?: string;
  context?: string;
  priority?: number;
  callerId?: string;
  timeout?: number;
  variables?: Record<string, string>;
  app?: string;
  appArgs?: string;
}
