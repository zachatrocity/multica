package ai.multica.mobile.alerts

import android.Manifest
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.provider.Settings
import androidx.core.content.ContextCompat
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import org.unifiedpush.android.connector.UnifiedPush

class MulticaAndroidAlertsModule : Module() {
  override fun definition() = ModuleDefinition {
    Name("MulticaAndroidAlerts")

    Function("getState") {
      val context = applicationContext()
      val distributors = ntfyDistributors(context)
      val selected = AlertStore.distributor(context)
      mapOf(
        "available" to distributors.isNotEmpty(),
        "distributor_package" to selected,
        "distributor_name" to selected?.let { applicationLabel(context, it) },
        "registration_status" to AlertStore.registrationStatus(context),
        "registration_failure" to AlertStore.registrationFailure(context),
        "endpoint_available" to (AlertStore.registration(context) != null),
        "device_id" to AlertStore.deviceId(context),
        "permission" to permissionState(context),
        "app_notifications_enabled" to NotificationRenderer.notificationsEnabled(context),
        "action_channel_enabled" to NotificationRenderer.channelEnabled(context, NotificationRenderer.ACTION_CHANNEL_ID),
        "activity_channel_enabled" to NotificationRenderer.channelEnabled(context, NotificationRenderer.ACTIVITY_CHANNEL_ID),
        "last_event_id" to AlertStore.lastEventId(context),
        "private_lock_screen" to AlertStore.privateLockScreen(context),
      )
    }

    AsyncFunction("registerWithNtfy") {
      val context = applicationContext()
      val distributor = ntfyDistributors(context).firstOrNull()
        ?: throw IllegalStateException("ntfy UnifiedPush distributor is not installed")
      UnifiedPush.saveDistributor(context, distributor)
      AlertStore.setDistributor(context, distributor)
      AlertStore.setRegistrationStatus(context, "registering")
      UnifiedPush.register(context, INSTANCE, "Multica Android alerts", null)
    }

    AsyncFunction("refreshRegistration") {
      val context = applicationContext()
      val distributor = AlertStore.distributor(context) ?: return@AsyncFunction false
      if (distributor !in ntfyDistributors(context)) {
        AlertStore.clearRegistrationMaterial(context)
        AlertStore.setRegistrationStatus(context, "failed", "distributor_unavailable")
        return@AsyncFunction false
      }
      UnifiedPush.saveDistributor(context, distributor)
      UnifiedPush.register(context, INSTANCE, "Multica Android alerts", null)
      true
    }

    AsyncFunction("unregister") {
      val context = applicationContext()
      UnifiedPush.unregister(context, INSTANCE)
      AlertStore.clearRegistration(context)
    }

    Function("getRegistration") {
      AlertStore.registration(applicationContext())?.let {
        mapOf(
          "endpoint" to it.endpoint,
          "p256dh" to it.p256dh,
          "auth" to it.auth,
        )
      }
    }

    Function("getDeviceId") {
      AlertStore.deviceId(applicationContext())
    }

    Function("createChannels") {
      NotificationRenderer.createChannels(applicationContext())
    }

    Function("setPrivateLockScreen") { enabled: Boolean ->
      AlertStore.setPrivateLockScreen(applicationContext(), enabled)
    }

    Function("openAppNotificationSettings") {
      val context = applicationContext()
      launch(
        context,
        Intent(Settings.ACTION_APP_NOTIFICATION_SETTINGS)
          .putExtra(Settings.EXTRA_APP_PACKAGE, context.packageName),
      )
    }

    Function("openChannelSettings") { channelId: String ->
      val context = applicationContext()
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
        launch(
          context,
          Intent(Settings.ACTION_CHANNEL_NOTIFICATION_SETTINGS)
            .putExtra(Settings.EXTRA_APP_PACKAGE, context.packageName)
            .putExtra(Settings.EXTRA_CHANNEL_ID, channelId),
        )
      } else {
        launch(
          context,
          Intent(Settings.ACTION_APP_NOTIFICATION_SETTINGS)
            .putExtra(Settings.EXTRA_APP_PACKAGE, context.packageName),
        )
      }
    }

    Function("openNtfy") {
      val context = applicationContext()
      val packageName = ntfyDistributors(context).firstOrNull() ?: NTFY_PACKAGE
      val launchIntent = context.packageManager.getLaunchIntentForPackage(packageName)
      if (launchIntent != null) {
        launch(context, launchIntent)
      } else {
        launch(
          context,
          Intent(Intent.ACTION_VIEW, Uri.parse("market://details?id=$NTFY_PACKAGE")),
        )
      }
    }
  }

  private fun applicationContext(): Context =
    requireNotNull(appContext.reactContext).applicationContext

  private fun ntfyDistributors(context: Context): List<String> =
    UnifiedPush.getDistributors(context)
      .filter { it == NTFY_PACKAGE }
      .sorted()

  private fun applicationLabel(context: Context, packageName: String): String = try {
    val info = context.packageManager.getApplicationInfo(packageName, 0)
    context.packageManager.getApplicationLabel(info).toString()
  } catch (_: PackageManager.NameNotFoundException) {
    packageName
  }

  private fun permissionState(context: Context): String {
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU) return "granted"
    return if (
      ContextCompat.checkSelfPermission(context, Manifest.permission.POST_NOTIFICATIONS) ==
      PackageManager.PERMISSION_GRANTED
    ) "granted" else "denied"
  }

  private fun launch(context: Context, intent: Intent) {
    intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
    try {
      context.startActivity(intent)
    } catch (_: Exception) {
      if (intent.data?.scheme == "market") {
        val web = Intent(
          Intent.ACTION_VIEW,
          Uri.parse("https://play.google.com/store/apps/details?id=$NTFY_PACKAGE"),
        ).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        context.startActivity(web)
      }
    }
  }

  private companion object {
    const val INSTANCE = "multica"
    const val NTFY_PACKAGE = "io.heckel.ntfy"
  }
}
