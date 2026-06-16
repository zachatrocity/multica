export type MobilePushProvider = "expo" | "unifiedpush";

export interface MobilePushSubscription {
  id: string;
  provider: MobilePushProvider | string;
  device_name: string | null;
  app_variant: string;
  created_at: string;
  updated_at: string;
  last_success_at: string | null;
  last_failure_at: string | null;
  failure_count: number;
}

export interface RegisterMobilePushSubscriptionRequest {
  provider: MobilePushProvider;
  token: string;
  device_name?: string | null;
  app_variant: string;
}
