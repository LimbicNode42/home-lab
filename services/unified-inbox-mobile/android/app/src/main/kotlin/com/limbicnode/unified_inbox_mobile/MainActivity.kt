package com.limbicnode.unified_inbox_mobile

import android.Manifest
import android.app.Activity
import android.app.Service
import android.app.role.RoleManager
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.os.IBinder
import android.provider.Telephony
import android.widget.Toast
import androidx.core.content.ContextCompat
import androidx.security.crypto.EncryptedSharedPreferences
import androidx.security.crypto.MasterKey
import io.flutter.embedding.android.FlutterActivity
import io.flutter.embedding.engine.FlutterEngine
import io.flutter.plugin.common.MethodChannel
import org.json.JSONArray
import org.json.JSONObject
import java.security.MessageDigest
import java.time.Instant

private const val CHANNEL = "com.limbicnode.unified_inbox_mobile/android_sms_mms"
private const val REQUEST_ROLE_SMS = 6101
private const val REQUEST_SMS_PERMISSIONS = 6102
private val SMS_PERMISSIONS = arrayOf(
    Manifest.permission.READ_SMS,
    Manifest.permission.RECEIVE_SMS,
    Manifest.permission.RECEIVE_MMS,
)

class MainActivity : FlutterActivity() {
    private var roleResult: MethodChannel.Result? = null
    private var permissionResult: MethodChannel.Result? = null

    override fun configureFlutterEngine(flutterEngine: FlutterEngine) {
        super.configureFlutterEngine(flutterEngine)
        MethodChannel(flutterEngine.dartExecutor.binaryMessenger, CHANNEL).setMethodCallHandler { call, result ->
            when (call.method) {
                "getRoleState" -> result.success(roleState())
                "requestDefaultSmsRole" -> requestDefaultSmsRole(result)
                "requestSmsPermissions" -> requestSmsPermissions(result)
                "queuedCount" -> result.success(AndroidSmsMmsEncryptedQueue(this).count())
                "drainStagedMessages" -> result.success(AndroidSmsMmsEncryptedQueue(this).drain())
                else -> result.notImplemented()
            }
        }
    }

    private fun roleState(): Map<String, Any?> = mapOf(
        "platform" to "android",
        "roleAvailable" to isSmsRoleAvailable(),
        "roleHeld" to isDefaultSmsApp(),
        "permissionState" to permissionState(),
        "queuedCount" to AndroidSmsMmsEncryptedQueue(this).count(),
        "lastSyncAt" to AndroidSmsMmsEncryptedQueue(this).lastSyncAt(),
    )

    private fun isSmsRoleAvailable(): Boolean = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
        val roleManager = getSystemService(RoleManager::class.java)
        roleManager.isRoleAvailable(RoleManager.ROLE_SMS)
    } else {
        true
    }

    private fun isDefaultSmsApp(): Boolean = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
        val roleManager = getSystemService(RoleManager::class.java)
        roleManager.isRoleHeld(RoleManager.ROLE_SMS)
    } else {
        Telephony.Sms.getDefaultSmsPackage(this) == packageName
    }

    private fun permissionState(): String = if (SMS_PERMISSIONS.all { ContextCompat.checkSelfPermission(this, it) == PackageManager.PERMISSION_GRANTED }) {
        "granted"
    } else {
        "not_requested"
    }

    private fun requestDefaultSmsRole(result: MethodChannel.Result) {
        roleResult = result
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            val roleManager = getSystemService(RoleManager::class.java)
            if (!roleManager.isRoleAvailable(RoleManager.ROLE_SMS)) {
                roleResult?.success(false)
                roleResult = null
                return
            }
            startActivityForResult(roleManager.createRequestRoleIntent(RoleManager.ROLE_SMS), REQUEST_ROLE_SMS)
        } else {
            startActivityForResult(
                Intent(Telephony.Sms.Intents.ACTION_CHANGE_DEFAULT).putExtra(Telephony.Sms.Intents.EXTRA_PACKAGE_NAME, packageName),
                REQUEST_ROLE_SMS,
            )
        }
    }

    private fun requestSmsPermissions(result: MethodChannel.Result) {
        if (!isDefaultSmsApp()) {
            result.success(false)
            return
        }
        permissionResult = result
        requestPermissions(SMS_PERMISSIONS, REQUEST_SMS_PERMISSIONS)
    }

    override fun onActivityResult(requestCode: Int, resultCode: Int, data: Intent?) {
        super.onActivityResult(requestCode, resultCode, data)
        if (requestCode == REQUEST_ROLE_SMS) {
            roleResult?.success(resultCode == Activity.RESULT_OK || isDefaultSmsApp())
            roleResult = null
        }
    }

    override fun onRequestPermissionsResult(requestCode: Int, permissions: Array<out String>, grantResults: IntArray) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults)
        if (requestCode == REQUEST_SMS_PERMISSIONS) {
            permissionResult?.success(grantResults.isNotEmpty() && grantResults.all { it == PackageManager.PERMISSION_GRANTED })
            permissionResult = null
        }
    }
}

class SmsDeliverReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        if (intent.action != Telephony.Sms.Intents.SMS_DELIVER_ACTION) return
        val queue = AndroidSmsMmsEncryptedQueue(context)
        val messages = Telephony.Sms.Intents.getMessagesFromIntent(intent)
        for (message in messages) {
            queue.enqueue(
                JSONObject()
                    .put("local_provider", "sms")
                    .put("provider_row_id", stableId(message.originatingAddress, message.timestampMillis.toString(), message.messageBody))
                    .put("address", message.originatingAddress ?: "unknown")
                    .put("body", message.messageBody)
                    .put("date_millis", message.timestampMillis)
                    .put("received_at", Instant.now().toString())
                    .toString(),
            )
        }
    }
}

class MmsWapPushReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        if (intent.action != Telephony.Sms.Intents.WAP_PUSH_DELIVER_ACTION) return
        AndroidSmsMmsEncryptedQueue(context).enqueue(
            JSONObject()
                .put("local_provider", "mms")
                .put("provider_row_id", stableId(intent.type ?: "mms", System.currentTimeMillis().toString(), "metadata-only"))
                .put("content_type", intent.type ?: "application/vnd.wap.mms-message")
                .put("metadata_only", true)
                .put("received_at", Instant.now().toString())
                .toString(),
        )
    }
}

class SmsSendToReadOnlyActivity : Activity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        Toast.makeText(this, "Unified Inbox is read-only; SMS/MMS sending is disabled.", Toast.LENGTH_LONG).show()
        finish()
    }
}

class RespondViaMessageReadOnlyService : Service() {
    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        Toast.makeText(this, "Unified Inbox is read-only; respond-via-message is disabled.", Toast.LENGTH_LONG).show()
        stopSelf(startId)
        return START_NOT_STICKY
    }

    override fun onBind(intent: Intent?): IBinder? = null
}

class AndroidSmsMmsEncryptedQueue(context: Context) {
    private val prefs by lazy {
        val masterKey = MasterKey.Builder(context)
            .setKeyScheme(MasterKey.KeyScheme.AES256_GCM)
            .build()
        EncryptedSharedPreferences.create(
            context,
            "android_sms_mms_staging",
            masterKey,
            EncryptedSharedPreferences.PrefKeyEncryptionScheme.AES256_SIV,
            EncryptedSharedPreferences.PrefValueEncryptionScheme.AES256_GCM,
        )
    }

    fun enqueue(json: String) {
        val next = JSONArray(prefs.getString("queue", "[]"))
        next.put(json)
        prefs.edit().putString("queue", next.toString()).apply()
    }

    fun count(): Int = JSONArray(prefs.getString("queue", "[]")).length()

    fun drain(): List<String> {
        val queued = JSONArray(prefs.getString("queue", "[]"))
        val result = mutableListOf<String>()
        for (i in 0 until queued.length()) result.add(queued.getString(i))
        prefs.edit().putString("queue", "[]").putString("lastSyncAt", Instant.now().toString()).apply()
        return result
    }

    fun lastSyncAt(): String? = prefs.getString("lastSyncAt", null)
}

private fun stableId(vararg parts: String?): String {
    val digest = MessageDigest.getInstance("SHA-256")
    parts.forEach { digest.update((it ?: "").toByteArray(Charsets.UTF_8)) }
    return Uri.encode(digest.digest().joinToString("") { "%02x".format(it) }.take(24))
}
