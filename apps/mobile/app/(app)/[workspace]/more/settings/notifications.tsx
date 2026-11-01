import { useCallback, useState } from "react";
import {
  ActivityIndicator,
  AppState,
  Platform,
  Pressable,
  ScrollView,
  View,
  type AppStateStatus,
} from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { router, useFocusEffect } from "expo-router";
import { useNetInfo } from "@react-native-community/netinfo";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type {
  NotificationGroupKey,
  NotificationPreferences,
} from "@multica/core/types";
import type {
  AndroidPushPreference,
} from "@/data/schemas";
import { Text } from "@/components/ui/text";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { Separator } from "@/components/ui/separator";
import { api, type AndroidPushPreferencePatch } from "@/data/api";
import { useWorkspaceStore } from "@/data/workspace-store";
import { notificationPreferenceOptions } from "@/data/queries/notification-preferences";
import { useUpdateNotificationPreferences } from "@/data/mutations/notification-preferences";
import {
  androidAlertEndpointOptions,
  androidAlertKeys,
  androidAlertPreferenceOptions,
} from "@/data/queries/android-alerts";
import { appConfigOptions } from "@/data/queries/billing";
import {
  ACTION_NEEDED_CHANNEL_ID,
  ACTIVITY_CHANNEL_ID,
  androidAlerts,
  type AndroidAlertState,
} from "@/modules/multica-android-alerts";
import { useT } from "@/lib/i18n";
import { useColorScheme } from "@/lib/use-color-scheme";
import { THEME } from "@/lib/theme";

const INBOX_GROUPS: {
  key: Exclude<NotificationGroupKey, "system_notifications">;
  labelKey: string;
  descriptionKey?: string;
}[] = [
  { key: "assignments", labelKey: "groups.assignments", descriptionKey: "groups.assignments_description" },
  { key: "status_changes", labelKey: "groups.status_changes" },
  { key: "comments", labelKey: "groups.comments", descriptionKey: "groups.comments_description" },
  { key: "mentions", labelKey: "groups.mentions", descriptionKey: "groups.mentions_description" },
  { key: "updates", labelKey: "groups.updates", descriptionKey: "groups.updates_description" },
  { key: "agent_activity", labelKey: "groups.agent_activity", descriptionKey: "groups.agent_activity_description" },
];

const ANDROID_CATEGORIES: {
  key: keyof AndroidPushPreferencePatch;
  labelKey: string;
  descriptionKey: string;
}[] = [
  { key: "mentions", labelKey: "android_alerts.mentions", descriptionKey: "android_alerts.mentions_description" },
  { key: "assignments", labelKey: "android_alerts.assignments", descriptionKey: "android_alerts.assignments_description" },
  { key: "review_blockers", labelKey: "android_alerts.review_blockers", descriptionKey: "android_alerts.review_blockers_description" },
  { key: "comments", labelKey: "android_alerts.comments", descriptionKey: "android_alerts.comments_description" },
  { key: "routine_updates", labelKey: "android_alerts.routine_updates", descriptionKey: "android_alerts.routine_updates_description" },
];

const EMPTY_ANDROID_PREFERENCE: AndroidPushPreference = {
  workspace_id: "",
  enabled: false,
  mentions: true,
  assignments: true,
  review_blockers: true,
  comments: false,
  routine_updates: false,
};

export default function NotificationsSettingsScreen() {
  const workspaceId = useWorkspaceStore((state) => state.currentWorkspaceId);
  const workspaceSlug = useWorkspaceStore((state) => state.currentWorkspaceSlug);
  const queryClient = useQueryClient();
  const network = useNetInfo();
  const { colorScheme } = useColorScheme();
  const iconColor = THEME[colorScheme].mutedForeground;
  const { t } = useT("settings");
  const [nativeState, setNativeState] = useState<AndroidAlertState>(
    androidAlerts.getState(),
  );
  const [testState, setTestState] = useState<
    "idle" | "sending" | "received" | "timeout" | "failed"
  >("idle");

  const inboxQuery = useQuery(notificationPreferenceOptions(workspaceId));
  const configQuery = useQuery(appConfigOptions());
  const serverAvailable = configQuery.data?.android_push_available === true;
  const endpointQuery = useQuery({
    ...androidAlertEndpointOptions(),
    enabled: Platform.OS === "android" && serverAvailable,
  });
  const androidPreferenceQuery = useQuery({
    ...androidAlertPreferenceOptions(workspaceId),
    enabled: Platform.OS === "android" && serverAvailable && !!workspaceId,
  });

  const refreshNativeState = useCallback(() => {
    setNativeState(androidAlerts.getState());
    void queryClient.invalidateQueries({ queryKey: androidAlertKeys.endpoints });
    void queryClient.invalidateQueries({
      queryKey: androidAlertKeys.preference(workspaceId),
    });
  }, [queryClient, workspaceId]);

  useFocusEffect(
    useCallback(() => {
      refreshNativeState();
      const subscription = AppState.addEventListener(
        "change",
        (status: AppStateStatus) => {
          if (status === "active") refreshNativeState();
        },
      );
      return () => subscription.remove();
    }, [refreshNativeState]),
  );

  const preferenceMutation = useMutation({
    mutationFn: (patch: AndroidPushPreferencePatch) =>
      api.patchAndroidPushPreference(patch),
    onSuccess: (preference) => {
      queryClient.setQueryData(
        androidAlertKeys.preference(workspaceId),
        preference,
      );
    },
  });
  const inboxMutation = useUpdateNotificationPreferences();

  const storedPreference =
    androidPreferenceQuery.data ?? EMPTY_ANDROID_PREFERENCE;
  const androidPreference = preferenceMutation.isPending
    ? { ...storedPreference, ...preferenceMutation.variables }
    : storedPreference;
  const inboxPreferences: NotificationPreferences =
    inboxQuery.data?.preferences ?? {};
  const currentEndpoint = endpointQuery.data?.find(
    (endpoint) => endpoint.device_id === nativeState.device_id,
  );
  const connected =
    nativeState.endpoint_available && currentEndpoint?.status === "active";
  const connectionFailed =
    nativeState.registration_status === "failed" ||
    currentEndpoint?.status === "quarantined";
  const isOffline = network.isConnected === false;
  const serverError =
    !isOffline &&
    (endpointQuery.isError ||
      androidPreferenceQuery.isError ||
      preferenceMutation.isError);


  const patchAndroidPreference = (patch: AndroidPushPreferencePatch) => {
    if (isOffline || preferenceMutation.isPending) return;
    preferenceMutation.mutate(patch);
  };

  const onWorkspaceAlertsToggle = (enabled: boolean) => {
    if (!enabled) {
      patchAndroidPreference({ enabled: false });
      return;
    }
    if (!connected) {
      router.push(`/${workspaceSlug}/more/settings/notifications/connect`);
      return;
    }
    if (
      nativeState.permission !== "granted" ||
      !nativeState.app_notifications_enabled
    ) {
      androidAlerts.openAppNotificationSettings();
      return;
    }
    patchAndroidPreference({ enabled: true });
  };

  const onInboxToggle = (key: NotificationGroupKey, enabled: boolean) => {
    const next: NotificationPreferences = { ...inboxPreferences };
    if (enabled) delete next[key];
    else next[key] = "muted";
    inboxMutation.mutate(next);
  };

  const sendTest = async () => {
    if (!connected || testState === "sending") return;
    setTestState("sending");
    try {
      const result = await api.sendAndroidPushTest(nativeState.device_id);
      if (!result.event_id) throw new Error("Missing test event id");
      const deadline = Date.now() + 30_000;
      while (Date.now() < deadline) {
        if (androidAlerts.getState().last_event_id === result.event_id) {
          setTestState("received");
          return;
        }
        await new Promise<void>((resolve) => setTimeout(resolve, 250));
      }
      setTestState("timeout");
    } catch {
      setTestState("failed");
    }
  };

  if (inboxQuery.isLoading || configQuery.isLoading) {
    return (
      <View className="flex-1 items-center justify-center bg-background">
        <ActivityIndicator />
      </View>
    );
  }

  return (
    <ScrollView
      className="flex-1 bg-background"
      contentContainerClassName="pb-8"
    >
      <Section title={t("android_alerts.section_title")}>
        {Platform.OS !== "android" || !androidAlerts.isSupported ? (
          <InfoRow text={t("android_alerts.android_only")} />
        ) : !serverAvailable ? (
          <Banner
            tone="warning"
            title={t("android_alerts.server_unavailable")}
          />
        ) : (
          <>
            {isOffline ? (
              <Banner tone="neutral" title={t("android_alerts.offline")} />
            ) : null}
            {serverError ? (
              <Banner
                tone="destructive"
                title={t("android_alerts.server_error")}
              />
            ) : null}
            {!nativeState.available && !connected ? (
              <Banner
                tone="warning"
                title={t("android_alerts.distributor_missing")}
                action={t("android_alerts.install_ntfy")}
                onAction={androidAlerts.openNtfy}
              />
            ) : null}
            {connectionFailed ? (
              <Banner
                tone="destructive"
                title={
                  currentEndpoint?.status === "quarantined"
                    ? t("android_alerts.authorization_failed")
                    : t("android_alerts.registration_failed")
                }
                action={t("android_alerts.set_up")}
                onAction={() =>
                  router.push(
                    `/${workspaceSlug}/more/settings/notifications/connect`,
                  )
                }
              />
            ) : null}
            {connected &&
            (nativeState.permission !== "granted" ||
              !nativeState.app_notifications_enabled) ? (
              <Banner
                tone="warning"
                title={t("android_alerts.permission_off")}
                description={t("android_alerts.permission_description")}
                action={t("android_alerts.open_settings")}
                onAction={androidAlerts.openAppNotificationSettings}
              />
            ) : null}
            {connected && !nativeState.action_channel_enabled ? (
              <Banner
                tone="warning"
                title={t("android_alerts.action_channel_off")}
                action={t("android_alerts.open_channel")}
                onAction={() =>
                  androidAlerts.openChannelSettings(ACTION_NEEDED_CHANNEL_ID)
                }
              />
            ) : null}
            {connected && !nativeState.activity_channel_enabled ? (
              <Banner
                tone="warning"
                title={t("android_alerts.activity_channel_off")}
                action={t("android_alerts.open_channel")}
                onAction={() =>
                  androidAlerts.openChannelSettings(ACTIVITY_CHANNEL_ID)
                }
              />
            ) : null}
            <PreferenceRow
              title={t("android_alerts.workspace_alerts")}
              description={t("android_alerts.workspace_description")}
              checked={androidPreference.enabled}
              disabled={isOffline || preferenceMutation.isPending}
              onCheckedChange={onWorkspaceAlertsToggle}
            />
            <Separator />
            <NavigationRow
              title={t("android_alerts.connection")}
              description={
                connected
                  ? t("android_alerts.connected_via", {
                      distributor:
                        nativeState.distributor_name ?? "ntfy",
                    })
                  : t("android_alerts.not_connected")
              }
              action={
                connected
                  ? t("android_alerts.manage")
                  : t("android_alerts.set_up")
              }
              iconColor={iconColor}
              onPress={() =>
                router.push(
                  `/${workspaceSlug}/more/settings/notifications/connect`,
                )
              }
            />
          </>
        )}
      </Section>

      {Platform.OS === "android" && serverAvailable ? (
        <Section title={t("android_alerts.alert_me_for")}>
          {ANDROID_CATEGORIES.map((category, index) => (
            <View key={category.key}>
              <PreferenceRow
                title={t(category.labelKey)}
                description={t(category.descriptionKey)}
                checked={Boolean(androidPreference[category.key])}
                disabled={
                  !connected ||
                  !androidPreference.enabled ||
                  isOffline ||
                  preferenceMutation.isPending
                }
                onCheckedChange={(checked) =>
                  patchAndroidPreference({ [category.key]: checked })
                }
              />
              {index < ANDROID_CATEGORIES.length - 1 ? <Separator /> : null}
            </View>
          ))}
        </Section>
      ) : null}

      <Section title={t("groups.inbox_notifications")}>
        {inboxQuery.error ? (
          <InfoRow text={t("errors.load_failed")} destructive />
        ) : (
          INBOX_GROUPS.map((group, index) => (
            <View key={group.key}>
              <PreferenceRow
                title={t(group.labelKey)}
                description={
                  group.descriptionKey ? t(group.descriptionKey) : undefined
                }
                checked={inboxPreferences[group.key] !== "muted"}
                disabled={inboxMutation.isPending}
                onCheckedChange={(checked) =>
                  onInboxToggle(group.key, checked)
                }
              />
              {index < INBOX_GROUPS.length - 1 ? <Separator /> : null}
            </View>
          ))
        )}
      </Section>

      <Section title={t("android_alerts.account_product")}>
        <PreferenceRow
          title={t("groups.system_notifications")}
          description={t("groups.system_description")}
          checked={inboxPreferences.system_notifications !== "muted"}
          disabled={inboxMutation.isPending}
          onCheckedChange={(checked) =>
            onInboxToggle("system_notifications", checked)
          }
        />
      </Section>

      {Platform.OS === "android" && serverAvailable && connected ? (
        <Section title={t("android_alerts.android_controls")}>
          <NavigationRow
            title={t("android_alerts.sound_importance")}
            description={t("android_alerts.sound_importance_description")}
            action={t("android_alerts.open_settings")}
            iconColor={iconColor}
            onPress={androidAlerts.openAppNotificationSettings}
          />
          <Separator />
          <PreferenceRow
            title={t("android_alerts.lock_screen")}
            description={t("android_alerts.lock_screen_description")}
            checked={nativeState.private_lock_screen}
            onCheckedChange={(checked) => {
              androidAlerts.setPrivateLockScreen(checked);
              setNativeState(androidAlerts.getState());
            }}
          />
          <Separator />
          <View className="px-4 py-3 gap-2">
            <Button
              variant="outline"
              className="min-h-12"
              disabled={
                testState === "sending" ||
                !androidPreference.enabled ||
                nativeState.permission !== "granted"
              }
              onPress={() => void sendTest()}
              accessibilityLabel={t("android_alerts.send_test")}
            >
              <Text>
                {testState === "sending"
                  ? t("android_alerts.test_sending")
                  : t("android_alerts.send_test")}
              </Text>
            </Button>
            {testState !== "idle" && testState !== "sending" ? (
              <Text
                className={
                  testState === "received"
                    ? "text-xs text-foreground"
                    : "text-xs text-destructive"
                }
                accessibilityLiveRegion="polite"
              >
                {t(`android_alerts.test_${testState}`)}
              </Text>
            ) : null}
          </View>
        </Section>
      ) : null}
    </ScrollView>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <View className="pt-5">
      <Text
        className="px-4 pb-2 text-xs font-semibold uppercase tracking-wider text-muted-foreground"
        accessibilityRole="header"
      >
        {title}
      </Text>
      <View className="border-y border-border bg-card">{children}</View>
    </View>
  );
}

function PreferenceRow({
  title,
  description,
  checked,
  disabled,
  onCheckedChange,
}: {
  title: string;
  description?: string;
  checked: boolean;
  disabled?: boolean;
  onCheckedChange: (checked: boolean) => void;
}) {
  return (
    <View className="min-h-[56px] flex-row items-center gap-4 px-4 py-3">
      <View className="flex-1">
        <Text className="text-base font-medium text-foreground">{title}</Text>
        {description ? (
          <Text className="mt-0.5 text-xs leading-4 text-muted-foreground">
            {description}
          </Text>
        ) : null}
      </View>
      <Switch
        checked={checked}
        disabled={disabled}
        onCheckedChange={onCheckedChange}
        accessibilityLabel={title}
      />
    </View>
  );
}

function NavigationRow({
  title,
  description,
  action,
  iconColor,
  onPress,
}: {
  title: string;
  description: string;
  action: string;
  iconColor: string;
  onPress: () => void;
}) {
  return (
    <Pressable
      className="min-h-[56px] flex-row items-center gap-3 px-4 py-3 active:bg-secondary"
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={`${title}. ${description}. ${action}`}
    >
      <View className="flex-1">
        <Text className="text-base font-medium text-foreground">{title}</Text>
        <Text className="mt-0.5 text-xs leading-4 text-muted-foreground">
          {description}
        </Text>
      </View>
      <Text className="text-sm text-muted-foreground">{action}</Text>
      <Ionicons name="chevron-forward" size={18} color={iconColor} />
    </Pressable>
  );
}

function Banner({
  tone,
  title,
  description,
  action,
  onAction,
}: {
  tone: "neutral" | "warning" | "destructive";
  title: string;
  description?: string;
  action?: string;
  onAction?: () => void;
}) {
  const toneClass =
    tone === "destructive"
      ? "bg-destructive/10"
      : tone === "warning"
        ? "bg-amber-500/10"
        : "bg-secondary";
  return (
    <View className={`border-b border-border px-4 py-3 ${toneClass}`}>
      <Text className="text-sm font-medium text-foreground">{title}</Text>
      {description ? (
        <Text className="mt-1 text-xs leading-4 text-muted-foreground">
          {description}
        </Text>
      ) : null}
      {action && onAction ? (
        <Pressable
          className="mt-2 min-h-12 self-start justify-center"
          onPress={onAction}
          accessibilityRole="button"
        >
          <Text className="text-sm font-semibold text-primary">{action}</Text>
        </Pressable>
      ) : null}
    </View>
  );
}

function InfoRow({ text, destructive = false }: { text: string; destructive?: boolean }) {
  return (
    <View className="min-h-[56px] justify-center px-4 py-3">
      <Text className={destructive ? "text-sm text-destructive" : "text-sm text-muted-foreground"}>
        {text}
      </Text>
    </View>
  );
}
