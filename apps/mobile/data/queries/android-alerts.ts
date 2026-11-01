import { queryOptions } from "@tanstack/react-query";
import { api } from "@/data/api";

export const androidAlertKeys = {
  endpoints: ["android-alerts", "endpoints"] as const,
  preference: (workspaceId: string | null) =>
    ["android-alerts", "preference", workspaceId] as const,
};

export const androidAlertEndpointOptions = () =>
  queryOptions({
    queryKey: androidAlertKeys.endpoints,
    queryFn: ({ signal }) => api.listAndroidPushEndpoints({ signal }),
    staleTime: 30_000,
  });

export const androidAlertPreferenceOptions = (workspaceId: string | null) =>
  queryOptions({
    queryKey: androidAlertKeys.preference(workspaceId),
    queryFn: ({ signal }) => api.getAndroidPushPreference({ signal }),
    enabled: !!workspaceId,
  });
