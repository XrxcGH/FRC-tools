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
 * Courier — the Android half of the plugin boundary.
 *
 * Nine methods and four events, exactly as declared in
 * packages/courier-capacitor/src/definitions.ts. Nothing may be added here that
 * is not in that file: the whole architecture rests on this surface being small
 * enough that maintaining it twice — once in Kotlin, once in Swift — stays
 * cheap forever. Framing, chunking, reassembly, ordering, retry and the
 * anti-entropy protocol are all portable TypeScript with tests that run on a
 * laptop with no radio, and they stay there.
 *
 *   capabilities        what this device reports it can do, queried at runtime
 *   requestPermissions  the runtime permissions Android demands
 *   startAdvertising    peripheral role: be findable
 *   stopAdvertising
 *   startScan           central role: find peers
 *   stopScan
 *   connect             establish a link and report the negotiated ATT MTU
 *   disconnect
 *   write               hand one opaque packet to the stack, honestly
 *
 *   packetReceived  peerFound  readyToWrite  disconnected
 *
 * addListener and removeAllListeners come from Capacitor's Plugin base class.
 *
 * Packet contents are NEVER logged; neither are Bluetooth addresses. They are
 * scouting records belonging to minors' teams, and the addresses identify the
 * hardware those minors are carrying. Connection lifecycle only, keyed by the
 * opaque peerId this plugin assigns.
 */
package com.courier.ble

import android.Manifest
import android.bluetooth.BluetoothAdapter
import android.bluetooth.BluetoothDevice
import android.bluetooth.BluetoothManager
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.content.pm.PackageManager
import android.location.LocationManager
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.util.Base64
import android.util.Log
import com.getcapacitor.JSArray
import com.getcapacitor.JSObject
import com.getcapacitor.PermissionState
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.annotation.CapacitorPlugin
import com.getcapacitor.annotation.Permission
import com.getcapacitor.annotation.PermissionCallback
import java.util.UUID
import java.util.concurrent.atomic.AtomicBoolean

/** API 31+: the "Nearby devices" permission group. */
private const val ALIAS_NEARBY = "nearbyDevices"

/** API 30 and below: Android required a location permission for any BLE scan. */
private const val ALIAS_SCAN_LOCATION = "scanLocation"

private const val TAG = "CourierBle"

private const val EVENT_PACKET = "packetReceived"
private const val EVENT_READY = "readyToWrite"
private const val EVENT_PEER_FOUND = "peerFound"
private const val EVENT_DISCONNECTED = "disconnected"

/**
 * How long to wait before nudging a writer that the stack refused without
 * promising a callback.
 *
 * Unverified: this case should be rare and I have no device on which to
 * provoke it. 25 ms is short enough to be invisible next to a connection
 * interval and long enough not to spin.
 */
private const val READY_HINT_MS = 25L

/** What the two role implementations report back. Implemented by the plugin. */
internal interface CourierEvents {
    fun onPeerFound(peerId: String, label: String, rssi: Int?)
    fun onPacket(peerId: String, packet: ByteArray)
    fun onReadyToWrite(peerId: String)
    fun onDisconnected(peerId: String, reason: String?)
}

/**
 * Opaque peer handles.
 *
 * The contract is explicit that peerId must not be a MAC address or a raw
 * device identifier: both platforms rotate BLE addresses precisely so that a
 * device cannot be followed around a venue, and handing one to JavaScript
 * would undo that and leak it into logs, stores and bug reports. So the address
 * is used as a lookup key here, inside the plugin, and never leaves it. What
 * crosses the bridge is a random UUID minted on first sight.
 *
 * Two consequences worth knowing:
 *
 *   - Handles do not survive an app restart. They are not a stable identity for
 *     a device, and nothing above should treat them as one. Courier's actual
 *     device identity is its Ed25519 key, established by the pairing ceremony.
 *   - When a peer rotates its random address, it is seen as a new peer with a
 *     new handle. That is the privacy feature working, not a bug.
 */
internal class PeerRegistry {
    private val byAddress = HashMap<String, String>()
    private val devices = HashMap<String, BluetoothDevice>()

    /** The handle for this device, minting one if it has not been seen before. */
    @Synchronized
    fun idFor(device: BluetoothDevice): String {
        val address = device.address
        val existing = byAddress[address]
        if (existing != null) {
            // Refresh: a later BluetoothDevice for the same address carries the
            // fresher connection state.
            devices[existing] = device
            return existing
        }
        val peerId = UUID.randomUUID().toString()
        byAddress[address] = peerId
        devices[peerId] = device
        return peerId
    }

    /** The handle, or null if this device has never been seen. Mints nothing. */
    @Synchronized
    fun knownIdFor(device: BluetoothDevice): String? = byAddress[device.address]

    @Synchronized
    fun device(peerId: String): BluetoothDevice? = devices[peerId]

    @Synchronized
    fun clear() {
        byAddress.clear()
        devices.clear()
    }
}

/** Wrap a callback so it runs at most once, whoever gets there first. */
internal fun once(done: (String?) -> Unit): (String?) -> Unit {
    val fired = AtomicBoolean(false)
    return { reason -> if (fired.compareAndSet(false, true)) done(reason) }
}

@CapacitorPlugin(
    name = "CourierBle",
    permissions = [
        Permission(
            alias = ALIAS_NEARBY,
            strings = [
                Manifest.permission.BLUETOOTH_SCAN,
                Manifest.permission.BLUETOOTH_ADVERTISE,
                Manifest.permission.BLUETOOTH_CONNECT,
            ],
        ),
        Permission(
            alias = ALIAS_SCAN_LOCATION,
            strings = [Manifest.permission.ACCESS_FINE_LOCATION],
        ),
    ],
)
class CourierBlePlugin : Plugin() {

    private enum class Route { SERVER, CLIENT }

    private val main = Handler(Looper.getMainLooper())
    private val peers = PeerRegistry()

    private var adapter: BluetoothAdapter? = null
    private var server: CourierGattServer? = null
    private var client: CourierGattClient? = null
    private var adapterWatcherRegistered = false

    /* ---------------------------------------------------------------------- */
    /* Lifecycle                                                              */
    /* ---------------------------------------------------------------------- */

    override fun load() {
        val manager = context.getSystemService(Context.BLUETOOTH_SERVICE) as? BluetoothManager
        adapter = manager?.adapter
        adapter?.let {
            server = CourierGattServer(context, it, peers, events)
            client = CourierGattClient(context, it, peers, events)
        }
        registerAdapterWatcher()
    }

    override fun handleOnDestroy() {
        unregisterAdapterWatcher()
        // notify = false: the WebView is going away with us, so there is nobody
        // left to hear a disconnect event.
        client?.closeAll(notify = false, reason = null)
        server?.close(notify = false, reason = null)
        peers.clear()
        super.handleOnDestroy()
    }

    /**
     * Bluetooth going off kills every connection without any GATT callback on
     * some stacks. Watching for it is the difference between a sync that ends
     * and a sync that hangs until the 15-second stall timeout in GattLink.
     */
    private val adapterWatcher = object : BroadcastReceiver() {
        override fun onReceive(c: Context?, intent: Intent?) {
            if (intent?.action != BluetoothAdapter.ACTION_STATE_CHANGED) return
            val state = intent.getIntExtra(BluetoothAdapter.EXTRA_STATE, BluetoothAdapter.ERROR)
            if (state == BluetoothAdapter.STATE_TURNING_OFF || state == BluetoothAdapter.STATE_OFF) {
                Log.i(TAG, "Bluetooth turned off; tearing down every Courier connection")
                val reason = "Bluetooth was turned off"
                client?.closeAll(notify = true, reason = reason)
                server?.close(notify = true, reason = reason)
            }
        }
    }

    private fun registerAdapterWatcher() {
        if (adapterWatcherRegistered) return
        val filter = IntentFilter(BluetoothAdapter.ACTION_STATE_CHANGED)
        // API 33 made the export flag mandatory. System broadcasts are still
        // delivered to a not-exported receiver, and not-exported is what we
        // want: no other app has any business poking this.
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            context.registerReceiver(adapterWatcher, filter, Context.RECEIVER_NOT_EXPORTED)
        } else {
            context.registerReceiver(adapterWatcher, filter)
        }
        adapterWatcherRegistered = true
    }

    private fun unregisterAdapterWatcher() {
        if (!adapterWatcherRegistered) return
        adapterWatcherRegistered = false
        try {
            context.unregisterReceiver(adapterWatcher)
        } catch (e: IllegalArgumentException) {
            // already gone
        }
    }

    /* ---------------------------------------------------------------------- */
    /* Events                                                                 */
    /* ---------------------------------------------------------------------- */

    private fun emit(event: String, data: JSObject) = notifyListeners(event, data)

    private val events = object : CourierEvents {
        override fun onPeerFound(peerId: String, label: String, rssi: Int?) {
            val data = JSObject().put("peerId", peerId).put("label", label)
            if (rssi != null) data.put("rssi", rssi)
            emit(EVENT_PEER_FOUND, data)
        }

        override fun onPacket(peerId: String, packet: ByteArray) {
            // NO_WRAP: the bridge carries this inside JSON, and a newline every
            // 76 characters would only make the payload bigger.
            emit(
                EVENT_PACKET,
                JSObject()
                    .put("peerId", peerId)
                    .put("packet", Base64.encodeToString(packet, Base64.NO_WRAP)),
            )
        }

        override fun onReadyToWrite(peerId: String) {
            emit(EVENT_READY, JSObject().put("peerId", peerId))
        }

        override fun onDisconnected(peerId: String, reason: String?) {
            val data = JSObject().put("peerId", peerId)
            if (reason != null) data.put("reason", reason)
            emit(EVENT_DISCONNECTED, data)
        }
    }

    /* ---------------------------------------------------------------------- */
    /* capabilities                                                           */
    /* ---------------------------------------------------------------------- */

    /**
     * What this device can actually do, checked now rather than assumed.
     *
     * Everything here is a runtime observation. A capability that cannot be
     * verified is reported as absent with a sentence saying why — a team told
     * "your Chromebooks can join a sync but cannot start one" brings a USB
     * stick, and a team staring at a spinner does not.
     */
    @PluginMethod
    fun capabilities(call: PluginCall) {
        val limitations = ArrayList<String>()
        val hasLe = context.packageManager.hasSystemFeature(PackageManager.FEATURE_BLUETOOTH_LE)
        val adapter = this.adapter
        val enabled = adapter?.isEnabled == true

        if (!hasLe || adapter == null) {
            limitations.add(
                "This device has no usable Bluetooth Low Energy radio, so it cannot join a " +
                    "Courier mesh at all. It can still exchange data over USB or QR.",
            )
        } else if (!enabled) {
            limitations.add(
                "Bluetooth is turned off. Turn it on in Settings and try again — for your " +
                    "safety Android does not let an app turn it on for you.",
            )
        }

        // getBluetoothLeAdvertiser() returns null both when the chipset has no
        // peripheral role and when Bluetooth is simply off, so those two cases
        // cannot be told apart from here and must be reported differently.
        val advertiser = if (enabled) {
            try {
                adapter?.bluetoothLeAdvertiser
            } catch (e: SecurityException) {
                null
            }
        } else {
            null
        }
        val scanner = if (enabled) {
            try {
                adapter?.bluetoothLeScanner
            } catch (e: SecurityException) {
                null
            }
        } else {
            null
        }

        if (enabled && advertiser == null) {
            limitations.add(
                "This device's Bluetooth chipset cannot act as a peripheral, so other devices " +
                    "cannot find it. It can still join a sync that another device starts, and " +
                    "it can always exchange data over USB or QR.",
            )
        } else if (!enabled && hasLe && adapter != null) {
            limitations.add(
                "Whether this device can be found by others cannot be checked while Bluetooth " +
                    "is off.",
            )
        }

        val missingAdvertise = advertisePermissions().filter { !isGranted(it) }
        val missingScan = scanPermissions().filter { !isGranted(it) }
        val missingConnect = connectPermissions().filter { !isGranted(it) }
        for (permission in (missingAdvertise + missingScan + missingConnect).distinct()) {
            limitations.add(describePermission(permission))
        }

        val locationOn = locationServicesEnabled()
        if (!locationOn) {
            limitations.add(
                "Android 11 and earlier only return Bluetooth scan results while Location is " +
                    "switched on in Quick Settings. Courier never asks for, reads or transmits " +
                    "your location — Android simply will not scan without it.",
            )
        }

        val canAdvertise = hasLe && enabled && advertiser != null && missingAdvertise.isEmpty() &&
            missingConnect.isEmpty()
        val canScan = hasLe && enabled && scanner != null && missingScan.isEmpty() &&
            missingConnect.isEmpty() && locationOn

        // The largest ATT MTU this plugin will negotiate, which is what it asks
        // for: PREFERRED_MTU. Android's own ceiling is higher — the framework
        // will carry a request up to 517 — but Courier asks for 247 because
        // that is what data-length extension delivers in one link-layer packet,
        // and asking for more buys fragmentation rather than throughput.
        // Reporting 517 here would be reporting something never attempted.
        //
        // 23 when the radio is unusable, which is what the contract asks for:
        // "23 if it will not".
        val maxMtu = if (canAdvertise || canScan) {
            CourierProfile.PREFERRED_MTU
        } else {
            CourierProfile.MIN_MTU
        }

        val list = JSArray()
        for (l in limitations) list.put(l)

        val result = JSObject()
            .put("canAdvertise", canAdvertise)
            .put("canScan", canScan)
            .put("maxMtu", maxMtu)
            // Always "software", and deliberately so.
            //
            // Courier signs records with Ed25519 in TypeScript, using
            // @noble/curves. There is no signing method among the nine in
            // definitions.ts, so the private key is generated and used in the
            // JavaScript heap and is exportable by construction. Reporting
            // "hardware" because this handset happens to ship StrongBox would
            // be claiming a guarantee over a key the keystore never touches.
            //
            // Unverified, and the reason this is not simply a TODO: recent
            // KeyMint versions are documented to support Ed25519, while
            // StrongBox is documented as P-256 only. Even if a device could
            // hold a hardware Ed25519 key, using it would need its own native
            // surface — sign(), and everything that follows from key material
            // that cannot leave the device — which is a design decision with a
            // real cost, not something this file may quietly assert.
            .put("keyBacking", "software")
            .put("limitations", list)

        call.resolve(result)
    }

    /* ---------------------------------------------------------------------- */
    /* requestPermissions                                                     */
    /* ---------------------------------------------------------------------- */

    /**
     * Overrides Capacitor's generated implementation so the result matches the
     * contract's `{ granted, reason }` rather than Capacitor's permission map.
     */
    @PluginMethod
    override fun requestPermissions(call: PluginCall) {
        val alias = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            ALIAS_NEARBY
        } else {
            ALIAS_SCAN_LOCATION
        }
        if (getPermissionState(alias) == PermissionState.GRANTED) {
            resolvePermissionState(call)
            return
        }
        requestPermissionForAlias(alias, call, "permissionsCallback")
    }

    @PermissionCallback
    fun permissionsCallback(call: PluginCall) = resolvePermissionState(call)

    private fun resolvePermissionState(call: PluginCall) {
        val missing = requiredPermissions().filter { !isGranted(it) }
        val result = JSObject().put("granted", missing.isEmpty())
        if (missing.isNotEmpty()) {
            result.put("reason", missing.joinToString(" ") { describePermission(it) })
        } else if (!locationServicesEnabled()) {
            // Granted but still unable to scan. Saying so now is much kinder
            // than an empty peer list later.
            result.put("granted", false)
            result.put(
                "reason",
                "Permission was granted, but Location is switched off. Android 11 and earlier " +
                    "return no Bluetooth scan results at all while it is off. Courier never " +
                    "asks for, reads or transmits your location.",
            )
        }
        call.resolve(result)
    }

    /* ---------------------------------------------------------------------- */
    /* Advertising                                                            */
    /* ---------------------------------------------------------------------- */

    @PluginMethod
    fun startAdvertising(call: PluginCall) {
        // A DEVICE name — "pit-laptop", "stands-tablet-3" — never a person's.
        // The plugin has no API that could carry a personal name and must not
        // grow one; the label is broadcast in the clear to everyone in the
        // building.
        val label = call.getString("label")?.trim()
        if (label.isNullOrEmpty()) {
            call.reject(
                "startAdvertising needs a label: the name of this DEVICE, like \"pit-laptop\" " +
                    "or \"stands-tablet-3\". It is broadcast in the clear, so it must never be " +
                    "a person's name.",
            )
            return
        }

        val gatt = server
        if (gatt == null) {
            call.reject(NO_BLUETOOTH)
            return
        }
        if (!ready(call, advertisePermissions())) return

        gatt.startAdvertising(label) { reason ->
            if (reason == null) call.resolve() else call.reject(reason)
        }
    }

    @PluginMethod
    fun stopAdvertising(call: PluginCall) {
        // Idempotent by design: the TypeScript side calls this on teardown
        // paths where it cannot know whether advertising ever started.
        server?.stopAdvertising()
        call.resolve()
    }

    /* ---------------------------------------------------------------------- */
    /* Scanning                                                               */
    /* ---------------------------------------------------------------------- */

    @PluginMethod
    fun startScan(call: PluginCall) {
        val scan = client
        if (scan == null) {
            call.reject(NO_BLUETOOTH)
            return
        }
        if (!ready(call, scanPermissions())) return
        if (!locationServicesEnabled()) {
            call.reject(
                "Location is switched off. Android 11 and earlier return no Bluetooth scan " +
                    "results while it is off. Courier never asks for, reads or transmits your " +
                    "location.",
            )
            return
        }
        scan.startScan { reason ->
            if (reason == null) call.resolve() else call.reject(reason)
        }
    }

    @PluginMethod
    fun stopScan(call: PluginCall) {
        client?.stopScan()
        call.resolve()
    }

    /* ---------------------------------------------------------------------- */
    /* Connections                                                            */
    /* ---------------------------------------------------------------------- */

    @PluginMethod
    fun connect(call: PluginCall) {
        val peerId = call.getString("peerId")
        if (peerId.isNullOrEmpty()) {
            call.reject("connect needs a peerId, as reported by the peerFound event.")
            return
        }

        // An existing path wins over making a new one. A peer that connected to
        // us — we are its peripheral — is already established, and dialling it
        // back as a central would be a second connection to the same device for
        // no gain.
        val existing = routeFor(peerId)
        if (existing != null) {
            call.resolve(
                JSObject().put("peerId", peerId).put("mtu", mtuFor(peerId, existing)),
            )
            return
        }

        if (server?.isConnected(peerId) == true) {
            call.reject(
                "This device is connected but has not subscribed to Courier's notify " +
                    "characteristic yet. Wait for it to finish connecting and try again.",
            )
            return
        }

        val central = client
        if (central == null) {
            call.reject(NO_BLUETOOTH)
            return
        }
        if (!ready(call, connectPermissions())) return

        central.connect(peerId) { mtu, error ->
            if (error != null) {
                call.reject(error)
            } else {
                call.resolve(
                    JSObject()
                        .put("peerId", peerId)
                        .put("mtu", mtu ?: CourierProfile.MIN_MTU),
                )
            }
        }
    }

    @PluginMethod
    fun disconnect(call: PluginCall) {
        val peerId = call.getString("peerId")
        if (peerId.isNullOrEmpty()) {
            call.reject("disconnect needs a peerId.")
            return
        }
        // Both sides, unconditionally, and never an error for an unknown peer:
        // the TypeScript transport calls this from close(), which runs on paths
        // where the connection may already be gone.
        client?.disconnect(peerId)
        server?.disconnect(peerId)
        call.resolve()
    }

    /* ---------------------------------------------------------------------- */
    /* write                                                                  */
    /* ---------------------------------------------------------------------- */

    /**
     * Hand one opaque packet to the stack.
     *
     * `accepted: false` means the stack did NOT take it and it must be sent
     * again after `readyToWrite`. Returning true unconditionally would lose
     * data silently, and the loss would surface much later as a signature
     * failure on an unrelated record. Under load this is the common path, not
     * an error path.
     */
    @PluginMethod
    fun write(call: PluginCall) {
        val peerId = call.getString("peerId")
        if (peerId.isNullOrEmpty()) {
            call.reject("write needs a peerId.")
            return
        }
        val encoded = call.getString("packet")
        if (encoded == null) {
            call.reject("write needs a base64 packet.")
            return
        }

        val packet = try {
            Base64.decode(encoded, Base64.DEFAULT)
        } catch (e: IllegalArgumentException) {
            // Deliberately does not echo the value: it is a scouting record.
            call.reject("The packet was not valid base64.")
            return
        }

        // An empty packet is always a caller bug — every Courier frame carries
        // at least a 5-byte header — and handing one to the stack spends a
        // connection event delivering nothing. Swift already rejects it; without
        // this the same JavaScript behaves differently on the two platforms.
        if (packet.isEmpty()) {
            call.reject("The packet was empty. Every Courier frame carries a header.")
            return
        }

        val route = routeFor(peerId)
        if (route == null) {
            call.reject("There is no open connection to this device.")
            return
        }

        // A packet larger than the negotiated MTU allows would be truncated or
        // rejected by the stack, which is a silent corruption from up there.
        // The framing layer sizes packets from the MTU this plugin reported, so
        // reaching this is a bug worth naming rather than tolerating.
        val limit = mtuFor(peerId, route) - CourierProfile.ATT_OVERHEAD
        if (packet.size > limit) {
            call.reject(
                "A packet of ${packet.size} bytes does not fit the negotiated MTU, which " +
                    "allows $limit bytes.",
            )
            return
        }

        val result = when (route) {
            Route.SERVER -> server?.send(peerId, packet)
            Route.CLIENT -> client?.send(peerId, packet)
        } ?: SendResult.GONE

        when (result) {
            SendResult.ACCEPTED -> call.resolve(JSObject().put("accepted", true))

            SendResult.REFUSED -> call.resolve(JSObject().put("accepted", false))

            SendResult.REFUSED_NO_CALLBACK -> {
                // Refused with no completion callback outstanding, so nothing
                // would ever wake the writer. Synthesise the wake-up rather
                // than letting the link sit until GattLink's stall timeout.
                scheduleReadyHint(peerId)
                call.resolve(JSObject().put("accepted", false))
            }

            SendResult.GONE -> call.reject("The connection to this device has closed.")
        }
    }

    private fun scheduleReadyHint(peerId: String) {
        main.postDelayed({
            if (routeFor(peerId) != null) events.onReadyToWrite(peerId)
        }, READY_HINT_MS)
    }

    /* ---------------------------------------------------------------------- */
    /* Routing                                                                */
    /* ---------------------------------------------------------------------- */

    /**
     * Which role reaches this peer.
     *
     * The peripheral path is preferred when both exist. Both can exist only if
     * the two devices connected to each other simultaneously, which wastes a
     * connection but is not incorrect: each direction still travels over
     * exactly one path, so packet order within a direction is preserved, which
     * is all the reassembler requires.
     */
    private fun routeFor(peerId: String): Route? = when {
        server?.isReady(peerId) == true -> Route.SERVER
        client?.isReady(peerId) == true -> Route.CLIENT
        else -> null
    }

    private fun mtuFor(peerId: String, route: Route): Int = when (route) {
        Route.SERVER -> server?.mtuFor(peerId) ?: CourierProfile.MIN_MTU
        Route.CLIENT -> client?.mtuFor(peerId) ?: CourierProfile.MIN_MTU
    }

    /* ---------------------------------------------------------------------- */
    /* Permissions and preconditions                                          */
    /* ---------------------------------------------------------------------- */

    /**
     * Android 12 (API 31) split Bluetooth into three permissions describing what
     * an app does with the radio. Before that there was one install-time
     * BLUETOOTH permission plus — from Android 6 — a runtime *location*
     * permission, because a list of nearby radios is a position fix if you have
     * a map of them. Courier never uses it that way, which is why the manifest
     * declares BLUETOOTH_SCAN with usesPermissionFlags="neverForLocation" and
     * caps ACCESS_FINE_LOCATION at API 30.
     */
    private fun requiredPermissions(): List<String> =
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            listOf(
                Manifest.permission.BLUETOOTH_SCAN,
                Manifest.permission.BLUETOOTH_ADVERTISE,
                Manifest.permission.BLUETOOTH_CONNECT,
            )
        } else {
            listOf(Manifest.permission.ACCESS_FINE_LOCATION)
        }

    private fun scanPermissions(): List<String> =
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            listOf(Manifest.permission.BLUETOOTH_SCAN, Manifest.permission.BLUETOOTH_CONNECT)
        } else {
            listOf(Manifest.permission.ACCESS_FINE_LOCATION)
        }

    private fun advertisePermissions(): List<String> =
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            listOf(Manifest.permission.BLUETOOTH_ADVERTISE, Manifest.permission.BLUETOOTH_CONNECT)
        } else {
            // BLUETOOTH and BLUETOOTH_ADMIN are install-time permissions below
            // API 31: declared in the manifest, never requested at runtime.
            emptyList()
        }

    private fun connectPermissions(): List<String> =
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            listOf(Manifest.permission.BLUETOOTH_CONNECT)
        } else {
            emptyList()
        }

    private fun isGranted(permission: String): Boolean =
        context.checkSelfPermission(permission) == PackageManager.PERMISSION_GRANTED

    /** Radio on and permissions held, or the call is rejected with the reason. */
    private fun ready(call: PluginCall, permissions: List<String>): Boolean {
        val adapter = this.adapter
        if (adapter == null) {
            call.reject(NO_BLUETOOTH)
            return false
        }
        if (!adapter.isEnabled) {
            call.reject(BLUETOOTH_OFF)
            return false
        }
        val missing = permissions.filter { !isGranted(it) }
        if (missing.isNotEmpty()) {
            call.reject(missing.joinToString(" ") { describePermission(it) })
            return false
        }
        return true
    }

    /**
     * Below API 31, Android returns no scan results at all unless Location is
     * switched on device-wide — not merely permitted. This is the single most
     * common reason a scan finds nothing on an older tablet.
     */
    private fun locationServicesEnabled(): Boolean {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) return true
        val lm = context.getSystemService(Context.LOCATION_SERVICE) as? LocationManager
            ?: return false
        return if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
            lm.isLocationEnabled
        } else {
            @Suppress("DEPRECATION")
            lm.isProviderEnabled(LocationManager.GPS_PROVIDER) ||
                lm.isProviderEnabled(LocationManager.NETWORK_PROVIDER)
        }
    }

    private fun describePermission(permission: String): String = when (permission) {
        Manifest.permission.BLUETOOTH_SCAN ->
            "Permission to find nearby devices was declined, so this device cannot look for " +
                "peers. Android calls it \"Nearby devices\" under Settings > Apps > Permissions."
        Manifest.permission.BLUETOOTH_ADVERTISE ->
            "Permission to advertise over Bluetooth was declined, so other devices cannot find " +
                "this one. Android calls it \"Nearby devices\" under Settings > Apps > Permissions."
        Manifest.permission.BLUETOOTH_CONNECT ->
            "Permission to connect to nearby devices was declined, so no sync can be started or " +
                "accepted. Android calls it \"Nearby devices\" under Settings > Apps > Permissions."
        Manifest.permission.ACCESS_FINE_LOCATION ->
            "Location permission was declined. Android 11 and earlier require it for any " +
                "Bluetooth scan, even though Courier never asks for, reads or transmits your " +
                "location."
        else -> "A permission Courier needs ($permission) was declined."
    }

    private companion object {
        const val NO_BLUETOOTH =
            "This device has no usable Bluetooth Low Energy radio, so it cannot join a Courier " +
                "mesh. It can still exchange data over USB or QR."

        const val BLUETOOTH_OFF =
            "Bluetooth is turned off. Turn it on in Settings and try again — Android does not " +
                "let an app turn it on for you."
    }
}
