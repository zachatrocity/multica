package ai.multica.mobile.alerts

import org.unifiedpush.android.connector.FailedReason
import org.unifiedpush.android.connector.PushService
import org.unifiedpush.android.connector.data.PushEndpoint
import org.unifiedpush.android.connector.data.PushMessage

class MulticaPushService : PushService() {
  override fun onNewEndpoint(endpoint: PushEndpoint, instance: String) {
    val keys = endpoint.pubKeySet
    if (keys == null) {
      AlertStore.clearRegistrationMaterial(applicationContext)
      AlertStore.setRegistrationStatus(applicationContext, "failed", "encryption_keys_missing")
      return
    }
    AlertStore.saveRegistration(
      applicationContext,
      AlertStore.AlertRegistration(
        endpoint = endpoint.url,
        p256dh = keys.pubKey,
        auth = keys.auth,
      ),
    )
  }

  override fun onMessage(message: PushMessage, instance: String) {
    PushMessageHandler.handle(applicationContext, message)
  }

  override fun onRegistrationFailed(reason: FailedReason, instance: String) {
    AlertStore.setRegistrationStatus(
      applicationContext,
      "failed",
      reason.name.lowercase(),
    )
  }

  override fun onUnregistered(instance: String) {
    AlertStore.clearRegistrationMaterial(applicationContext)
    AlertStore.setRegistrationStatus(applicationContext, "disconnected")
  }
}
