package ai.multica.mobile.alerts

import android.Manifest
import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import androidx.core.content.ContextCompat
import org.json.JSONObject
import java.util.UUID

internal object NotificationRenderer {
  const val ACTION_CHANNEL_ID = "multica_action_needed"
  const val ACTIVITY_CHANNEL_ID = "multica_activity"
  private const val GROUP_SUMMARY_SUFFIX = ":summary"
  private val whitespace = Regex("\\s+")
  private val safeSlug = Regex("^[a-z0-9]+(?:-[a-z0-9]+)*$")


  private val eventTypes = setOf(
    "issue_assigned",
    "unassigned",
    "assignee_changed",
    "status_changed",
    "priority_changed",
    "start_date_changed",
    "due_date_changed",
    "new_comment",
    "mentioned",
    "review_requested",
    "task_failed",
    "agent_blocked",
    "children_done",
    "reaction_added",
    "task_completed",
    "agent_completed",
    "test",
  )

  fun createChannels(context: Context) {
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
    val manager = context.getSystemService(NotificationManager::class.java)
    val action = NotificationChannel(
      ACTION_CHANNEL_ID,
      "Action needed",
      NotificationManager.IMPORTANCE_DEFAULT,
    ).apply {
      description = "Mentions, assignments, reviews, and blockers"
      lockscreenVisibility = Notification.VISIBILITY_PRIVATE
    }
    val activity = NotificationChannel(
      ACTIVITY_CHANNEL_ID,
      "Activity",
      NotificationManager.IMPORTANCE_LOW,
    ).apply {
      description = "Comments and routine issue activity"
      lockscreenVisibility = Notification.VISIBILITY_PRIVATE
    }
    manager.createNotificationChannels(listOf(action, activity))
  }

  fun notificationsEnabled(context: Context): Boolean =
    NotificationManagerCompat.from(context).areNotificationsEnabled()

  fun channelEnabled(context: Context, channelId: String): Boolean {
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return true
    val channel = context.getSystemService(NotificationManager::class.java)
      .getNotificationChannel(channelId)
    return channel == null || channel.importance != NotificationManager.IMPORTANCE_NONE
  }

  fun render(context: Context, rawPayload: ByteArray) {
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU &&
      ContextCompat.checkSelfPermission(context, Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED
    ) return
    createChannels(context)
    val payload = try {
      JSONObject(String(rawPayload, Charsets.UTF_8))
    } catch (_: Exception) {
      return
    }
    if (payload.optInt("version") != 1) return
    val eventId = payload.optString("event_id")
    val eventType = payload.optString("event_type")
    val workspaceId = payload.optString("workspace_id")
    val workspaceSlug = payload.optString("workspace_slug")
    val issueId = payload.optString("issue_id")
    if (!isUuid(eventId) || !isUuid(workspaceId) || !isSafeSlug(workspaceSlug) || eventType !in eventTypes) return
    if (eventType != "test" && !isUuid(issueId)) return
    if (!AlertStore.recordEvent(context, eventId)) return

    val title = clean(payload.optString("title"), 120)
    val body = clean(payload.optString("body"), 220)
    val expandedBody = clean(payload.optString("expanded_body"), 420).ifBlank { body }
    if (title.isBlank() || body.isBlank()) return
    val channelId = when (payload.optString("channel")) {
      "action_needed" -> ACTION_CHANNEL_ID
      else -> ACTIVITY_CHANNEL_ID
    }
    val groupKey = "multica:$workspaceId"
    val replacementKey = "$workspaceId:${issueId.ifBlank { eventId }}"
    val contentIntent = contentIntent(context, payload, eventType, replacementKey.hashCode()) ?: return
    val publicVersion = NotificationCompat.Builder(context, channelId)
      .setSmallIcon(R.drawable.multica_notification)
      .setContentTitle("New Multica activity")
      .setContentText("Unlock to view details.")
      .build()
    val builder = NotificationCompat.Builder(context, channelId)
      .setSmallIcon(R.drawable.multica_notification)
      .setContentTitle(title)
      .setContentText(body)
      .setStyle(NotificationCompat.BigTextStyle().bigText(expandedBody))
      .setContentIntent(contentIntent)
      .setAutoCancel(true)
      .setGroup(groupKey)
      .setCategory(NotificationCompat.CATEGORY_STATUS)
      .setPriority(
        if (channelId == ACTION_CHANNEL_ID) NotificationCompat.PRIORITY_DEFAULT
        else NotificationCompat.PRIORITY_LOW,
      )
    if (AlertStore.privateLockScreen(context)) {
      builder.setVisibility(NotificationCompat.VISIBILITY_PRIVATE).setPublicVersion(publicVersion)
    } else {
      builder.setVisibility(NotificationCompat.VISIBILITY_PUBLIC)
    }
    val manager = NotificationManagerCompat.from(context)
    manager.notify(replacementKey, replacementKey.hashCode(), builder.build())
    updateGroupSummary(
      context,
      manager,
      groupKey,
      workspaceId,
      workspaceSlug,
      clean(payload.optString("workspace_name"), 80),
    )
  }

  private fun contentIntent(
    context: Context,
    payload: JSONObject,
    eventType: String,
    requestCode: Int,
  ): PendingIntent? {
    val uri = if (eventType == "test") {
      Uri.Builder()
        .scheme("multica")
        .authority("notification-settings")
        .appendQueryParameter("workspace_slug", payload.optString("workspace_slug"))
        .build()
    } else {
      val route = JSONObject().apply {
        put("version", 1)
        put("workspace_id", payload.optString("workspace_id"))
        put("workspace_slug", payload.optString("workspace_slug"))
        put("issue_id", payload.optString("issue_id"))
        payload.optString("comment_id").takeIf(::isUuid)?.let { put("comment_id", it) }
        payload.optString("inbox_item_id").takeIf(::isUuid)?.let { put("inbox_item_id", it) }
        put("event_id", payload.optString("event_id"))
        put("event_type", eventType)
      }
      Uri.Builder()
        .scheme("multica")
        .authority("notification")
        .appendQueryParameter("payload", route.toString())
        .build()
    }
    val intent = Intent(Intent.ACTION_VIEW, uri).apply {
      setPackage(context.packageName)
      flags = Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP or Intent.FLAG_ACTIVITY_SINGLE_TOP
    }
    return PendingIntent.getActivity(
      context,
      requestCode,
      intent,
      PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
    )
  }

  private fun updateGroupSummary(
    context: Context,
    manager: NotificationManagerCompat,
    groupKey: String,
    workspaceId: String,
    workspaceSlug: String,
    workspaceName: String,
  ) {
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.M) return
    val platformManager = context.getSystemService(NotificationManager::class.java)
    val count = platformManager.activeNotifications.count {
      it.notification.group == groupKey &&
        it.notification.flags and Notification.FLAG_GROUP_SUMMARY == 0
    }
    val summaryTag = workspaceId + GROUP_SUMMARY_SUFFIX
    if (count < 2) {
      manager.cancel(summaryTag, summaryTag.hashCode())
      return
    }
    val route = JSONObject().apply {
      put("version", 1)
      put("workspace_id", workspaceId)
      put("workspace_slug", workspaceSlug)
    }
    val intent = Intent(
      Intent.ACTION_VIEW,
      Uri.Builder().scheme("multica").authority("notification")
        .appendQueryParameter("payload", route.toString()).build(),
    ).apply {
      setPackage(context.packageName)
      flags = Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP or Intent.FLAG_ACTIVITY_SINGLE_TOP
    }
    val pendingIntent = PendingIntent.getActivity(
      context,
      summaryTag.hashCode(),
      intent,
      PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
    )
    val privateLockScreen = AlertStore.privateLockScreen(context)
    val summaryBuilder = NotificationCompat.Builder(context, ACTIVITY_CHANNEL_ID)
      .setSmallIcon(R.drawable.multica_notification)
      .setContentTitle("$count Multica updates")
      .setContentText(workspaceName.ifBlank { "Open workspace inbox" })
      .setGroup(groupKey)
      .setGroupSummary(true)
      .setOnlyAlertOnce(true)
      .setAutoCancel(true)
      .setContentIntent(pendingIntent)
      .setVisibility(
        if (privateLockScreen) NotificationCompat.VISIBILITY_PRIVATE
        else NotificationCompat.VISIBILITY_PUBLIC,
      )
    if (privateLockScreen) {
      summaryBuilder.setPublicVersion(
        NotificationCompat.Builder(context, ACTIVITY_CHANNEL_ID)
          .setSmallIcon(R.drawable.multica_notification)
          .setContentTitle("New Multica activity")
          .setContentText("Unlock to view details.")
          .build(),
      )
    }
    val summary = summaryBuilder.build()
    manager.notify(summaryTag, summaryTag.hashCode(), summary)
  }

  private fun clean(value: String, maxLength: Int): String {
    val normalized = value.replace(whitespace, " ").trim()
    if (normalized.length <= maxLength) return normalized
    return normalized.take(maxLength - 1).trimEnd() + "…"
  }

  private fun isUuid(value: String): Boolean = try {
    UUID.fromString(value)
    true
  } catch (_: IllegalArgumentException) {
    false
  }

  private fun isSafeSlug(value: String): Boolean =
    value.length in 1..63 && value.matches(safeSlug)
}
