import { useCallback, useState } from "react";
import {
  Alert,
  PermissionsAndroid,
  Platform,
  ScrollView,
  View,
} from "react-native";
import { router, useFocusEffect } from "expo-router";
import { useNetInfo } from "@react-native-community/netinfo";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Text } from "@/components/ui/text";
import { Button } from "@/components/ui/button";
import { api } from "@/data/api";
import {
  disconnectAndroidAlertTransport,
  registerAndroidAlertTransport,
} from "@/data/android-alerts";
import {
  androidAlertEndpointOptions,
  androidAlertKeys,
} from "@/data/queries/android-alerts";
import { appConfigOptions } from "@/data/queries/billing";
import { useWorkspaceStore } from "@/data/workspace-store";
import {
  androidAlerts,
  type AndroidAlertState,
} from "@/modules/multica-android-alerts";
import { useT } from "@/lib/i18n";

export default function ConnectAndroidAlertsScreen() {
  const workspaceId = useWorkspaceStore((state) => state.currentWorkspaceId);
  const queryClient = useQueryClient();
  const network = useNetInfo();
  const { t: tCommon } = useT();
  const { t } = useT("settings");
  const [nativeState, setNativeState] = useState<AndroidAlertState>(
    androidAlerts.getState(),
  );
  const [isConnecting, setIsConnecting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const configQuery = useQuery(appConfigOptions());
  const endpointQuery = useQuery({
    ...androidAlertEndpointOptions(),
    enabled: configQuery.data?.android_push_available === true,
  });
  const connected =
    nativeState.endpoint_available &&
    endpointQuery.data?.some(
      (endpoint) =>
        endpoint.device_id === nativeState.device_id &&
        endpoint.status === "active",
    ) === true;

  useFocusEffect(
    useCallback(() => {
      setNativeState(androidAlerts.getState());
    }, []),
  );

  const connect = async () => {
    if (isConnecting || network.isConnected === false) return;
    setIsConnecting(true);
    setError(null);
    try {
      await registerAndroidAlertTransport();
      let granted = true;
      if (Platform.OS === "android" && Number(Platform.Version) >= 33) {
        const result = await PermissionsAndroid.request(
          PermissionsAndroid.PERMISSIONS.POST_NOTIFICATIONS,
        );
        granted = result === PermissionsAndroid.RESULTS.GRANTED;
      }
      if (granted) {
        await api.patchAndroidPushPreference({ enabled: true });
      }
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: androidAlertKeys.endpoints }),
        queryClient.invalidateQueries({
          queryKey: androidAlertKeys.preference(workspaceId),
        }),
      ]);
      setNativeState(androidAlerts.getState());
      router.back();
    } catch {
      setNativeState(androidAlerts.getState());
      setError(t("android_alerts.registration_failed"));
    } finally {
      setIsConnecting(false);
    }
  };

  const confirmDisconnect = () => {
    Alert.alert(
      t("android_alerts.disconnect_title"),
      t("android_alerts.disconnect_message"),
      [
        { text: tCommon("actions.cancel"), style: "cancel" },
        {
          text: t("android_alerts.disconnect"),
          style: "destructive",
          onPress: () => {
            void (async () => {
              setIsConnecting(true);
              try {
                await api
                  .patchAndroidPushPreference({ enabled: false })
                  .catch(() => undefined);
                await disconnectAndroidAlertTransport();
                await Promise.all([
                  queryClient.invalidateQueries({
                    queryKey: androidAlertKeys.endpoints,
                  }),
                  queryClient.invalidateQueries({
                    queryKey: androidAlertKeys.preference(workspaceId),
                  }),
                ]);
                router.back();
              } finally {
                setIsConnecting(false);
              }
            })();
          },
        },
      ],
    );
  };

  const serverAvailable = configQuery.data?.android_push_available === true;
  const offline = network.isConnected === false;

  return (
    <ScrollView
      className="flex-1 bg-background"
      contentContainerClassName="px-5 py-8 gap-6"
    >
      <View className="gap-3">
        <Text
          className="text-2xl font-semibold text-foreground"
          accessibilityRole="header"
        >
          {t("android_alerts.setup_title")}
        </Text>
        <Text className="text-sm leading-5 text-muted-foreground">
          {t("android_alerts.setup_body")}
        </Text>
        <Text className="text-sm font-medium leading-5 text-foreground">
          {t("android_alerts.prerequisite")}
        </Text>
      </View>

      {!serverAvailable ? (
        <Status text={t("android_alerts.server_unavailable")} destructive />
      ) : offline ? (
        <Status text={t("android_alerts.offline")} />
      ) : !nativeState.available && !connected ? (
        <Status text={t("android_alerts.distributor_missing")} destructive />
      ) : error ? (
        <Status text={error} destructive />
      ) : connected ? (
        <Status
          text={t("android_alerts.connected_via", {
            distributor: nativeState.distributor_name ?? "ntfy",
          })}
        />
      ) : null}

      {connected ? (
        <Button
          variant="destructive"
          className="min-h-12"
          disabled={isConnecting}
          onPress={confirmDisconnect}
        >
          <Text>{t("android_alerts.disconnect")}</Text>
        </Button>
      ) : nativeState.available ? (
        <Button
          className="min-h-12"
          disabled={isConnecting || offline || !serverAvailable}
          onPress={() => void connect()}
        >
          <Text>
            {isConnecting
              ? t("android_alerts.connecting")
              : t("android_alerts.continue")}
          </Text>
        </Button>
      ) : (
        <Button
          variant="outline"
          className="min-h-12"
          onPress={androidAlerts.openNtfy}
        >
          <Text>{t("android_alerts.install_ntfy")}</Text>
        </Button>
      )}
    </ScrollView>
  );
}

function Status({ text, destructive = false }: { text: string; destructive?: boolean }) {
  return (
    <View className="border-y border-border bg-card px-4 py-3">
      <Text
        className={
          destructive ? "text-sm text-destructive" : "text-sm text-foreground"
        }
        accessibilityLiveRegion="polite"
      >
        {text}
      </Text>
    </View>
  );
}
