package ai.multica.mobile.alerts

import org.unifiedpush.android.connector.FailedReason
import org.unifiedpush.android.connector.PushService
import org.unifiedpush.android.connector.data.PushEndpoint
import org.unifiedpush.android.connector.data.PushMessage

class MulticaPushService : PushService() {
  override fun onNewEndpoint(endpoint: PushEndpoint, instance: String) {
    AlertStore.saveEndpoint(applicationContext, endpoint.url)
  }

  override fun onMessage(message: PushMessage, instance: String) {
    if (!message.decrypted) return
    NotificationRenderer.render(applicationContext, message.content)
  }

  override fun onRegistrationFailed(reason: FailedReason, instance: String) {
    AlertStore.setRegistrationStatus(
      applicationContext,
      "failed",
      reason.name.lowercase(),
    )
  }

  override fun onUnregistered(instance: String) {
    AlertStore.clearEndpoint(applicationContext)
    AlertStore.setRegistrationStatus(applicationContext, "disconnected")
  }
}
