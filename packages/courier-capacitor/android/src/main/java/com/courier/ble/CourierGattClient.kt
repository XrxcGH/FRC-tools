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
 * Courier — the central half.
 *
 * Scan for the Courier service, connect, negotiate an MTU, subscribe to the
 * peripheral's notify characteristic, and write packets to its RX
 * characteristic. Same rule as the server: no framing, no chunking, no
 * reassembly, no ordering, no retry of application data. Bytes in, bytes out,
 * and an honest answer when the stack refuses one.
 *
 * Packet contents are NEVER logged.
 */
package com.courier.ble

import android.annotation.SuppressLint
import android.bluetooth.BluetoothAdapter
import android.bluetooth.BluetoothDevice
import android.bluetooth.BluetoothGatt
import android.bluetooth.BluetoothGattCallback
import android.bluetooth.BluetoothGattCharacteristic
import android.bluetooth.BluetoothGattDescriptor
import android.bluetooth.BluetoothProfile
import android.bluetooth.BluetoothStatusCodes
import android.bluetooth.le.ScanCallback
import android.bluetooth.le.ScanFilter
import android.bluetooth.le.ScanResult
import android.bluetooth.le.ScanSettings
import android.content.Context
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.os.ParcelUuid
import android.util.Log
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicReference

/**
 * The central role.
 *
 * As with the server, permission checking lives in the plugin — the only
 * caller — and SecurityException is still caught at each platform call because
 * a permission can be revoked between the check and the call.
 */
@SuppressLint("MissingPermission")
internal class CourierGattClient(
    private val context: Context,
    private val adapter: BluetoothAdapter,
    private val peers: PeerRegistry,
    private val events: CourierEvents,
) {
    private companion object {
        const val TAG = "CourierBle"

        /**
         * Give up on a connection attempt after this long.
         *
         * Android's own connect has no timeout with autoConnect=false — it
         * fails eventually with status 133, but "eventually" is not a number
         * anyone can quote, and an operator holding two tablets together needs
         * to be told it did not work.
         *
         * 15 s, matching CourierGatt.connectTimeout on iOS. The value is a
         * judgement call rather than a measurement, but it must be the SAME
         * judgement call on both platforms: a user-visible timeout that differs
         * by platform is a support question nobody can answer.
         */
        const val CONNECT_TIMEOUT_MS = 15_000L

        /**
         * How long to wait before deciding a scan started successfully.
         *
         * BluetoothLeScanner.startScan returns void; failures arrive later via
         * onScanFailed. Holding the promise briefly turns a silent no-op into a
         * rejected promise the operator can see. Unverified: the real latency
         * of onScanFailed is not documented and I have not measured it; the
         * failures this catches (already started, registration failed, feature
         * unsupported, scanning too frequently) are all raised by the local
         * stack rather than the radio, so they should be well inside this.
         */
        const val SCAN_START_GRACE_MS = 500L

        /**
         * Don't re-report the same peer more often than this.
         *
         * At SCAN_MODE_LOW_LATENCY a nearby peer produces tens of results a
         * second; forwarding all of them would spend the bridge on nothing.
         * Re-reporting at all is worth it so the UI can refresh RSSI and so a
         * peer that is still there does not look stale.
         */
        const val PEER_REPORT_INTERVAL_MS = 5_000L

        /** One retry on the notorious status 133; see onConnectionStateChange. */
        const val MAX_CONNECT_ATTEMPTS = 2
        const val RETRY_DELAY_MS = 600L
    }

    private class ClientPeer(val peerId: String, val device: BluetoothDevice) {
        @Volatile
        var gatt: BluetoothGatt? = null

        @Volatile
        var rx: BluetoothGattCharacteristic? = null

        @Volatile
        var mtu: Int = CourierProfile.MIN_MTU

        /** Connected, discovered, subscribed: writable. */
        @Volatile
        var ready: Boolean = false

        /** Set once so a later peripheral-initiated MTU change cannot re-run it. */
        @Volatile
        var discoveryStarted: Boolean = false

        var attempts: Int = 0

        /**
         * One GATT operation at a time.
         *
         * BluetoothGatt permits a single outstanding operation per connection;
         * a second write before onCharacteristicWrite is dropped by the
         * framework. That is Android's version of iOS's full queue, and it is
         * reported the same way: `accepted: false`, then `readyToWrite`.
         */
        val writeInFlight = AtomicBoolean(false)

        /** Taken exactly once, by whichever of success/failure/timeout wins. */
        val pending = AtomicReference<((Int?, String?) -> Unit)?>(null)

        var timeout: Runnable? = null

        fun take(): ((Int?, String?) -> Unit)? = pending.getAndSet(null)
    }

    private val main = Handler(Looper.getMainLooper())
    private val connections = ConcurrentHashMap<String, ClientPeer>()
    private val lastReported = ConcurrentHashMap<String, Long>()

    private var scanning = false
    private var pendingScanStart: ((String?) -> Unit)? = null

    /* ---------------------------------------------------------------------- */
    /* Scanning                                                               */
    /* ---------------------------------------------------------------------- */

    /** [done] receives null on success or an operator-readable reason. */
    fun startScan(done: (String?) -> Unit) {
        val callback = once(done)
        val scanner = try {
            adapter.bluetoothLeScanner
        } catch (e: SecurityException) {
            null
        }
        if (scanner == null) {
            callback(
                "This device cannot scan for Bluetooth Low Energy devices, so it cannot start a " +
                    "sync. Check that Bluetooth is on.",
            )
            return
        }

        if (scanning) stopScan()
        // A fresh scan should re-report everyone, not silently skip peers that
        // were reported during the previous one.
        lastReported.clear()

        // Filtering on the service UUID in the scan settings rather than in our
        // own callback matters: on most chipsets the filter is offloaded to the
        // controller, so a stand full of phones and fitness trackers never
        // wakes the application processor.
        val filters = listOf(
            ScanFilter.Builder()
                .setServiceUuid(ParcelUuid(CourierProfile.SERVICE))
                .build(),
        )

        val settings = ScanSettings.Builder()
            // Low latency while actively syncing: this is a foreground,
            // operator-initiated action with a person waiting on it, and
            // stopScan exists so it does not run any longer than that.
            .setScanMode(ScanSettings.SCAN_MODE_LOW_LATENCY)
            .setCallbackType(ScanSettings.CALLBACK_TYPE_ALL_MATCHES)
            .setMatchMode(ScanSettings.MATCH_MODE_AGGRESSIVE)
            .setNumOfMatches(ScanSettings.MATCH_NUM_MAX_ADVERTISEMENT)
            .setReportDelay(0)
            .build()

        pendingScanStart = callback
        try {
            scanner.startScan(filters, settings, scanCallback)
        } catch (e: SecurityException) {
            pendingScanStart = null
            callback(
                "Android refused the Bluetooth scan: the Nearby devices permission is not granted.",
            )
            return
        } catch (e: IllegalStateException) {
            pendingScanStart = null
            callback("Bluetooth is off, so this device cannot scan.")
            return
        }
        scanning = true
        Log.i(TAG, "scan started")
        main.postDelayed(
            {
                if (pendingScanStart === callback) pendingScanStart = null
                callback(null)
            },
            SCAN_START_GRACE_MS,
        )
    }

    fun stopScan() {
        if (!scanning) return
        scanning = false
        try {
            adapter.bluetoothLeScanner?.stopScan(scanCallback)
            Log.i(TAG, "scan stopped")
        } catch (e: SecurityException) {
            Log.w(TAG, "could not stop the scan: permission revoked")
        } catch (e: IllegalStateException) {
            // Bluetooth went off underneath us; the scan is already dead.
        }
    }

    val isScanning: Boolean
        get() = scanning

    private val scanCallback = object : ScanCallback() {
        override fun onScanResult(callbackType: Int, result: ScanResult) = report(result)

        override fun onBatchScanResults(results: MutableList<ScanResult>) {
            for (r in results) report(r)
        }

        override fun onScanFailed(errorCode: Int) {
            scanning = false
            Log.w(TAG, "scan failed, code $errorCode")
            val waiting = pendingScanStart
            pendingScanStart = null
            waiting?.invoke(describeScanError(errorCode))
        }
    }

    private fun report(result: ScanResult) {
        val peerId = peers.idFor(result.device)
        val now = android.os.SystemClock.elapsedRealtime()
        val previous = lastReported[peerId]
        if (previous != null && now - previous < PEER_REPORT_INTERVAL_MS) return
        lastReported[peerId] = now
        // 127 is the "RSSI unavailable" sentinel, and any non-negative value is
        // meaningless for a received signal. Passing it through renders as a
        // full-strength bar, which is worse than showing nothing. Swift already
        // drops these; match it.
        val rssi = result.rssi.takeIf { it < 0 }
        events.onPeerFound(peerId, labelOf(result), rssi)
    }

    /**
     * The peer's Courier device label.
     *
     * Preference order is service data, then the advertised local name. Service
     * data is where the Android peripheral puts the label the operator chose
     * (see CourierGattServer); the local name is what an iOS peripheral
     * publishes through CBAdvertisementDataLocalNameKey and what any other
     * implementation is most likely to use.
     *
     * ScanRecord.getDeviceName reads the advertisement, unlike
     * BluetoothDevice.getName which reads the bonded-device cache and needs
     * BLUETOOTH_CONNECT — another reason to prefer it.
     */
    private fun labelOf(result: ScanResult): String {
        val record = result.scanRecord
        val serviceData = record?.getServiceData(ParcelUuid(CourierProfile.SERVICE))
        if (serviceData != null && serviceData.isNotEmpty()) {
            val label = String(serviceData, Charsets.UTF_8).trim()
            if (label.isNotEmpty()) return label
        }
        val advertised = record?.deviceName?.trim()
        if (!advertised.isNullOrEmpty()) return advertised
        // Empty, not a placeholder string. All four label paths across both
        // platforms return "" when no Courier label is available, so a UI has
        // one case to handle and can render "unnamed device" itself rather than
        // three different sentinels leaking through from three code paths.
        return ""
    }

    /* ---------------------------------------------------------------------- */
    /* Connecting                                                             */
    /* ---------------------------------------------------------------------- */

    fun isReady(peerId: String): Boolean = connections[peerId]?.ready == true

    fun mtuFor(peerId: String): Int = connections[peerId]?.mtu ?: CourierProfile.MIN_MTU

    /**
     * Connect, negotiate, subscribe.
     *
     * [done] is called exactly once with either the negotiated ATT MTU or an
     * operator-readable reason.
     */
    fun connect(peerId: String, done: (Int?, String?) -> Unit) {
        val existing = connections[peerId]
        if (existing != null) {
            if (existing.ready) {
                done(existing.mtu, null)
            } else {
                done(null, "A connection to this device is already being set up.")
            }
            return
        }

        val device = peers.device(peerId)
        if (device == null) {
            done(
                null,
                "This device is no longer in range, or the app was restarted since it was found. " +
                    "Scan again.",
            )
            return
        }

        val peer = ClientPeer(peerId, device)
        peer.pending.set(done)
        connections[peerId] = peer
        armTimeout(peer)
        // connectGatt has a long history of misbehaving when called off the main
        // thread. Posting costs nothing and removes the question.
        main.post { openGatt(peer) }
    }

    private fun openGatt(peer: ClientPeer) {
        peer.attempts++
        peer.discoveryStarted = false
        Log.i(TAG, "connecting to ${peer.peerId} (attempt ${peer.attempts})")
        val gatt = try {
            // autoConnect=false: direct connection. autoConnect=true is for
            // reconnecting to a known device in the background and is markedly
            // slower to establish, which is wrong for an operator standing
            // there waiting.
            peer.device.connectGatt(
                context,
                false,
                gattCallback,
                BluetoothDevice.TRANSPORT_LE,
            )
        } catch (e: SecurityException) {
            null
        }
        if (gatt == null) {
            finish(peer, null, "Android refused to open a GATT connection to this device.")
            return
        }
        peer.gatt = gatt
    }

    private fun armTimeout(peer: ClientPeer) {
        val runnable = Runnable {
            if (peer.ready) return@Runnable
            Log.w(TAG, "connect to ${peer.peerId} timed out")
            finish(
                peer,
                null,
                "Could not connect within ${CONNECT_TIMEOUT_MS / 1000} seconds. Move the two " +
                    "devices closer together and try again.",
            )
        }
        peer.timeout = runnable
        main.postDelayed(runnable, CONNECT_TIMEOUT_MS)
    }

    /** Settle a pending connect, tearing the connection down on failure. */
    private fun finish(peer: ClientPeer, mtu: Int?, error: String?) {
        peer.timeout?.let { main.removeCallbacks(it) }
        peer.timeout = null
        val done = peer.take()
        if (error != null) {
            forget(peer)
            closeGatt(peer)
        }
        done?.invoke(mtu, error)
    }

    /** Drop the registration only if it is still this peer, not a replacement. */
    private fun forget(peer: ClientPeer) {
        if (connections[peer.peerId] === peer) connections.remove(peer.peerId)
    }

    private fun closeGatt(peer: ClientPeer) {
        val gatt = peer.gatt ?: return
        peer.gatt = null
        peer.ready = false
        try {
            gatt.disconnect()
        } catch (e: SecurityException) {
            // ignored; we are closing anyway
        }
        try {
            // close() is not optional. Each unclosed BluetoothGatt holds one of
            // the handful of client interfaces the stack has, and running out
            // of them is how an app that has been used all day stops being able
            // to connect at all.
            gatt.close()
        } catch (e: SecurityException) {
            // ignored; we are closing anyway
        }
    }

    fun disconnect(peerId: String) {
        val peer = connections.remove(peerId) ?: return
        Log.i(TAG, "disconnecting from $peerId")
        peer.timeout?.let { main.removeCallbacks(it) }
        peer.timeout = null
        peer.take()?.invoke(null, "The connection was closed before it was established.")
        closeGatt(peer)
        // Report it ourselves: an app-initiated disconnect does not reliably
        // produce onConnectionStateChange on every stack, and the entry is
        // already gone so a callback that does arrive will not double-report.
        events.onDisconnected(peerId, "disconnected locally")
    }

    fun closeAll(notify: Boolean, reason: String?) {
        stopScan()
        val open = connections.values.toList()
        connections.clear()
        for (peer in open) {
            peer.timeout?.let { main.removeCallbacks(it) }
            peer.timeout = null
            peer.take()?.invoke(null, reason ?: "The connection was closed.")
            closeGatt(peer)
            if (notify) events.onDisconnected(peer.peerId, reason)
        }
    }

    /* ---------------------------------------------------------------------- */
    /* Writing                                                                */
    /* ---------------------------------------------------------------------- */

    fun send(peerId: String, packet: ByteArray): SendResult {
        val peer = connections[peerId] ?: return SendResult.GONE
        if (!peer.ready) return SendResult.GONE
        val gatt = peer.gatt ?: return SendResult.GONE
        val rx = peer.rx ?: return SendResult.GONE

        if (!peer.writeInFlight.compareAndSet(false, true)) return SendResult.REFUSED

        val taken = try {
            writeCompat(gatt, rx, packet)
        } catch (e: SecurityException) {
            peer.writeInFlight.set(false)
            return SendResult.GONE
        }

        if (!taken) {
            // Refused with nothing of ours outstanding, so no
            // onCharacteristicWrite is coming for it. The caller has to arrange
            // the wake-up.
            peer.writeInFlight.set(false)
            return SendResult.REFUSED_NO_CALLBACK
        }
        return SendResult.ACCEPTED
    }

    /**
     * Write without response.
     *
     * Symmetrical with the notify direction, which is also unacknowledged at
     * the ATT layer. Documented behaviour is that it avoids waiting a
     * connection interval per packet, which should make it substantially
     * faster than an acknowledged write — that is a reading of the spec, NOT a
     * measurement, and nobody has run this on a radio. It is not lossy: the
     * link layer retransmits, and a local buffer that is full refuses the write
     * rather than dropping it — which is precisely the refusal this function
     * reports.
     *
     * If a stack is ever found that does drop these, switching to
     * WRITE_TYPE_DEFAULT here is the whole fix; nothing above depends on the
     * choice.
     */
    @Suppress("DEPRECATION")
    private fun writeCompat(
        gatt: BluetoothGatt,
        rx: BluetoothGattCharacteristic,
        packet: ByteArray,
    ): Boolean {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            val status = gatt.writeCharacteristic(
                rx,
                packet,
                BluetoothGattCharacteristic.WRITE_TYPE_NO_RESPONSE,
            )
            if (status != BluetoothStatusCodes.SUCCESS) {
                Log.d(TAG, "write refused, status $status")
            }
            return status == BluetoothStatusCodes.SUCCESS
        }
        // The pre-33 API carries the value and the write type on the shared
        // characteristic object, so setting them and writing must be atomic.
        return synchronized(rx) {
            rx.writeType = BluetoothGattCharacteristic.WRITE_TYPE_NO_RESPONSE
            rx.value = packet
            gatt.writeCharacteristic(rx)
        }
    }

    /* ---------------------------------------------------------------------- */
    /* Callbacks                                                              */
    /* ---------------------------------------------------------------------- */

    /**
     * Resolved through the peer registry rather than by comparing BluetoothGatt
     * instances: a callback can in principle arrive before connectGatt has
     * returned and its result been stored, and a lookup that depends on that
     * assignment would silently drop the event.
     */
    private fun peerOf(gatt: BluetoothGatt): ClientPeer? {
        val peerId = peers.knownIdFor(gatt.device) ?: return null
        return connections[peerId]
    }

    private val gattCallback = object : BluetoothGattCallback() {

        override fun onConnectionStateChange(gatt: BluetoothGatt, status: Int, newState: Int) {
            val peer = peerOf(gatt) ?: run {
                // A connection we have already forgotten. Close it so its
                // client interface goes back to the stack.
                try {
                    gatt.close()
                } catch (e: SecurityException) {
                    // nothing to do
                }
                return
            }

            if (newState == BluetoothProfile.STATE_CONNECTED &&
                status == BluetoothGatt.GATT_SUCCESS
            ) {
                // Defensive: openGatt stores this too, but if the callback beat
                // the assignment, closeGatt would otherwise leak the interface.
                peer.gatt = gatt
                Log.i(TAG, "connected to ${peer.peerId}, negotiating MTU")
                // MTU first, then discovery.
                //
                // The MTU has to be settled before this peer is reported as
                // connected, because the TypeScript side sizes every packet
                // from the MTU it is told once and never asks again. Doing it
                // before discovery also keeps the whole exchange in one
                // predictable order.
                //
                // Unverified: some OEM stacks are reported to prefer discovery
                // first. If that turns out to matter, the two calls swap and
                // onServicesDiscovered chains into requestMtu instead.
                val requested = try {
                    gatt.requestMtu(CourierProfile.PREFERRED_MTU)
                } catch (e: SecurityException) {
                    false
                }
                if (!requested) {
                    Log.w(TAG, "MTU request refused for ${peer.peerId}; continuing at 23")
                    startDiscovery(peer, gatt)
                }
                return
            }

            if (newState == BluetoothProfile.STATE_DISCONNECTED) {
                if (peer.ready) {
                    Log.i(TAG, "disconnected from ${peer.peerId} (status $status)")
                    forget(peer)
                    closeGatt(peer)
                    events.onDisconnected(peer.peerId, describeGattStatus(status))
                    return
                }

                // Failed before it was ever usable. Status 133 is Android's
                // catch-all GATT error and is widely reported as transient, so
                // a single clean retry (close first; reusing the BluetoothGatt
                // is documented not to work) is worth the 600 ms. How often it
                // actually succeeds is UNMEASURED — that claim comes from other
                // people's bug reports, not from running this. Retrying more
                // than once is a policy decision belonging to whoever drives the
                // sync, not to this file.
                closeGatt(peer)
                if (status == 133 && peer.attempts < MAX_CONNECT_ATTEMPTS) {
                    Log.w(TAG, "status 133 connecting to ${peer.peerId}; retrying once")
                    main.postDelayed({ if (connections[peer.peerId] === peer) openGatt(peer) }, RETRY_DELAY_MS)
                    return
                }
                finish(peer, null, "Could not connect: ${describeGattStatus(status)}.")
            }
        }

        override fun onMtuChanged(gatt: BluetoothGatt, mtu: Int, status: Int) {
            val peer = peerOf(gatt) ?: return
            peer.mtu = if (status == BluetoothGatt.GATT_SUCCESS) mtu else CourierProfile.MIN_MTU
            Log.i(TAG, "ATT MTU for ${peer.peerId} is now ${peer.mtu}")
            startDiscovery(peer, gatt)
        }

        override fun onServicesDiscovered(gatt: BluetoothGatt, status: Int) {
            val peer = peerOf(gatt) ?: return
            if (status != BluetoothGatt.GATT_SUCCESS) {
                finish(peer, null, "Could not read this device's Bluetooth services (status $status).")
                return
            }

            val service = gatt.getService(CourierProfile.SERVICE)
            if (service == null) {
                finish(
                    peer,
                    null,
                    "This device does not publish the Courier service. It is probably running a " +
                        "different app, or a different version of this one.",
                )
                return
            }

            val rx = service.getCharacteristic(CourierProfile.RX)
            val tx = service.getCharacteristic(CourierProfile.TX)
            if (rx == null || tx == null) {
                finish(peer, null, "This device publishes an incomplete Courier service.")
                return
            }
            peer.rx = rx

            val enabled = try {
                gatt.setCharacteristicNotification(tx, true)
            } catch (e: SecurityException) {
                false
            }
            if (!enabled) {
                finish(peer, null, "Android would not enable notifications for this connection.")
                return
            }

            val cccd = tx.getDescriptor(CourierProfile.CCCD)
            if (cccd == null) {
                finish(
                    peer,
                    null,
                    "This device's Courier service is missing its notification descriptor.",
                )
                return
            }

            // setCharacteristicNotification only arms the local side. The peer
            // does not start sending until the CCCD is written, and that write
            // is what makes the connection usable in both directions — so the
            // connect promise resolves from onDescriptorWrite, not from here.
            val written = try {
                writeDescriptorCompat(gatt, cccd, BluetoothGattDescriptor.ENABLE_NOTIFICATION_VALUE)
            } catch (e: SecurityException) {
                false
            }
            if (!written) {
                finish(peer, null, "Android would not subscribe to this device's notifications.")
            }
        }

        override fun onDescriptorWrite(
            gatt: BluetoothGatt,
            descriptor: BluetoothGattDescriptor,
            status: Int,
        ) {
            if (descriptor.uuid != CourierProfile.CCCD) return
            val peer = peerOf(gatt) ?: return
            if (status != BluetoothGatt.GATT_SUCCESS) {
                finish(peer, null, "Subscribing to this device's notifications failed (status $status).")
                return
            }
            peer.ready = true
            Log.i(TAG, "link to ${peer.peerId} is ready at mtu ${peer.mtu}")
            finish(peer, peer.mtu, null)
        }

        override fun onCharacteristicWrite(
            gatt: BluetoothGatt,
            characteristic: BluetoothGattCharacteristic,
            status: Int,
        ) {
            if (characteristic.uuid != CourierProfile.RX) return
            val peer = peerOf(gatt) ?: return
            peer.writeInFlight.set(false)
            if (status != BluetoothGatt.GATT_SUCCESS) {
                Log.w(TAG, "write to ${peer.peerId} failed, status $status")
            }
            // Ready either way: the slot is free, and letting the writer retry
            // beats letting it hang.
            events.onReadyToWrite(peer.peerId)
        }

        /** API 33+. The value arrives with the callback instead of on the object. */
        override fun onCharacteristicChanged(
            gatt: BluetoothGatt,
            characteristic: BluetoothGattCharacteristic,
            value: ByteArray,
        ) {
            if (characteristic.uuid != CourierProfile.TX) return
            val peer = peerOf(gatt) ?: return
            if (value.isEmpty()) return
            events.onPacket(peer.peerId, value)
        }

        /** Pre-33. Only one of the two overloads is ever called on a given OS. */
        @Deprecated("Superseded by the (gatt, characteristic, value) overload on API 33+")
        @Suppress("DEPRECATION")
        override fun onCharacteristicChanged(
            gatt: BluetoothGatt,
            characteristic: BluetoothGattCharacteristic,
        ) {
            if (characteristic.uuid != CourierProfile.TX) return
            val peer = peerOf(gatt) ?: return
            val value = characteristic.value ?: return
            if (value.isEmpty()) return
            // Copy: the framework reuses this buffer for the next notification,
            // and the bytes are about to cross the bridge asynchronously.
            events.onPacket(peer.peerId, value.copyOf())
        }
    }

    private fun startDiscovery(peer: ClientPeer, gatt: BluetoothGatt) {
        if (peer.discoveryStarted) return
        peer.discoveryStarted = true
        val started = try {
            gatt.discoverServices()
        } catch (e: SecurityException) {
            false
        }
        if (!started) {
            finish(peer, null, "Android would not start service discovery on this connection.")
        }
    }

    @Suppress("DEPRECATION")
    private fun writeDescriptorCompat(
        gatt: BluetoothGatt,
        descriptor: BluetoothGattDescriptor,
        value: ByteArray,
    ): Boolean {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            return gatt.writeDescriptor(descriptor, value) == BluetoothStatusCodes.SUCCESS
        }
        descriptor.value = value
        return gatt.writeDescriptor(descriptor)
    }
}

internal fun describeScanError(code: Int): String = when (code) {
    ScanCallback.SCAN_FAILED_ALREADY_STARTED ->
        "A Bluetooth scan is already running."
    ScanCallback.SCAN_FAILED_APPLICATION_REGISTRATION_FAILED ->
        "Android would not register this app to scan. Turning Bluetooth off and on again " +
            "usually clears this."
    ScanCallback.SCAN_FAILED_FEATURE_UNSUPPORTED ->
        "This device does not support the kind of Bluetooth scan Courier needs."
    ScanCallback.SCAN_FAILED_INTERNAL_ERROR ->
        "Android's Bluetooth stack failed while starting the scan. Turning Bluetooth off and " +
            "on again usually clears this."
    // 5 and 6 are SCAN_FAILED_OUT_OF_HARDWARE_RESOURCES and
    // SCAN_FAILED_SCANNING_TOO_FREQUENTLY. They are matched numerically because
    // the constants were added later than the four above and this module
    // compiles against a minSdk that predates them.
    5 -> "This device has no Bluetooth scanning slots left. Close other Bluetooth apps and try again."
    6 -> "Android is throttling Bluetooth scans because they were started too often — it allows " +
        "about five in any thirty seconds. Wait half a minute and try again."
    else -> "The Bluetooth scan failed to start (Android error code $code)."
}
