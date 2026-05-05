export type DesktopWindowKind = "full" | "mini" | "phone-engine";

export type DesktopSettings = {
  alwaysOnTop: boolean;
  startOnLogin: boolean;
  openMinimizedToTray: boolean;
  openMiniOnStartup: boolean;
  minimizeToTray: boolean;
  miniBounds: {
    width: number;
    height: number;
    x?: number;
    y?: number;
  };
};

export type PhoneEngineEnvelope =
  | {
      type: "state";
      payload: unknown;
    }
  | {
      type: "event";
      event: string;
      payload?: unknown;
    };

export type PhoneEngineCommand = {
  command: string;
  args: unknown[];
};
