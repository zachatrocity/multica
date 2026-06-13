import { useEffect } from "react";
import { Platform } from "react-native";
import Constants from "expo-constants";
import * as Notifications from "expo-notifications";
import * as SecureStore from "expo-secure-store";
import { router } from "expo-router";
import { useQueryClient } from "@tanstack/react-query";
import { api } from "@/data/api";
import { inboxKeys } from "@/data/queries/inbox";
import { useWorkspaceStore } from "@/data/workspace-store";

const SUBSCRIPTION_ID_KEY = "multica_mobile_push_subscription_id";

Notifications.setNotificationHandler({
  handleNotification: async () => ({
    shouldShowAlert: false,
    shouldShowBanner: false,
    shouldShowList: false,
    shouldPlaySound: false,
    shouldSetBadge: false,
  }),
});

function getExpoProjectId(): string | null {
  const constants = Constants as unknown as {
    easConfig?: { projectId?: string };
    expoConfig?: { extra?: { eas?: { projectId?: string } } };
  };
  return (
    constants.easConfig?.projectId ??
    constants.expoConfig?.extra?.eas?.projectId ??
    null
  );
}

function getAppVariant(): string {
  const constants = Constants as unknown as {
    expoConfig?: { extra?: { APP_ENV?: string } };
  };
  return constants.expoConfig?.extra?.APP_ENV ?? "development";
}

export async function registerExpoPushSubscription(): Promise<string | null> {
  if (Platform.OS === "android") {
    await Notifications.setNotificationChannelAsync("default", {
      name: "Default",
      importance: Notifications.AndroidImportance.DEFAULT,
    });
  }

  const current = await Notifications.getPermissionsAsync();
  const finalStatus =
    current.status === "granted"
      ? current.status
      : (await Notifications.requestPermissionsAsync()).status;
  if (finalStatus !== "granted") {
    return null;
  }

  const projectId = getExpoProjectId();
  if (!projectId) {
    throw new Error("EXPO_EAS_PROJECT_ID is required for Expo push tokens");
  }

  const token = await Notifications.getExpoPushTokenAsync({ projectId });
  const sub = await api.registerMobilePushSubscription({
    provider: "expo",
    token: token.data,
    device_name: Platform.OS === "android" ? "Android device" : "iOS device",
    app_variant: getAppVariant(),
  });

  if (sub.id) {
    await SecureStore.setItemAsync(SUBSCRIPTION_ID_KEY, sub.id);
    return sub.id;
  }
  return null;
}

export async function deleteStoredMobilePushSubscription(): Promise<void> {
  const id = await SecureStore.getItemAsync(SUBSCRIPTION_ID_KEY);
  if (!id) return;

  try {
    await api.deleteMobilePushSubscription(id);
  } finally {
    await SecureStore.deleteItemAsync(SUBSCRIPTION_ID_KEY);
  }
}

type PushData = {
  workspace_slug?: unknown;
  issue_id?: unknown;
};

function routeFromPushData(data: PushData): string | null {
  const workspaceSlug =
    typeof data.workspace_slug === "string" ? data.workspace_slug : null;
  if (!workspaceSlug) return null;

  const issueId = typeof data.issue_id === "string" ? data.issue_id : null;
  if (issueId) return `/${workspaceSlug}/issue/${issueId}`;
  return `/${workspaceSlug}/inbox`;
}

export function useMobilePushNotifications() {
  const qc = useQueryClient();
  const wsId = useWorkspaceStore((s) => s.currentWorkspaceId);

  useEffect(() => {
    const receivedSub = Notifications.addNotificationReceivedListener(() => {
      if (wsId) {
        qc.invalidateQueries({ queryKey: inboxKeys.list(wsId) });
      }
    });
    const responseSub = Notifications.addNotificationResponseReceivedListener(
      (response) => {
        const route = routeFromPushData(
          response.notification.request.content.data as PushData,
        );
        if (route) router.push(route);
      },
    );

    return () => {
      receivedSub.remove();
      responseSub.remove();
    };
  }, [qc, wsId]);
}
