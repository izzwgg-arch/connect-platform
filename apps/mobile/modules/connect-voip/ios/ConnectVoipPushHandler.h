#import <Foundation/Foundation.h>
#import <PushKit/PushKit.h>

NS_ASSUME_NONNULL_BEGIN

/// Owns the app's PKPushRegistry and implements the full Connect VoIP push
/// contract (see ConnectVoipPushHandler.mm for the behavior history).
/// Installed once at launch by ConnectVoipAppDelegateSubscriber.
@interface ConnectVoipPushHandler : NSObject <PKPushRegistryDelegate>

/// Idempotent: creates the singleton, registers for VoIP pushes with this
/// object as the delegate, and installs the in-call audio-mode guardian.
+ (void)install;

@end

NS_ASSUME_NONNULL_END
