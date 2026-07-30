import ExpoModulesCore

// Installs the Connect VoIP PushKit handler at app launch — the SDK 54
// replacement for the old AppDelegate.mm string patch (see ConnectVoipPushHandler.mm).
//
// The handler class is looked up via the ObjC runtime instead of a Swift
// bridging import so this pod needs no cross-language header plumbing; the
// class is compiled into the same pod and is always present. If the lookup
// ever fails we log loudly — a silent no-op here means a fully cold-killed
// iPhone will not ring.
public class ConnectVoipAppDelegateSubscriber: NSObject, ExpoAppDelegateSubscriber {
  public func application(
    _ application: UIApplication,
    didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil
  ) -> Bool {
    if let cls = NSClassFromString("ConnectVoipPushHandler") as? NSObject.Type {
      _ = cls.perform(NSSelectorFromString("install"))
    } else {
      NSLog("[CONNECT_VOIP] FATAL: ConnectVoipPushHandler class not found — PushKit NOT wired, cold-killed calls will not ring")
    }
    return true
  }
}
