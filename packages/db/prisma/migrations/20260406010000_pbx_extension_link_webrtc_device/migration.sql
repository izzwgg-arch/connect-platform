-- Add WebRTC device identity fields to PbxExtensionLink.
-- pbxDeviceName: the VitalPBX device_name (e.g. "T2_103_1") — unambiguous label for the admin UI.
-- webrtcEnabled: true when this extension has a device with the WebRTC profile assigned.
ALTER TABLE "PbxExtensionLink" ADD COLUMN "pbxDeviceName" TEXT;
ALTER TABLE "PbxExtensionLink" ADD COLUMN "webrtcEnabled" BOOLEAN NOT NULL DEFAULT false;
