/*
 * NOT COMPILED, NOT RUN, NO DEVICE.
 *
 * This file was written against the plugin contract in
 * packages/courier-capacitor/src/definitions.ts and cross-reviewed against the
 * Swift half. It has never seen a Kotlin compiler, an Android SDK, or a radio.
 * Expect the first build to find real errors, and see
 * packages/courier-capacitor/NATIVE-STATUS.md for the defects already known and
 * not yet fixed.
 */
/*
 * Courier — the peripheral half.
 *
 * A BluetoothGattServer carrying the Courier service, plus the advertisement
 * that lets a scanning peer find it. This file's entire job is:
 *
 *   - stand up the service and its two characteristics,
 *   - advertise the service UUID and the device label,
 *   - hand received bytes up,
 *   - take bytes to notify, and say honestly when the stack refused them,
 *   - report connects, MTU changes and disconnects.
 *
 * There is no framing, no chunking, no reassembly, no ordering and no retry in
 * here. All of that is in @courier/ble, in TypeScript, with tests that run on a
 * laptop with no radio. If you are about to add protocol logic to this file,
 * it belongs on the other side of the bridge.
 *
 * Packet contents are NEVER logged. They are scouting records belonging to
 * minors' teams. Connection lifecycle only.
 */
package com.courier.ble

import android.annotation.SuppressLint
import android.bluetooth.BluetoothAdapter
import android.bluetooth.BluetoothDevice
import android.bluetooth.BluetoothGatt
import android.bluetooth.BluetoothGattCharacteristic
import android.bluetooth.BluetoothGattDescriptor
import android.bluetooth.BluetoothGattServer
import android.bluetooth.BluetoothGattServerCallback
import android.bluetooth.BluetoothGattService
import android.bluetooth.BluetoothManager
import android.bluetooth.BluetoothProfile
import android.bluetooth.BluetoothStatusCodes
import android.bluetooth.le.AdvertiseCallback
import android.bluetooth.le.AdvertiseData
import android.bluetooth.le.AdvertiseSettings
import android.bluetooth.le.BluetoothLeAdvertiser
import android.content.Context
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.os.ParcelUuid
import android.util.Log
import java.util.UUID
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.atomic.AtomicBoolean

/**
 * The GATT profile.
 *
 * Fixed constants, mirrored from packages/courier-ble/src/gatt.ts. Two Courier
 * devices that cannot agree on a UUID cannot find each other, and there is no
 * negotiation channel before the connection exists — so these are not
 * configurable and must not drift from the TypeScript.
 */
internal object CourierProfile {
    val SERVICE: UUID = UUID.fromString("c0117e12-9a3f-4c8d-8e21-6b7a5f0d1e40")

    /** Central writes packets here. */
    val RX: UUID = UUID.fromString("c0117e12-9a3f-4c8d-8e21-6b7a5f0d1e41")

    /** Peripheral notifies packets here. */
    val TX: UUID = UUID.fromString("c0117e12-9a3f-4c8d-8e21-6b7a5f0d1e42")

    /** Client Characteristic Configuration, from the SIG's assigned numbers. */
    val CCCD: UUID = UUID.fromString("00002902-0000-1000-8000-00805f9b34fb")

    /** An unnegotiated BLE connection. Matches MIN_MTU in gatt.ts. */
    const val MIN_MTU = 23

    /** What we ask for. Matches PREFERRED_MTU in gatt.ts. */
    const val PREFERRED_MTU = 247

    /** ATT overhead on a notification or a write: 1 opcode + 2 handle. */
    const val ATT_OVERHEAD = 3

    /**
     * How much label fits in a legacy scan response.
     *
     * A legacy BLE advertisement and its scan response are 31 bytes each. The
     * scan response carries one Service Data - 128-bit UUID structure: 1 length
     * byte + 1 type byte + 16 UUID bytes = 18, leaving 13 for the label.
     *
     * Bluetooth 5 extended advertising would carry the whole thing, but its
     * PDUs are invisible to legacy scanners, and an FRC team's device fleet is
     * whatever was donated over the last decade. Being findable by an old
     * tablet is worth more than a long label, so: legacy advertising, and
     * labels longer than 13 bytes are truncated over the air.
     */
    const val MAX_LABEL_BYTES = 13
}

/** What happened when one packet was handed to the stack. */
internal enum class SendResult {
    /** The stack took it. */
    ACCEPTED,

    /**
     * The stack did not take it, and a completion callback is outstanding that
     * will fire `readyToWrite`. The caller reports `accepted: false` and waits.
     */
    REFUSED,

    /**
     * The stack did not take it and no callback is coming, so nothing will wake
     * the writer unless the caller arranges it. Rare; see the plugin's retry
     * hint.
     */
    REFUSED_NO_CALLBACK,

    /** There is no path to this peer at all. */
    GONE,
}

/**
 * The peripheral role.
 *
 * Permission checking lives in the plugin, which is the only caller; every
 * entry point here is reached only after it has verified BLUETOOTH_CONNECT and
 * BLUETOOTH_ADVERTISE (API 31+). SecurityException is still caught at each
 * platform call, because a permission can be revoked between the check and the
 * call and a crashed sync is worse than a refused one.
 */
@SuppressLint("MissingPermission")
internal class CourierGattServer(
    private val context: Context,
    private val adapter: BluetoothAdapter,
    private val peers: PeerRegistry,
    private val events: CourierEvents,
) {
    private companion object {
        const val TAG = "CourierBle"

        /**
         * How long to wait for onServiceAdded before giving up.
         *
         * Unverified: service registration is documented as asynchronous but
         * not bounded, and I have no device to measure it on. Five seconds is
         * chosen to be far longer than any plausible registration and short
         * enough that an operator does not think the app has hung.
         */
        const val SERVICE_TIMEOUT_MS = 5_000L
    }

    private class ServerPeer(val device: BluetoothDevice, val peerId: String) {
        @Volatile
        var mtu: Int = CourierProfile.MIN_MTU

        /** True once the central has written ENABLE_NOTIFICATION to the CCCD. */
        @Volatile
        var subscribed: Boolean = false

        /**
         * One notification at a time.
         *
         * The framework documents that an application must wait for
         * onNotificationSent before sending another notification. Unverified
         * whether that limit is per-device or per-server: the wording is
         * ambiguous and I have no hardware to test two simultaneous centrals
         * on. This tracks it per-device, which is what every implementation I
         * have read does; if it turns out to be per-server, the fix is to move
         * this flag up to the enclosing class.
         */
        val notifyInFlight = AtomicBoolean(false)

        /**
         * Set when a notification was refused, cleared when the wake-up lands.
         *
         * `readyToWrite` means "you may retry now". Firing it after every
         * completed notification, refused or not, spends the bridge once per
         * packet — 40 extra crossings on a single frame — and makes the event
         * mean nothing. Swift only signals peers it actually refused; match it.
         */
        val readyOwed = AtomicBoolean(false)
    }

    private class PendingStart(val label: String, val done: (String?) -> Unit)

    private val main = Handler(Looper.getMainLooper())

    /** Keyed by the opaque peerId, never by address. */
    private val connected = ConcurrentHashMap<String, ServerPeer>()

    private var server: BluetoothGattServer? = null
    private var tx: BluetoothGattCharacteristic? = null
    private var advertiser: BluetoothLeAdvertiser? = null
    private var advertiseCallback: AdvertiseCallback? = null
    private var serviceReady = false
    private var pendingStart: PendingStart? = null
    private var serviceTimeout: Runnable? = null

    /* ---------------------------------------------------------------------- */
    /* Advertising                                                            */
    /* ---------------------------------------------------------------------- */

    /**
     * Open the GATT server if needed and start advertising.
     *
     * [done] is called with null on success or an operator-readable sentence on
     * failure, exactly once.
     */
    fun startAdvertising(label: String, done: (String?) -> Unit) {
        val callback = once(done)

        val adv = try {
            adapter.bluetoothLeAdvertiser
        } catch (e: SecurityException) {
            null
        }
        if (adv == null) {
            callback(
                "This device cannot advertise over Bluetooth, so other devices cannot find it. " +
                    "It can still join a sync that another device starts, and it can always " +
                    "exchange data over USB or QR.",
            )
            return
        }
        advertiser = adv

        val failure = ensureServer()
        if (failure != null) {
            callback(failure)
            return
        }

        // Restarting with a new label is legitimate — the operator renamed the
        // device — so drop any advertisement already running.
        stopAdvertising()

        // ...and settle any earlier start still waiting on service registration,
        // or its promise never resolves and its caller waits forever.
        serviceTimeout?.let { main.removeCallbacks(it) }
        serviceTimeout = null
        pendingStart?.done("Superseded by a later startAdvertising call.")
        pendingStart = null

        val start = PendingStart(label, callback)
        if (serviceReady) {
            beginAdvertising(start)
        } else {
            pendingStart = start
            val timeout = Runnable {
                if (serviceReady) return@Runnable
                val waiting = pendingStart ?: return@Runnable
                pendingStart = null
                waiting.done(
                    "Android did not register the Courier GATT service within " +
                        "${SERVICE_TIMEOUT_MS / 1000} seconds. Turning Bluetooth off and on " +
                        "again usually clears this.",
                )
            }
            serviceTimeout = timeout
            main.postDelayed(timeout, SERVICE_TIMEOUT_MS)
        }
    }

    private fun beginAdvertising(start: PendingStart) {
        val adv = advertiser ?: run {
            start.done("This device cannot advertise over Bluetooth.")
            return
        }

        // ADVERTISE_MODE_LOW_LATENCY costs battery, which is the reason
        // stopAdvertising() exists: a device is expected to advertise only
        // while its operator wants to be found, not all day. Discovery latency
        // is what an operator experiences as "it doesn't work", so while we are
        // advertising at all, we advertise fast.
        //
        // TX power MEDIUM rather than HIGH: the stands are dense with radios
        // and a Courier mesh is a room-scale thing, not a field-scale one.
        val settings = AdvertiseSettings.Builder()
            .setAdvertiseMode(AdvertiseSettings.ADVERTISE_MODE_LOW_LATENCY)
            .setTxPowerLevel(AdvertiseSettings.ADVERTISE_TX_POWER_MEDIUM)
            .setConnectable(true)
            .setTimeout(0)
            .build()

        // The primary advertisement carries the service UUID and nothing else:
        // 3 bytes of flags plus 18 for a 128-bit UUID leaves 10 of the 31, and
        // the UUID is what a peer's ScanFilter matches on, so it goes here
        // rather than in the scan response where offloaded filters may not see
        // it.
        val advertiseData = AdvertiseData.Builder()
            .setIncludeDeviceName(false)
            .setIncludeTxPowerLevel(false)
            .addServiceUuid(ParcelUuid(CourierProfile.SERVICE))
            .build()

        // The label goes in the scan response as service data.
        //
        // setIncludeDeviceName(true) would advertise the *adapter* name — "Galaxy
        // Tab A8", or whatever the owner called their phone — not the Courier
        // device label. The only way to change that is BluetoothAdapter.setName,
        // which renames the whole device for every app and every pairing, so it
        // is not on the table. Service data is the honest place for a label that
        // belongs to Courier.
        //
        // Interop note for the Swift half: this is AD type 0x21 (Service Data,
        // 128-bit UUID) under the Courier service UUID, value = UTF-8 label. iOS
        // reads it from CBAdvertisementDataServiceDataKey. When it is absent,
        // the scanner falls back to the advertised local name, which is what an
        // iOS peripheral publishes via CBAdvertisementDataLocalNameKey.
        val labelBytes = truncateUtf8(start.label, CourierProfile.MAX_LABEL_BYTES)
        val scanResponse = AdvertiseData.Builder()
            .setIncludeDeviceName(false)
            .addServiceData(ParcelUuid(CourierProfile.SERVICE), labelBytes)
            .build()

        val cb = object : AdvertiseCallback() {
            override fun onStartSuccess(settingsInEffect: AdvertiseSettings) {
                Log.i(TAG, "advertising started")
                start.done(null)
            }

            override fun onStartFailure(errorCode: Int) {
                advertiseCallback = null
                Log.w(TAG, "advertising failed to start, code $errorCode")
                start.done(describeAdvertiseError(errorCode))
            }
        }
        advertiseCallback = cb

        try {
            adv.startAdvertising(settings, advertiseData, scanResponse, cb)
        } catch (e: SecurityException) {
            advertiseCallback = null
            start.done(
                "Android refused to advertise: the Nearby devices permission is not granted.",
            )
        } catch (e: IllegalArgumentException) {
            // Reachable only if the label somehow overruns the scan response;
            // truncateUtf8 is supposed to make that impossible, so report it
            // rather than swallowing it.
            advertiseCallback = null
            start.done("Android rejected the Courier advertisement payload: ${e.message}")
        }
    }

    fun stopAdvertising() {
        val cb = advertiseCallback ?: return
        advertiseCallback = null
        try {
            advertiser?.stopAdvertising(cb)
            Log.i(TAG, "advertising stopped")
        } catch (e: SecurityException) {
            Log.w(TAG, "could not stop advertising: permission revoked")
        } catch (e: IllegalStateException) {
            // Bluetooth went off underneath us; the advertisement is already dead.
        }
    }

    val isAdvertising: Boolean
        get() = advertiseCallback != null

    /* ---------------------------------------------------------------------- */
    /* The server                                                             */
    /* ---------------------------------------------------------------------- */

    /** Returns null on success, or an operator-readable reason. */
    private fun ensureServer(): String? {
        if (server != null) return null

        val manager = context.getSystemService(Context.BLUETOOTH_SERVICE) as? BluetoothManager
            ?: return "This device does not expose a Bluetooth service to apps."

        val opened = try {
            manager.openGattServer(context, serverCallback)
        } catch (e: SecurityException) {
            null
        } ?: return "Android refused to open a GATT server. Check that Bluetooth is on and that " +
            "the Nearby devices permission is granted."

        val service = BluetoothGattService(
            CourierProfile.SERVICE,
            BluetoothGattService.SERVICE_TYPE_PRIMARY,
        )

        // Both write types: a central that wants acknowledgement can use plain
        // writes, and one that wants throughput can use write-without-response.
        // Which it picks is the central's business; this side handles either.
        val rx = BluetoothGattCharacteristic(
            CourierProfile.RX,
            BluetoothGattCharacteristic.PROPERTY_WRITE or
                BluetoothGattCharacteristic.PROPERTY_WRITE_NO_RESPONSE,
            BluetoothGattCharacteristic.PERMISSION_WRITE,
        )

        // No PERMISSION_*_ENCRYPTED anywhere, deliberately. Requiring encryption
        // would force BLE bonding, which means a pairing dialog on both devices
        // in the stands during a match. Courier does not need the transport to
        // be trusted: every record is individually signed with Ed25519 and the
        // key registry decides whose records are admitted. An eavesdropper sees
        // signed scouting data; a forger is rejected by signature check.
        val txc = BluetoothGattCharacteristic(
            CourierProfile.TX,
            BluetoothGattCharacteristic.PROPERTY_NOTIFY,
            BluetoothGattCharacteristic.PERMISSION_READ,
        )
        txc.addDescriptor(
            BluetoothGattDescriptor(
                CourierProfile.CCCD,
                BluetoothGattDescriptor.PERMISSION_READ or
                    BluetoothGattDescriptor.PERMISSION_WRITE,
            ),
        )

        service.addCharacteristic(rx)
        service.addCharacteristic(txc)

        server = opened
        tx = txc
        serviceReady = false

        val queued = try {
            opened.addService(service)
        } catch (e: SecurityException) {
            false
        }
        if (!queued) {
            close(notify = false, reason = null)
            return "Android refused to register the Courier GATT service."
        }
        return null
    }

    /* ---------------------------------------------------------------------- */
    /* Peers                                                                  */
    /* ---------------------------------------------------------------------- */

    /** Connected and subscribed: writable. */
    fun isReady(peerId: String): Boolean = connected[peerId]?.subscribed == true

    /** Connected, whether or not it has subscribed yet. */
    fun isConnected(peerId: String): Boolean = connected.containsKey(peerId)

    fun mtuFor(peerId: String): Int = connected[peerId]?.mtu ?: CourierProfile.MIN_MTU

    /**
     * Notify one packet to a subscribed central.
     *
     * The backpressure contract: exactly one notification is in flight per peer
     * at a time. A second one is REFUSED, and onNotificationSent will fire
     * `readyToWrite` when the first clears. This is the Android analogue of
     * iOS's `updateValue` returning false, and under load it is the common
     * path, not an error path.
     */
    fun send(peerId: String, packet: ByteArray): SendResult {
        val peer = connected[peerId] ?: return SendResult.GONE
        if (!peer.subscribed) return SendResult.GONE
        val srv = server ?: return SendResult.GONE
        val characteristic = tx ?: return SendResult.GONE

        if (!peer.notifyInFlight.compareAndSet(false, true)) {
            // A wake-up is now owed; onNotificationSent will deliver it.
            peer.readyOwed.set(true)
            return SendResult.REFUSED
        }

        val taken = try {
            notifyCompat(srv, peer.device, characteristic, packet)
        } catch (e: SecurityException) {
            peer.notifyInFlight.set(false)
            return SendResult.GONE
        }

        if (!taken) {
            // The stack said no with nothing of ours outstanding — typically
            // ERROR_GATT_WRITE_BUSY from another operation on the same
            // connection. No onNotificationSent will follow for an attempt that
            // was never queued, so the caller has to arrange the wake-up.
            peer.notifyInFlight.set(false)
            // No callback is coming, so the plugin schedules the wake-up itself.
            // It must not also arrive from a later completion.
            peer.readyOwed.set(false)
            return SendResult.REFUSED_NO_CALLBACK
        }
        return SendResult.ACCEPTED
    }

    @Suppress("DEPRECATION")
    private fun notifyCompat(
        srv: BluetoothGattServer,
        device: BluetoothDevice,
        characteristic: BluetoothGattCharacteristic,
        packet: ByteArray,
    ): Boolean {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            val status = srv.notifyCharacteristicChanged(device, characteristic, false, packet)
            if (status != BluetoothStatusCodes.SUCCESS) {
                Log.d(TAG, "notify refused, status $status")
            }
            return status == BluetoothStatusCodes.SUCCESS
        }
        // The pre-33 API carries the value on the characteristic object, which
        // is shared by every subscribed device. Setting it and notifying must
        // therefore be atomic with respect to other senders, or two peers race
        // and one receives the other's bytes.
        return synchronized(characteristic) {
            characteristic.value = packet
            srv.notifyCharacteristicChanged(device, characteristic, false)
        }
    }

    fun disconnect(peerId: String) {
        val peer = connected.remove(peerId) ?: return
        Log.i(TAG, "server disconnecting $peerId")
        try {
            server?.cancelConnection(peer.device)
        } catch (e: SecurityException) {
            // Nothing useful to do; the disconnect below still reports the truth.
        }
        // cancelConnection is not documented to produce onConnectionStateChange,
        // so report the disconnect ourselves. The entry is already out of the
        // map, so a callback that does arrive will not emit a second event.
        events.onDisconnected(peerId, "disconnected locally")
    }

    fun close(notify: Boolean, reason: String?) {
        stopAdvertising()
        serviceTimeout?.let { main.removeCallbacks(it) }
        serviceTimeout = null
        // Settle rather than drop: a startAdvertising still waiting on service
        // registration when Bluetooth goes off must be told, not left hanging.
        pendingStart?.done(reason ?: "Advertising was stopped before it started.")
        pendingStart = null

        val srv = server
        val open = connected.values.toList()
        connected.clear()
        for (peer in open) {
            try {
                srv?.cancelConnection(peer.device)
            } catch (e: SecurityException) {
                // ignored; we are tearing down
            }
            if (notify) events.onDisconnected(peer.peerId, reason)
        }
        try {
            srv?.close()
        } catch (e: SecurityException) {
            // ignored; we are tearing down
        }
        server = null
        tx = null
        serviceReady = false
    }

    private fun peerFor(device: BluetoothDevice): ServerPeer {
        val peerId = peers.idFor(device)
        connected[peerId]?.let { return it }
        // putIfAbsent rather than getOrPut: callbacks arrive on binder threads,
        // and two ServerPeer objects for one connection would mean two
        // independent in-flight flags and a lost notification slot.
        val fresh = ServerPeer(device, peerId)
        return connected.putIfAbsent(peerId, fresh) ?: fresh
    }

    /* ---------------------------------------------------------------------- */
    /* Callbacks                                                              */
    /* ---------------------------------------------------------------------- */

    private val serverCallback = object : BluetoothGattServerCallback() {

        override fun onServiceAdded(status: Int, service: BluetoothGattService) {
            if (service.uuid != CourierProfile.SERVICE) return
            serviceTimeout?.let { main.removeCallbacks(it) }
            serviceTimeout = null
            val waiting = pendingStart
            pendingStart = null

            if (status == BluetoothGatt.GATT_SUCCESS) {
                serviceReady = true
                Log.i(TAG, "Courier GATT service registered")
                waiting?.let { beginAdvertising(it) }
            } else {
                Log.w(TAG, "Courier GATT service registration failed, status $status")
                waiting?.done(
                    "Android could not register the Courier GATT service (status $status).",
                )
            }
        }

        override fun onConnectionStateChange(device: BluetoothDevice, status: Int, newState: Int) {
            when (newState) {
                BluetoothProfile.STATE_CONNECTED -> {
                    val peer = peerFor(device)
                    Log.i(TAG, "central connected: ${peer.peerId}")
                }

                BluetoothProfile.STATE_DISCONNECTED -> {
                    // Look up without minting a new handle: a device we never
                    // tracked disconnecting is not an event anyone wants.
                    val peerId = peers.knownIdFor(device) ?: return
                    if (connected.remove(peerId) == null) return
                    Log.i(TAG, "central disconnected: $peerId (status $status)")
                    events.onDisconnected(peerId, describeGattStatus(status))
                }
            }
        }

        override fun onMtuChanged(device: BluetoothDevice, mtu: Int) {
            val peer = peerFor(device)
            peer.mtu = mtu
            Log.i(TAG, "ATT MTU for ${peer.peerId} is now $mtu")
        }

        override fun onCharacteristicWriteRequest(
            device: BluetoothDevice,
            requestId: Int,
            characteristic: BluetoothGattCharacteristic,
            preparedWrite: Boolean,
            responseNeeded: Boolean,
            offset: Int,
            value: ByteArray?,
        ) {
            val srv = server
            if (characteristic.uuid != CourierProfile.RX) {
                if (responseNeeded) {
                    srv?.trySendResponse(
                        device, requestId, BluetoothGatt.GATT_REQUEST_NOT_SUPPORTED, offset, null,
                    )
                }
                return
            }

            // Long (prepared) writes cannot happen by construction: the framing
            // layer sizes every packet to fit one ATT write at the negotiated
            // MTU. Anything else is a peer that is not speaking Courier, and
            // guessing at its intent is worse than refusing it.
            if (preparedWrite || offset != 0) {
                if (responseNeeded) {
                    srv?.trySendResponse(
                        device, requestId, BluetoothGatt.GATT_REQUEST_NOT_SUPPORTED, offset, null,
                    )
                }
                return
            }

            // Only from a central that has actually subscribed, i.e. one JS was
            // told about via peerFound. `peerFor` would MINT a handle here, so a
            // stranger writing to RX would produce packets tagged with a peerId
            // that no transport is listening for — silently discarded, and
            // indistinguishable from radio loss when someone goes looking.
            // Swift refuses this write; match it.
            val known = peers.knownIdFor(device)
            val peer = known?.let { connected[it] }
            if (peer == null || !peer.subscribed) {
                if (responseNeeded) {
                    srv?.trySendResponse(
                        device, requestId, BluetoothGatt.GATT_REQUEST_NOT_SUPPORTED, offset, null,
                    )
                }
                return
            }

            // Answer at the ATT layer first: the peer's flow control is waiting
            // on it, and the bridge hop to JS is comparatively slow.
            if (responseNeeded) {
                srv?.trySendResponse(device, requestId, BluetoothGatt.GATT_SUCCESS, 0, value)
            }
            if (value == null || value.isEmpty()) return
            events.onPacket(peer.peerId, value)
        }

        override fun onDescriptorReadRequest(
            device: BluetoothDevice,
            requestId: Int,
            offset: Int,
            descriptor: BluetoothGattDescriptor,
        ) {
            if (descriptor.uuid != CourierProfile.CCCD) {
                server?.trySendResponse(
                    device, requestId, BluetoothGatt.GATT_REQUEST_NOT_SUPPORTED, offset, null,
                )
                return
            }
            val known = peers.knownIdFor(device)
            val subscribed = known != null && connected[known]?.subscribed == true
            val state = if (subscribed) {
                BluetoothGattDescriptor.ENABLE_NOTIFICATION_VALUE
            } else {
                BluetoothGattDescriptor.DISABLE_NOTIFICATION_VALUE
            }
            server?.trySendResponse(device, requestId, BluetoothGatt.GATT_SUCCESS, offset, state)
        }

        override fun onDescriptorWriteRequest(
            device: BluetoothDevice,
            requestId: Int,
            descriptor: BluetoothGattDescriptor,
            preparedWrite: Boolean,
            responseNeeded: Boolean,
            offset: Int,
            value: ByteArray?,
        ) {
            val srv = server
            val isCourierCccd = descriptor.uuid == CourierProfile.CCCD &&
                descriptor.characteristic?.uuid == CourierProfile.TX
            if (!isCourierCccd) {
                if (responseNeeded) {
                    srv?.trySendResponse(
                        device, requestId, BluetoothGatt.GATT_REQUEST_NOT_SUPPORTED, offset, null,
                    )
                }
                return
            }

            val enable = value != null &&
                value.contentEquals(BluetoothGattDescriptor.ENABLE_NOTIFICATION_VALUE)
            val peer = peerFor(device)
            val was = peer.subscribed
            peer.subscribed = enable

            if (responseNeeded) {
                srv?.trySendResponse(device, requestId, BluetoothGatt.GATT_SUCCESS, offset, value)
            }

            if (enable && !was) {
                // Subscription, not connection, is the moment this peer becomes
                // usable — and by then the MTU exchange has normally happened,
                // so the MTU reported here is the real one rather than 23. That
                // ordering is why `peerFound` is emitted from the CCCD write
                // and not from onConnectionStateChange.
                //
                // Unverified: that ordering is what the Courier central does
                // (MTU, then discovery, then CCCD) and what the BLE spec makes
                // natural, but I have not watched it on a sniffer. If an MTU
                // exchange ever lands after the CCCD write, this peer starts at
                // MTU 23 and stays there for the session — correct, just slow.
                Log.i(TAG, "central ${peer.peerId} subscribed, mtu ${peer.mtu}")
                events.onPeerFound(peer.peerId, labelOf(device), null)
            } else if (!enable && was) {
                Log.i(TAG, "central ${peer.peerId} unsubscribed")
            }
        }

        override fun onNotificationSent(device: BluetoothDevice, status: Int) {
            val peerId = peers.knownIdFor(device) ?: return
            val peer = connected[peerId] ?: return
            peer.notifyInFlight.set(false)
            if (status != BluetoothGatt.GATT_SUCCESS) {
                Log.w(TAG, "notification to $peerId failed, status $status")
            }
            // Only when a wake-up is owed — but owed either way, success or
            // failure: a failed notification still frees the slot, and letting
            // a waiting writer retry beats letting it hang. What changes is that
            // a writer which was never refused is no longer told anything.
            if (peer.readyOwed.compareAndSet(true, false)) {
                events.onReadyToWrite(peerId)
            }
        }
    }

    /**
     * The remote's Bluetooth adapter name.
     *
     * A central that connected to us was not advertising, so its Courier label
     * is not available over the air — this is the best that exists. It is still
     * a DEVICE name: Android's own name for the hardware, which the owner may
     * have edited. Courier never asks for or transmits a person's name.
     */
    private fun labelOf(device: BluetoothDevice): String {
        // Deliberately empty, and deliberately NOT device.name.
        //
        // An Android adapter name is very often a person's name — "Eric's
        // Pixel" is the default on a lot of phones. CourierPeer.label is
        // documented as a DEVICE label and never a person's, and a value read
        // here crosses the bridge, lands in the UI, and ends up pasted into bug
        // reports. This project holds no personal data and this is one of the
        // few places it could arrive by accident.
        //
        // A central that connected to us was not advertising, so no Courier
        // label exists over the air. Empty is the honest answer; the UI renders
        // "unnamed device". It also saves a BLUETOOTH_CONNECT-gated call.
        // Matches CourierPeripheral.swift, which refuses for the same reason.
        return ""
    }
}

/** sendResponse throws if the connection dropped mid-request; that is not fatal. */
@SuppressLint("MissingPermission")
private fun BluetoothGattServer.trySendResponse(
    device: BluetoothDevice,
    requestId: Int,
    status: Int,
    offset: Int,
    value: ByteArray?,
) {
    try {
        sendResponse(device, requestId, status, offset, value)
    } catch (e: SecurityException) {
        // permission revoked mid-connection; the link is finished anyway
    } catch (e: IllegalStateException) {
        // the peer went away between the request and the response
    }
}

/** Cut a UTF-8 string to at most [max] bytes without splitting a code point. */
internal fun truncateUtf8(text: String, max: Int): ByteArray {
    val bytes = text.toByteArray(Charsets.UTF_8)
    if (bytes.size <= max) return bytes
    var end = max
    // Continuation bytes are 10xxxxxx; back up off one to land on a boundary.
    while (end > 0 && (bytes[end].toInt() and 0xC0) == 0x80) end--
    return bytes.copyOfRange(0, end)
}

internal fun describeAdvertiseError(code: Int): String = when (code) {
    AdvertiseCallback.ADVERTISE_FAILED_ALREADY_STARTED ->
        "This device is already advertising."
    AdvertiseCallback.ADVERTISE_FAILED_DATA_TOO_LARGE ->
        "The Courier advertisement does not fit in this device's advertising packet."
    AdvertiseCallback.ADVERTISE_FAILED_FEATURE_UNSUPPORTED ->
        "This device's Bluetooth chipset cannot advertise, so other devices cannot find it. " +
            "It can still join a sync that another device starts, or exchange data by USB or QR."
    AdvertiseCallback.ADVERTISE_FAILED_INTERNAL_ERROR ->
        "Android's Bluetooth stack failed while starting the advertisement. Turning Bluetooth " +
            "off and on again usually clears this."
    AdvertiseCallback.ADVERTISE_FAILED_TOO_MANY_ADVERTISERS ->
        "Too many apps on this device are advertising over Bluetooth. Close some and try again."
    else -> "Advertising failed to start (Android error code $code)."
}

/**
 * A readable form of the GATT status on a disconnect.
 *
 * Only the codes worth telling an operator apart are named; the rest carry the
 * number so a bug report can say something specific.
 */
internal fun describeGattStatus(status: Int): String = when (status) {
    BluetoothGatt.GATT_SUCCESS -> "peer closed the connection"
    8 -> "connection timed out — the peer moved out of range or its screen slept"
    19 -> "peer closed the connection"
    22 -> "the local Bluetooth stack closed the connection"
    133 -> "Android's generic GATT error (133), usually range or a busy radio"
    else -> "connection ended (GATT status $status)"
}
