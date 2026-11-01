package ai.multica.mobile.alerts

import android.content.Context
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.Base64
import java.security.KeyStore
import java.util.UUID
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec
import org.json.JSONObject

internal object AlertStore {
  private const val PREFS = "multica_android_alerts"
  private const val KEY_ALIAS = "multica_android_alert_endpoint"
  private const val REGISTRATION = "registration_ciphertext"
  private const val LEGACY_ENDPOINT = "endpoint_ciphertext"
  private const val DEVICE_ID = "device_id"
  private const val DISTRIBUTOR = "distributor"
  private const val STATUS = "registration_status"
  private const val FAILURE = "registration_failure"
  private const val LAST_EVENT = "last_event_id"
  private const val EVENT_IDS = "received_event_ids"
  private const val PRIVATE_LOCK_SCREEN = "private_lock_screen"
  private const val IV_BYTES = 12

  private fun prefs(context: Context) =
    context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)

  fun deviceId(context: Context): String {
    val preferences = prefs(context)
    val existing = preferences.getString(DEVICE_ID, null)
    if (!existing.isNullOrBlank()) return existing
    return UUID.randomUUID().toString().also {
      preferences.edit().putString(DEVICE_ID, it).apply()
    }
  }

  fun distributor(context: Context): String? = prefs(context).getString(DISTRIBUTOR, null)

  fun setDistributor(context: Context, value: String) {
    prefs(context).edit().putString(DISTRIBUTOR, value).apply()
  }

  fun registrationStatus(context: Context): String =
    prefs(context).getString(STATUS, "disconnected") ?: "disconnected"

  fun registrationFailure(context: Context): String? = prefs(context).getString(FAILURE, null)

  fun setRegistrationStatus(context: Context, status: String, failure: String? = null) {
    prefs(context).edit()
      .putString(STATUS, status)
      .putString(FAILURE, failure)
      .apply()
  }

  fun saveRegistration(context: Context, registration: AlertRegistration) {
    val plaintext = JSONObject()
      .put("endpoint", registration.endpoint)
      .put("p256dh", registration.p256dh)
      .put("auth", registration.auth)
      .toString()
      .toByteArray(Charsets.UTF_8)
    val cipher = Cipher.getInstance("AES/GCM/NoPadding")
    cipher.init(Cipher.ENCRYPT_MODE, endpointKey())
    val encrypted = cipher.doFinal(plaintext)
    val combined = ByteArray(cipher.iv.size + encrypted.size)
    cipher.iv.copyInto(combined)
    encrypted.copyInto(combined, cipher.iv.size)
    prefs(context).edit()
      .putString(REGISTRATION, Base64.encodeToString(combined, Base64.NO_WRAP))
      .remove(LEGACY_ENDPOINT)
      .putString(STATUS, "registered")
      .remove(FAILURE)
      .apply()
  }

  fun registration(context: Context): AlertRegistration? {
    val preferences = prefs(context)
    val encoded = preferences.getString(REGISTRATION, null)
    if (encoded == null) {
      if (preferences.contains(LEGACY_ENDPOINT)) {
        preferences.edit().remove(LEGACY_ENDPOINT).apply()
        setRegistrationStatus(context, "registering")
      }
      return null
    }
    return try {
      val combined = Base64.decode(encoded, Base64.NO_WRAP)
      if (combined.size <= IV_BYTES) return null
      val cipher = Cipher.getInstance("AES/GCM/NoPadding")
      cipher.init(
        Cipher.DECRYPT_MODE,
        endpointKey(),
        GCMParameterSpec(128, combined.copyOfRange(0, IV_BYTES)),
      )
      val value = JSONObject(
        String(cipher.doFinal(combined.copyOfRange(IV_BYTES, combined.size)), Charsets.UTF_8),
      )
      AlertRegistration(
        endpoint = value.getString("endpoint"),
        p256dh = value.getString("p256dh"),
        auth = value.getString("auth"),
      ).takeIf { it.endpoint.isNotBlank() && it.p256dh.isNotBlank() && it.auth.isNotBlank() }
        ?: throw IllegalStateException("incomplete registration")
    } catch (_: Exception) {
      clearRegistrationMaterial(context)
      setRegistrationStatus(context, "failed", "endpoint_storage_unavailable")
      null
    }
  }

  fun clearRegistrationMaterial(context: Context) {
    prefs(context).edit()
      .remove(REGISTRATION)
      .remove(LEGACY_ENDPOINT)
      .apply()
  }

  fun clearRegistration(context: Context) {
    prefs(context).edit()
      .remove(REGISTRATION)
      .remove(LEGACY_ENDPOINT)
      .remove(DISTRIBUTOR)
      .putString(STATUS, "disconnected")
      .remove(FAILURE)
      .remove(LAST_EVENT)
      .remove(EVENT_IDS)
      .apply()
  }

  fun recordEvent(context: Context, eventId: String): Boolean {
    val preferences = prefs(context)
    val ids = preferences.getString(EVENT_IDS, "")
      .orEmpty()
      .split(',')
      .filter(String::isNotBlank)
      .toMutableList()
    if (eventId in ids) return false
    ids.add(eventId)
    if (ids.size > 100) ids.subList(0, ids.size - 100).clear()
    preferences.edit()
      .putString(EVENT_IDS, ids.joinToString(","))
      .putString(LAST_EVENT, eventId)
      .apply()
    return true
  }

  fun lastEventId(context: Context): String? = prefs(context).getString(LAST_EVENT, null)

  fun privateLockScreen(context: Context): Boolean =
    prefs(context).getBoolean(PRIVATE_LOCK_SCREEN, true)

  fun setPrivateLockScreen(context: Context, value: Boolean) {
    prefs(context).edit().putBoolean(PRIVATE_LOCK_SCREEN, value).apply()
  }

  private fun endpointKey(): SecretKey {
    val keyStore = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
    val existing = keyStore.getKey(KEY_ALIAS, null) as? SecretKey
    if (existing != null) return existing
    val generator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore")
    generator.init(
      KeyGenParameterSpec.Builder(
        KEY_ALIAS,
        KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT,
      )
        .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
        .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
        .build(),
    )
    return generator.generateKey()
  }

internal data class AlertRegistration(
  val endpoint: String,
  val p256dh: String,
  val auth: String,
)
}
