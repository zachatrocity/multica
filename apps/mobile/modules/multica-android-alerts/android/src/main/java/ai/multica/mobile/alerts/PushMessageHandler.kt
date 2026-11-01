package ai.multica.mobile.alerts

import android.content.Context
import org.unifiedpush.android.connector.data.PushMessage

internal object PushMessageHandler {
  fun handle(context: Context, message: PushMessage) {
    if (!message.decrypted) return
    NotificationRenderer.render(context, message.content)
  }
}
