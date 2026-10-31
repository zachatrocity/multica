import { Redirect, router } from "expo-router";
import { SafeAreaView } from "react-native-safe-area-context";
import { View } from "react-native";
import { Button } from "@/components/ui/button";
import { Text } from "@/components/ui/text";
import { useNotificationDestinationStore } from "@/data/notification-destination-store";
import { useWorkspaceStore } from "@/data/workspace-store";
import { useT } from "@/lib/i18n";

export default function NotificationRecovery() {
  const { t } = useT("inbox");
  const recovery = useNotificationDestinationStore((state) => state.recovery);
  const cancel = useNotificationDestinationStore((state) => state.cancel);
  const retry = useNotificationDestinationStore((state) => state.retry);

  if (!recovery) return <Redirect href="/" />;

  const workspaceName =
    recovery.workspaceName ?? t("notification_recovery.this_workspace");
  const title = t(`notification_recovery.${recovery.reason}.title`);
  const body = t(`notification_recovery.${recovery.reason}.body`, {
    workspace: workspaceName,
  });
  const canOpenInbox =
    recovery.workspaceId != null && recovery.workspaceSlug != null;
  const canRetry =
    recovery.reason === "offline" || recovery.reason === "temporary_error";

  const openInbox = async () => {
    if (!recovery.workspaceId || !recovery.workspaceSlug) return;
    await useWorkspaceStore
      .getState()
      .setCurrentWorkspace(recovery.workspaceId, recovery.workspaceSlug);
    await cancel();
    router.replace({
      pathname: "/[workspace]/inbox",
      params: { workspace: recovery.workspaceSlug },
    });
  };

  const chooseWorkspace = async () => {
    await cancel();
    router.replace("/select-workspace");
  };

  return (
    <SafeAreaView className="flex-1 bg-background">
      <View className="flex-1 justify-center px-6 gap-6">
        <View className="gap-2">
          <Text className="text-2xl font-semibold text-foreground">
            {title}
          </Text>
          <Text className="text-sm text-muted-foreground">{body}</Text>
        </View>

        <View className="gap-3">
          {canRetry ? (
            <Button onPress={retry}>
              <Text>{t("common:actions.retry")}</Text>
            </Button>
          ) : null}
          {canOpenInbox ? (
            <Button variant={canRetry ? "outline" : "default"} onPress={openInbox}>
              <Text>
                {t("notification_recovery.open_inbox", {
                  workspace: workspaceName,
                })}
              </Text>
            </Button>
          ) : null}
          <Button variant="outline" onPress={chooseWorkspace}>
            <Text>{t("notification_recovery.choose_workspace")}</Text>
          </Button>
        </View>
      </View>
    </SafeAreaView>
  );
}
