import { Platform } from "react-native";
import { requireOptionalNativeModule } from "expo-modules-core";

export const ACTION_NEEDED_CHANNEL_ID = "multica_action_needed";
export const ACTIVITY_CHANNEL_ID = "multica_activity";

export interface AndroidAlertState {
  available: boolean;
  distributor_package: string | null;
  distributor_name: string | null;
  registration_status: "disconnected" | "registering" | "registered" | "failed";
  registration_failure: string | null;
  endpoint_available: boolean;
  device_id: string;
  permission: "granted" | "denied";
  app_notifications_enabled: boolean;
  action_channel_enabled: boolean;
  activity_channel_enabled: boolean;
  last_event_id: string | null;
  private_lock_screen: boolean;
}

export interface AndroidAlertRegistration {
  endpoint: string;
  p256dh: string;
  auth: string;
}

interface NativeAndroidAlerts {
  getState(): AndroidAlertState;
  registerWithNtfy(): Promise<void>;
  refreshRegistration(): Promise<boolean>;
  unregister(): Promise<void>;
  getRegistration(): AndroidAlertRegistration | null;
  getDeviceId(): string;
  createChannels(): void;
  setPrivateLockScreen(enabled: boolean): void;
  openAppNotificationSettings(): void;
  openChannelSettings(channelId: string): void;
  openNtfy(): void;
}

const native =
  Platform.OS === "android"
    ? requireOptionalNativeModule<NativeAndroidAlerts>("MulticaAndroidAlerts")
    : null;

const unavailableState: AndroidAlertState = {
  available: false,
  distributor_package: null,
  distributor_name: null,
  registration_status: "disconnected",
  registration_failure: null,
  endpoint_available: false,
  device_id: "",
  permission: "denied",
  app_notifications_enabled: false,
  action_channel_enabled: false,
  activity_channel_enabled: false,
  last_event_id: null,
  private_lock_screen: true,
};

export const androidAlerts = {
  isSupported: native != null,
  getState: (): AndroidAlertState => native?.getState() ?? unavailableState,
  registerWithNtfy: async (): Promise<void> => {
    if (!native) throw new Error("Android alerts require an Android development build");
    await native.registerWithNtfy();
  },
  refreshRegistration: async (): Promise<boolean> =>
    (await native?.refreshRegistration()) ?? false,
  unregister: async (): Promise<void> => {
    await native?.unregister();
  },
  getRegistration: (): AndroidAlertRegistration | null =>
    native?.getRegistration() ?? null,
  getDeviceId: (): string => native?.getDeviceId() ?? "",
  createChannels: (): void => native?.createChannels(),
  setPrivateLockScreen: (enabled: boolean): void =>
    native?.setPrivateLockScreen(enabled),
  openAppNotificationSettings: (): void =>
    native?.openAppNotificationSettings(),
  openChannelSettings: (channelId: string): void =>
    native?.openChannelSettings(channelId),
  openNtfy: (): void => native?.openNtfy(),
};
