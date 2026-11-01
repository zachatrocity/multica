import { ActivityIndicator, View } from "react-native";
import { Redirect } from "expo-router";
import { Button } from "@/components/ui/button";
import { Text } from "@/components/ui/text";
import { useAuthStore } from "@/data/auth-store";
import { useWorkspaceStore } from "@/data/workspace-store";
import { useT } from "@/lib/i18n";

/**
 * Entry redirect. AuthInitializer (in _layout.tsx) finishes auth + slug
 * hydration before this renders meaningfully — until then, isLoading is true.
 *
 *   no user            → /login
 *   user, no slug      → /select-workspace
 *   user, slug         → /[slug]/inbox
 */
export default function Index() {
  const { t } = useT("auth");
  const user = useAuthStore((s) => s.user);
  const isLoading = useAuthStore((s) => s.isLoading);
  const startupPhase = useAuthStore((s) => s.startupPhase);
  const startupFailure = useAuthStore((s) => s.startupFailure);
  const initialize = useAuthStore((s) => s.initialize);
  const slug = useWorkspaceStore((s) => s.currentWorkspaceSlug);

  if (isLoading) {
    return (
      <View className="flex-1 items-center justify-center gap-3 bg-background px-6">
        <ActivityIndicator />
        <Text variant="muted">{t("startup.loading")}</Text>
        <Text className="font-mono text-xs text-muted-foreground">
          startup/{startupPhase}
        </Text>
      </View>
    );
  }

  if (startupFailure) {
    const diagnostic = `startup/${startupFailure.phase}/${startupFailure.code}`;
    return (
      <View className="flex-1 items-center justify-center gap-4 bg-background px-8">
        <Text variant="h3" className="text-center">
          {t("startup.failed_title")}
        </Text>
        <Text className="text-center text-muted-foreground">
          {t(
            startupFailure.phase === "clearing-session"
              ? "startup.clear_failed_message"
              : "startup.failed_message",
          )}
        </Text>
        <Text className="font-mono text-xs text-muted-foreground">
          {t("startup.diagnostic", { diagnostic })}
        </Text>
        <Button onPress={() => void initialize()}>
          <Text>{t("startup.retry")}</Text>
        </Button>
      </View>
    );
  }

  if (!user) return <Redirect href="/login" />;
  if (!slug) return <Redirect href="/select-workspace" />;
  return <Redirect href={`/${slug}/inbox`} />;
}
