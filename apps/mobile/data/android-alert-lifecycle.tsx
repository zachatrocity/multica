import { useEffect } from "react";
import { AppState, Linking, Platform, type AppStateStatus } from "react-native";
import { router } from "expo-router";
import { useAuthStore } from "./auth-store";
import { queueNotificationDestination } from "./notification-destination-store";
import { syncAndroidAlertTransport } from "./android-alerts";

const SAFE_WORKSPACE_SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const MAX_ROUTING_PAYLOAD_LENGTH = 4_096;

export async function handleAndroidAlertUrl(url: string): Promise<boolean> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (parsed.protocol !== "multica:") return false;
  if (parsed.hostname === "notification") {
    const encoded = parsed.searchParams.get("payload");
    if (!encoded || encoded.length > MAX_ROUTING_PAYLOAD_LENGTH) return false;
    try {
      await queueNotificationDestination(JSON.parse(encoded));
      return true;
    } catch {
      return false;
    }
  }
  if (parsed.hostname === "notification-settings") {
    const slug = parsed.searchParams.get("workspace_slug") ?? "";
    if (slug.length > 63 || !SAFE_WORKSPACE_SLUG.test(slug)) return false;
    router.push(`/${slug}/more/settings/notifications`);
    return true;
  }
  return false;
}

export function AndroidAlertLifecycle() {
  const user = useAuthStore((state) => state.user);

  useEffect(() => {
    if (Platform.OS !== "android") return;
    const handleUrl = ({ url }: { url: string }) => {
      void handleAndroidAlertUrl(url);
    };
    const linkSubscription = Linking.addEventListener("url", handleUrl);
    void Linking.getInitialURL().then((url) => {
      if (url) void handleAndroidAlertUrl(url);
    });
    return () => linkSubscription.remove();
  }, []);

  useEffect(() => {
    if (Platform.OS !== "android" || !user) return;
    const sync = () => {
      void syncAndroidAlertTransport().catch(() => undefined);
    };
    sync();
    const appStateSubscription = AppState.addEventListener(
      "change",
      (status: AppStateStatus) => {
        if (status === "active") sync();
      },
    );
    return () => appStateSubscription.remove();
  }, [user]);

  return null;
}
