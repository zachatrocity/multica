package ai.multica.mobile.alerts

import android.app.NotificationManager
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.net.Uri
import android.os.Looper
import android.util.Base64
import com.google.crypto.tink.apps.fixed_webpush.WebPushHybridDecrypt
import com.google.crypto.tink.apps.fixed_webpush.WebPushHybridEncrypt
import java.math.BigInteger
import java.security.KeyPair
import java.security.KeyPairGenerator
import java.security.SecureRandom
import java.security.interfaces.ECPrivateKey
import java.security.interfaces.ECPublicKey
import java.security.spec.ECGenParameterSpec
import java.util.UUID
import org.json.JSONObject
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.Config
import org.unifiedpush.android.connector.FailedReason
import org.unifiedpush.android.connector.MessagingReceiver
import org.unifiedpush.android.connector.UnifiedPush
import org.unifiedpush.android.connector.data.PublicKeySet
import org.unifiedpush.android.connector.data.PushEndpoint
import org.unifiedpush.android.connector.data.PushMessage
import org.unifiedpush.android.connector.keys.KeyManager

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [28])
class UnifiedPushDeliveryTest {
  private lateinit var context: Context
  private lateinit var keyManager: MemoryKeyManager
  private lateinit var appReceiver: TestMessagingReceiver
  private lateinit var distributor: TestDistributor

  @Before
  fun setUp() {
    context = RuntimeEnvironment.getApplication()
    context.getSharedPreferences("multica_android_alerts", Context.MODE_PRIVATE).edit().clear().commit()
    keyManager = MemoryKeyManager()
    appReceiver = TestMessagingReceiver(keyManager)
    distributor = TestDistributor()
    context.registerReceiver(
      appReceiver,
      IntentFilter().apply {
        addAction(ACTION_NEW_ENDPOINT)
        addAction(ACTION_MESSAGE)
        addAction(ACTION_UNREGISTERED)
        addAction(ACTION_REGISTRATION_FAILED)
      },
    )
    context.registerReceiver(distributor, IntentFilter(ACTION_REGISTER))
    context.getSystemService(NotificationManager::class.java).cancelAll()
  }

  @After
  fun tearDown() {
    runCatching { UnifiedPush.unregister(context, INSTANCE, keyManager) }
    context.unregisterReceiver(distributor)
    context.unregisterReceiver(appReceiver)
  }

  @Test
  fun encryptedMessagesTraverseConnectorReceiverAndRotationRejectsOldCiphertext() {
    val firstEndpoint = registerEndpoint()
    val firstEvent = UUID.randomUUID().toString()
    val firstPlaintext = payload(firstEvent)
    val firstCiphertext = encrypt(firstEndpoint.pubKeySet!!, firstPlaintext)

    sendMessage(firstCiphertext)

    val notificationManager = shadowOf(context.getSystemService(NotificationManager::class.java))
    val firstNotificationCount = notificationManager.allNotifications.size
    assertTrue(firstNotificationCount > 0)
    assertEquals(firstEvent, AlertStore.lastEventId(context))
    assertEquals(listOf(true), appReceiver.decryptionResults)

    sendMessage(SecureRandom().generateSeed(96))

    assertEquals(firstNotificationCount, notificationManager.allNotifications.size)
    assertEquals(firstEvent, AlertStore.lastEventId(context))
    assertEquals(listOf(true, false), appReceiver.decryptionResults)

    UnifiedPush.unregister(context, INSTANCE, keyManager)
    distributor.token = null
    appReceiver.endpoint = null
    val rotatedEndpoint = registerEndpoint()
    assertFalse(firstEndpoint.pubKeySet!!.pubKey == rotatedEndpoint.pubKeySet!!.pubKey)

    sendMessage(firstCiphertext)

    assertEquals(firstNotificationCount, notificationManager.allNotifications.size)
    assertEquals(firstEvent, AlertStore.lastEventId(context))
    assertEquals(listOf(true, false, false), appReceiver.decryptionResults)

    val rotatedEvent = UUID.randomUUID().toString()
    sendMessage(encrypt(rotatedEndpoint.pubKeySet!!, payload(rotatedEvent)))

    assertTrue(notificationManager.allNotifications.size > firstNotificationCount)
    assertEquals(rotatedEvent, AlertStore.lastEventId(context))
    assertEquals(listOf(true, false, false, true), appReceiver.decryptionResults)
  }

  private fun registerEndpoint(): PushEndpoint {
    UnifiedPush.saveDistributor(context, context.packageName)
    UnifiedPush.register(context, INSTANCE, "Multica Android alerts", null, keyManager)
    shadowOf(Looper.getMainLooper()).idle()
    val token = distributor.token
    assertNotNull("connector did not register with the distributor", token)
    val endpoint = Uri.Builder()
      .scheme("https")
      .authority("ntfy.invalid")
      .appendPath("up")
      .appendPath(UUID.randomUUID().toString())
      .build()
      .toString()
    context.sendBroadcast(
      Intent(ACTION_NEW_ENDPOINT)
        .setPackage(context.packageName)
        .putExtra(EXTRA_TOKEN, token)
        .putExtra(EXTRA_ENDPOINT, endpoint),
    )
    shadowOf(Looper.getMainLooper()).idle()
    return requireNotNull(appReceiver.endpoint) { "connector did not deliver the endpoint" }
  }

  private fun sendMessage(ciphertext: ByteArray) {
    context.sendBroadcast(
      Intent(ACTION_MESSAGE)
        .setPackage(context.packageName)
        .putExtra(EXTRA_TOKEN, requireNotNull(distributor.token))
        .putExtra(EXTRA_BYTES_MESSAGE, ciphertext)
        .putExtra(EXTRA_MESSAGE_ID, UUID.randomUUID().toString()),
    )
    shadowOf(Looper.getMainLooper()).idle()
  }

  private fun encrypt(keys: PublicKeySet, plaintext: ByteArray): ByteArray =
    WebPushHybridEncrypt.Builder()
      .withAuthSecret(Base64.decode(keys.auth, Base64.URL_SAFE or Base64.NO_PADDING or Base64.NO_WRAP))
      .withRecipientPublicKey(
        Base64.decode(keys.pubKey, Base64.URL_SAFE or Base64.NO_PADDING or Base64.NO_WRAP),
      )
      .build()
      .encrypt(plaintext, null)

  private fun payload(eventId: String): ByteArray = JSONObject()
    .put("version", 1)
    .put("event_id", eventId)
    .put("event_type", "test")
    .put("workspace_id", UUID.randomUUID().toString())
    .put("workspace_slug", "connector-test")
    .put("workspace_name", "Connector test")
    .put("title", "Encrypted alert")
    .put("body", "Delivered through UnifiedPush")
    .put("channel", "action_needed")
    .toString()
    .toByteArray(Charsets.UTF_8)

  private class TestDistributor : BroadcastReceiver() {
    var token: String? = null

    override fun onReceive(context: Context, intent: Intent) {
      token = intent.getStringExtra(EXTRA_TOKEN)
    }
  }

  private class TestMessagingReceiver(
    private val keyManager: KeyManager,
  ) : MessagingReceiver() {
    var endpoint: PushEndpoint? = null
    val decryptionResults = mutableListOf<Boolean>()

    override fun getKeyManager(context: Context): KeyManager = keyManager

    override fun onNewEndpoint(context: Context, endpoint: PushEndpoint, instance: String) {
      this.endpoint = endpoint
    }

    override fun onMessage(context: Context, message: PushMessage, instance: String) {
      decryptionResults += message.decrypted
      PushMessageHandler.handle(context, message)
    }

    override fun onRegistrationFailed(context: Context, reason: FailedReason, instance: String) = Unit

    override fun onUnregistered(context: Context, instance: String) = Unit
  }

  private class MemoryKeyManager : KeyManager {
    private val keys = mutableMapOf<String, KeyMaterial>()

    override fun decrypt(instance: String, sealed: ByteArray): ByteArray? {
      val material = keys[instance] ?: return null
      return WebPushHybridDecrypt.Builder()
        .withAuthSecret(material.authSecret)
        .withRecipientPublicKey(material.keyPair.public as ECPublicKey)
        .withRecipientPrivateKey(material.keyPair.private as ECPrivateKey)
        .build()
        .decrypt(sealed, null)
    }

    override fun generate(instance: String) {
      val generator = KeyPairGenerator.getInstance("EC")
      generator.initialize(ECGenParameterSpec("secp256r1"))
      keys[instance] = KeyMaterial(generator.generateKeyPair(), SecureRandom().generateSeed(16))
    }

    override fun getPublicKeySet(instance: String): PublicKeySet? = keys[instance]?.let { material ->
      val publicKey = material.keyPair.public as ECPublicKey
      PublicKeySet(
        encodeBase64Url(encodeUncompressed(publicKey)),
        encodeBase64Url(material.authSecret),
      )
    }

    override fun exists(instance: String): Boolean = keys.containsKey(instance)

    override fun delete(instance: String) {
      keys.remove(instance)
    }

    private fun encodeUncompressed(key: ECPublicKey): ByteArray =
      byteArrayOf(4) + fixedWidth(key.w.affineX) + fixedWidth(key.w.affineY)

    private fun fixedWidth(value: BigInteger): ByteArray {
      val encoded = value.toByteArray()
      val result = ByteArray(32)
      val sourceOffset = maxOf(0, encoded.size - result.size)
      encoded.copyInto(
        result,
        destinationOffset = maxOf(0, result.size - encoded.size),
        startIndex = sourceOffset,
      )
      return result
    }

    private fun encodeBase64Url(value: ByteArray): String =
      Base64.encodeToString(value, Base64.URL_SAFE or Base64.NO_PADDING or Base64.NO_WRAP)

    private data class KeyMaterial(
      val keyPair: KeyPair,
      val authSecret: ByteArray,
    )
  }

  private companion object {
    const val INSTANCE = "multica-alerts-test"
    const val ACTION_REGISTER = "org.unifiedpush.android.distributor.REGISTER"
    const val ACTION_NEW_ENDPOINT = "org.unifiedpush.android.connector.NEW_ENDPOINT"
    const val ACTION_MESSAGE = "org.unifiedpush.android.connector.MESSAGE"
    const val ACTION_UNREGISTERED = "org.unifiedpush.android.connector.UNREGISTERED"
    const val ACTION_REGISTRATION_FAILED = "org.unifiedpush.android.connector.REGISTRATION_FAILED"
    const val EXTRA_TOKEN = "token"
    const val EXTRA_ENDPOINT = "endpoint"
    const val EXTRA_BYTES_MESSAGE = "bytesMessage"
    const val EXTRA_MESSAGE_ID = "id"
  }
}

class TestManifestMessagingReceiver : MessagingReceiver() {
  override fun onReceive(context: Context, intent: Intent) = Unit

  override fun onNewEndpoint(context: Context, endpoint: PushEndpoint, instance: String) = Unit

  override fun onRegistrationFailed(context: Context, reason: FailedReason, instance: String) = Unit

  override fun onUnregistered(context: Context, instance: String) = Unit

  override fun onMessage(context: Context, message: PushMessage, instance: String) = Unit
}
