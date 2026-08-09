//
//  CourierBlePlugin.swift
//  @courier/capacitor
//
//  The iOS half of the plugin boundary defined in
//  `packages/courier-capacitor/src/definitions.ts`: nine methods and four
//  events, and nothing else.
//
//  What lives here: advertise, scan, connect, report the MTU, move opaque
//  packets in both directions, report disconnects.
//
//  What deliberately does NOT live here: framing, chunking, reassembly,
//  ordering, retry, the anti-entropy protocol, the record format. All of that is
//  in TypeScript (`@courier/ble`, `@courier/core`) where it is tested on a
//  laptop with no radio. A packet arrives here as an opaque blob and leaves as
//  an opaque blob. If a future change to this directory starts to look like
//  protocol logic, it belongs on the other side of the bridge — this file is
//  written twice, once here and once in Kotlin, forever.
//
//  Nothing in this directory has been compiled or run. There is no Mac, no
//  Xcode and no iOS device in the loop. Every claim about Core Bluetooth
//  behaviour below is from Apple's documentation and is marked as such; nothing
//  here has been observed.
//

import Capacitor
import CoreBluetooth
import Foundation
import os

// MARK: - The GATT profile

/// Service and characteristic UUIDs, copied verbatim from
/// `packages/courier-ble/src/gatt.ts`.
///
/// These are fixed constants rather than configuration for the reason given
/// there: two Courier devices that disagree on a UUID cannot find each other,
/// and there is no negotiation channel before the connection exists. If these
/// ever diverge from `gatt.ts`, iOS silently stops discovering anybody.
enum CourierGatt {
    static let serviceUUID = CBUUID(string: "c0117e12-9a3f-4c8d-8e21-6b7a5f0d1e40")
    /// Central writes here. (`COURIER_RX_UUID`)
    static let rxUUID = CBUUID(string: "c0117e12-9a3f-4c8d-8e21-6b7a5f0d1e41")
    /// Peripheral notifies here. (`COURIER_TX_UUID`)
    static let txUUID = CBUUID(string: "c0117e12-9a3f-4c8d-8e21-6b7a5f0d1e42")

    /// `MIN_MTU` — an unnegotiated BLE connection.
    static let minMtu = 23

    /// `ATT_OVERHEAD` — 1 opcode byte + 2 handle bytes.
    ///
    /// iOS never exposes the raw ATT MTU. It exposes the *payload* length, so
    /// every MTU this plugin reports is a payload length plus this constant.
    /// See `mtu(for:)` in both controllers.
    static let attOverhead = 3

    /// The largest ATT MTU this plugin claims iOS will negotiate.
    ///
    /// UNVERIFIED. Apple's Bluetooth accessory design guidance documents 185 as
    /// the ATT MTU iOS negotiates for LE connections, which lines up with the
    /// 182-byte `maximumWriteValueLength(for: .withoutResponse)` widely reported
    /// in the field. I have no device and have measured nothing.
    ///
    /// This constant is used for the *capability report only* — a forward-
    /// looking "how big could this get". Every MTU that actually matters (the
    /// one returned from `connect`, the one framing sizes packets against) is
    /// read from the live connection at runtime, so if this number is wrong the
    /// consequence is a slightly wrong number in a diagnostics screen, not
    /// mis-sized packets.
    ///
    /// Note it is below `PREFERRED_MTU` (247) in `gatt.ts`. That is an Android
    /// data-length-extension figure; iOS will not reach it, and claiming it here
    /// would be exactly the kind of unverified capability report this design
    /// forbids.
    static let maxAttMtu = 185

    /// Core Bluetooth's `connect` never times out on its own — it will wait for
    /// the peer to come back into range indefinitely. A JS promise that never
    /// settles is a hung UI, so connects are bounded here.
    static let connectTimeout: TimeInterval = 15

    /// How long to wait for `centralManagerDidUpdateState` /
    /// `peripheralManagerDidUpdateState` before answering a capability or
    /// permission question anyway. A manager's state is `.unknown` until iOS
    /// reports it, which is normally milliseconds after construction.
    static let stateSettleTimeout: TimeInterval = 3

    /// Bound on `startAdvertising`, which otherwise resolves only from a
    /// delegate callback.
    static let advertiseTimeout: TimeInterval = 10

    static let logSubsystem = "org.frctools.courier.ble"
}

// MARK: - Peer handles

/// Mints the opaque `peerId` values that cross the bridge.
///
/// Three properties matter and all three are required by the design:
///
/// 1. **Not a MAC address.** iOS never exposes one, and would not be allowed to.
/// 2. **Not `CBPeer.identifier`.** That is a per-host pseudonym for a specific
///    remote device which is stable across app launches; handing it to JS (which
///    may persist or transmit it) would create a durable device correlator for
///    devices belonging to minors' teams. So it stays inside this process, used
///    only as a dictionary key, and never leaves.
/// 3. **Stable for as long as a peer is known.** The tables in the two
///    controllers map a `CBPeer.identifier` to one of these, so re-discovering
///    or reconnecting to the same peripheral during a session yields the same
///    `peerId`. A central that unsubscribes is forgotten, and gets a new handle
///    if it comes back — from the peripheral's side that genuinely is a new
///    session. Across app launches every handle is fresh, which is the
///    privacy-preserving default and costs nothing: no TypeScript in this
///    repository persists a `peerId`.
enum CourierPeerHandle {
    static func make() -> String {
        UUID().uuidString.lowercased()
    }
}

// MARK: - Errors

struct CourierBleError: LocalizedError {
    let message: String
    init(_ message: String) { self.message = message }
    var errorDescription: String? { message }
}

// MARK: - Write outcome

/// The result of handing one packet to the stack.
///
/// `refused` is the case this whole design is built around: the stack did NOT
/// take the packet, it must be retried after `readyToWrite`, and it is not an
/// error — under load it is the common path.
enum CourierWriteOutcome {
    /// The stack took the packet.
    case accepted
    /// The stack did not take it. It has not been sent, and it has not been
    /// buffered here either. The TypeScript side keeps it and retries.
    case refused
    /// No live connection for that handle — the peer is gone.
    case unknownPeer
    /// Larger than the connection can carry in one PDU. Sending it would
    /// silently truncate (peripheral role) or turn into a queued long write with
    /// ATT offsets the far side does not reassemble (central role), so it is
    /// refused loudly instead.
    case tooLarge(max: Int)
}

// MARK: - Events

/// The four events, as seen from the two controllers.
protocol CourierEventSink: AnyObject {
    func emitPacketReceived(peerId: String, base64: String)
    func emitReadyToWrite(peerId: String)
    func emitPeerFound(peerId: String, label: String, rssi: Int?)
    func emitDisconnected(peerId: String, reason: String?)
}

// MARK: - The plugin

@objc(CourierBlePlugin)
public class CourierBlePlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "CourierBlePlugin"
    public let jsName = "CourierBle"

    /// Exactly the nine methods in `definitions.ts`. `addListener` and
    /// `removeAllListeners` are provided by `CAPPlugin` itself and are not
    /// declared here.
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "capabilities", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "requestPermissions", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "startAdvertising", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "stopAdvertising", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "startScan", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "stopScan", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "connect", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "disconnect", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "write", returnType: CAPPluginReturnPromise),
    ]

    /// One serial queue owns both Core Bluetooth managers and every piece of
    /// mutable state in this plugin. Both managers are constructed with it, so
    /// all delegate callbacks arrive on it, and every bridge method hops onto it
    /// before touching anything. That is the entire concurrency story: no locks,
    /// no `@Synchronized`, no reasoning about which thread Capacitor happened to
    /// call us on.
    private let queue = DispatchQueue(label: "org.frctools.courier.ble", qos: .userInitiated)

    private let log = Logger(subsystem: CourierGatt.logSubsystem, category: "plugin")

    private var central: CourierCentral!
    private var peripheral: CourierPeripheral!

    override public func load() {
        central = CourierCentral(queue: queue, sink: self)
        peripheral = CourierPeripheral(queue: queue, sink: self)
        log.info("Courier BLE plugin loaded")
        // Note what is NOT done here: neither CBCentralManager nor
        // CBPeripheralManager is constructed. Constructing either one is what
        // triggers the system Bluetooth permission prompt, and a prompt at app
        // launch — before the operator has done anything — is both bad UX and a
        // reliable App Store review comment. The managers are built lazily on
        // the first call that genuinely needs the radio, which is normally
        // `capabilities()` or `requestPermissions()`.
    }

    deinit {
        // Capture the controllers rather than `self`: `deinit` may run anywhere,
        // and a `queue.sync` here would deadlock if it ran on `queue`.
        let central = self.central
        let peripheral = self.peripheral
        queue.async {
            central?.shutdown()
            peripheral?.shutdown()
        }
    }

    // MARK: capabilities

    @objc func capabilities(_ call: CAPPluginCall) {
        queue.async { [weak self] in
            guard let self else { return call.reject("the Courier BLE plugin was unloaded") }
            self.withSettledState {
                let centralState = self.central.state
                let peripheralState = self.peripheral.state

                // Reported, never assumed. `.poweredOn` is the only state in
                // which either role can actually do anything, so it is the only
                // state in which a capability is claimed. A device with the
                // radio switched off is honestly reported as unable to
                // advertise, together with a sentence saying why — a spinner
                // that never finds anyone is the failure this avoids.
                let canScan = centralState == .poweredOn
                let canAdvertise = peripheralState == .poweredOn

                var limitations: [String] = []
                for state in [centralState, peripheralState] {
                    for sentence in Self.limitationSentences(for: state)
                    where !limitations.contains(sentence) {
                        limitations.append(sentence)
                    }
                }

                call.resolve([
                    // iOS is a full peripheral: unlike ChromeOS it can advertise,
                    // so an all-iPad team can host a mesh. This is still gated on
                    // the radio actually being on, above.
                    "canAdvertise": canAdvertise,
                    "canScan": canScan,
                    "maxMtu": (canScan || canAdvertise) ? CourierGatt.maxAttMtu : CourierGatt.minMtu,
                    // 'software', and not negotiable. `KeyBacking.hardware`
                    // means a non-exportable platform keystore holds the signing
                    // key. The Secure Enclave only does NIST P-256; Courier signs
                    // Ed25519, and it signs in JavaScript, so the private key is
                    // in the WebView's heap and no part of this plugin touches
                    // it. Reporting 'hardware' here would be a straight lie, and
                    // the pairing ceremony shows this value to a human.
                    "keyBacking": "software",
                    "limitations": limitations,
                ])
            }
        }
    }

    /// Operator-readable sentences. These are shown verbatim by
    /// `meshBlockers()`, so they say what to do, not what went wrong.
    private static func limitationSentences(for state: CBManagerState) -> [String] {
        switch state {
        case .poweredOn:
            return []
        case .poweredOff:
            return ["Bluetooth is turned off. Turn it on in Control Centre or in Settings, "
                + "then try again. Until then this device can still move data by USB or QR."]
        case .unauthorized:
            return ["This app is not allowed to use Bluetooth. Turn it on in "
                + "Settings › Privacy & Security › Bluetooth, find this app, and enable it. "
                + "Until then this device can still move data by USB or QR."]
        case .unsupported:
            return ["This device has no Bluetooth Low Energy radio, so it cannot join a "
                + "Courier mesh at all. Move data by USB or QR instead."]
        case .resetting:
            return ["The Bluetooth system is restarting. Wait a few seconds and try again."]
        case .unknown:
            return ["iOS has not reported the state of the Bluetooth radio yet. "
                + "Try again in a moment."]
        @unknown default:
            return ["iOS reported a Bluetooth state this app does not recognise. "
                + "Treat radio sync as unavailable and use USB or QR."]
        }
    }

    // MARK: requestPermissions

    /// `override` because `CAPPlugin` declares `requestPermissions` as part of
    /// Capacitor's standard permission pattern and its default implementation
    /// calls `unimplemented()`. (If a Capacitor version without that base method
    /// is ever targeted, drop the keyword — the compiler will say so.)
    @objc override public func requestPermissions(_ call: CAPPluginCall) {
        queue.async { [weak self] in
            guard let self else { return call.reject("the Courier BLE plugin was unloaded") }
            // iOS has no "request Bluetooth permission" API. The prompt is
            // raised by the system the first time a CBCentralManager or
            // CBPeripheralManager is used, which `withSettledState` does by
            // constructing them. After that, `CBManager.authorization` reports
            // what the user chose.
            self.withSettledState {
                let authorization = CBManager.authorization
                let state = self.central.state

                // Authorization and power are different conditions, and this
                // deliberately folds them together: the caller's next move is
                // the same either way ("you cannot sync by radio yet, here is
                // what to do"), and answering `granted: true` on a device with
                // the radio switched off would make every following call fail
                // with no explanation attached.
                switch authorization {
                case .allowedAlways:
                    if state == .poweredOn {
                        call.resolve(["granted": true])
                    } else {
                        let reason = Self.limitationSentences(for: state).first
                            ?? "Bluetooth is not available on this device right now."
                        call.resolve(["granted": false, "reason": reason])
                    }
                case .denied:
                    call.resolve([
                        "granted": false,
                        "reason": "This app was denied permission to use Bluetooth. Turn it on in "
                            + "Settings › Privacy & Security › Bluetooth, find this app, and "
                            + "enable it. Sync by USB or QR works without any permission.",
                    ])
                case .restricted:
                    call.resolve([
                        "granted": false,
                        "reason": "Bluetooth is restricted on this device, usually by Screen Time "
                            + "or a school device-management profile. A school-managed iPad often "
                            + "cannot be changed by the student using it — ask whoever manages the "
                            + "devices, or sync by USB or QR instead.",
                    ])
                case .notDetermined:
                    // The prompt is on screen, or the user dismissed it without
                    // choosing. Either way there is nothing to report yet.
                    call.resolve([
                        "granted": false,
                        "reason": "iOS has not yet been told whether this app may use Bluetooth. "
                            + "Answer the permission prompt, then try again.",
                    ])
                @unknown default:
                    call.resolve([
                        "granted": false,
                        "reason": "iOS reported a Bluetooth permission state this app does not "
                            + "recognise. Treat radio sync as unavailable and use USB or QR.",
                    ])
                }
            }
        }
    }

    // MARK: advertising

    @objc func startAdvertising(_ call: CAPPluginCall) {
        guard let label = call.getString("label"), !label.trimmingCharacters(in: .whitespaces).isEmpty
        else {
            return call.reject("startAdvertising requires a non-empty device label")
        }
        // D-20: this is a DEVICE label — "pit-laptop", "stands-tablet-3". The
        // plugin surface has no field that could carry a person's name, and it
        // must not grow one: this string is broadcast in the clear to everyone
        // in radio range of a public event attended by minors.
        queue.async { [weak self] in
            guard let self else { return call.reject("the Courier BLE plugin was unloaded") }
            self.withSettledState {
                self.peripheral.startAdvertising(label: label) { error in
                    if let error {
                        call.reject(error.localizedDescription, nil, error)
                    } else {
                        call.resolve()
                    }
                }
            }
        }
    }

    @objc func stopAdvertising(_ call: CAPPluginCall) {
        queue.async { [weak self] in
            guard let self else { return call.reject("the Courier BLE plugin was unloaded") }
            self.peripheral.stopAdvertising()
            call.resolve()
        }
    }

    // MARK: scanning

    @objc func startScan(_ call: CAPPluginCall) {
        queue.async { [weak self] in
            guard let self else { return call.reject("the Courier BLE plugin was unloaded") }
            self.withSettledState {
                if let error = self.central.startScan() {
                    call.reject(error.localizedDescription, nil, error)
                } else {
                    call.resolve()
                }
            }
        }
    }

    @objc func stopScan(_ call: CAPPluginCall) {
        queue.async { [weak self] in
            guard let self else { return call.reject("the Courier BLE plugin was unloaded") }
            self.central.stopScan()
            call.resolve()
        }
    }

    // MARK: connections

    @objc func connect(_ call: CAPPluginCall) {
        guard let peerId = call.getString("peerId"), !peerId.isEmpty else {
            return call.reject("connect requires a peerId")
        }
        queue.async { [weak self] in
            guard let self else { return call.reject("the Courier BLE plugin was unloaded") }

            // A peer this device discovered by scanning: we are the central and
            // there is a real connection to open.
            if self.central.knows(peerId: peerId) {
                self.central.connect(peerId: peerId) { result in
                    switch result {
                    case .success(let mtu):
                        call.resolve(["peerId": peerId, "mtu": mtu])
                    case .failure(let error):
                        call.reject(error.localizedDescription, nil, error)
                    }
                }
                return
            }

            // A peer that found US: it is a central that has subscribed to our
            // TX characteristic, so the connection already exists and iOS gives
            // no way to "open" it. `connect` is then just the point where the
            // TypeScript side asks for the MTU before building its link. Same
            // contract, no extra method on the boundary — which is the whole
            // reason this case is handled here rather than by adding an event.
            if let mtu = self.peripheral.mtu(forPeerId: peerId) {
                call.resolve(["peerId": peerId, "mtu": mtu])
                return
            }

            call.reject("no peer with that id is known — it was never discovered, or it has gone")
        }
    }

    @objc func disconnect(_ call: CAPPluginCall) {
        guard let peerId = call.getString("peerId"), !peerId.isEmpty else {
            return call.reject("disconnect requires a peerId")
        }
        queue.async { [weak self] in
            guard let self else { return call.reject("the Courier BLE plugin was unloaded") }
            if !self.central.disconnect(peerId: peerId) {
                _ = self.peripheral.forget(peerId: peerId)
            }
            // Disconnecting something already gone is not an error; the caller
            // is trying to end up in a state it is already in.
            call.resolve()
        }
    }

    // MARK: write

    @objc func write(_ call: CAPPluginCall) {
        guard let peerId = call.getString("peerId"), !peerId.isEmpty else {
            return call.reject("write requires a peerId")
        }
        guard let packet = call.getString("packet") else {
            return call.reject("write requires a base64 packet")
        }
        guard let data = Data(base64Encoded: packet), !data.isEmpty else {
            // The framing layer never produces an empty packet — the smallest
            // one is a 5-byte header — so this is a bug above, not a peer
            // problem, and it should be loud.
            return call.reject("packet was not valid, non-empty base64")
        }

        queue.async { [weak self] in
            guard let self else { return call.reject("the Courier BLE plugin was unloaded") }

            // The two roles hold disjoint sets of handles, so try one and fall
            // through to the other.
            var outcome = self.central.write(peerId: peerId, data: data)
            if case .unknownPeer = outcome {
                outcome = self.peripheral.write(peerId: peerId, data: data)
            }

            switch outcome {
            case .accepted:
                call.resolve(["accepted": true])

            case .refused:
                // THE case the design cares about. The stack did not take the
                // packet; it has not been sent, and nothing here is holding a
                // copy. Resolving with `accepted: false` (not rejecting) is what
                // makes `PluginGattTransport` keep the packet at the head of its
                // queue and re-send it — in order — when `readyToWrite` fires.
                // Returning true here would lose data silently and it would
                // surface later as a signature failure on some unrelated record.
                call.resolve(["accepted": false])

            case .tooLarge(let max):
                call.reject(
                    "packet of \(data.count) bytes does not fit this connection, which carries "
                        + "at most \(max) bytes per packet. The MTU reported by connect() is what "
                        + "framing must size against.")

            case .unknownPeer:
                // `PluginGattTransport` treats a rejected write as a disconnect,
                // which is exactly right: there is no connection left to write to.
                call.reject("no live connection for that peer — it has disconnected")
            }
        }
    }

    // MARK: state settling

    /// Runs `body` on `queue` once both managers have reported a state, or after
    /// `stateSettleTimeout`, whichever comes first.
    ///
    /// Constructing the managers here is also what raises the iOS Bluetooth
    /// permission prompt the first time round; see `load()`.
    private func withSettledState(_ body: @escaping () -> Void) {
        dispatchPrecondition(condition: .onQueue(queue))
        central.ensureManager()
        peripheral.ensureManager()

        // `settled` is captured by two escaping closures, both of which run on
        // this serial queue, so the check-and-set needs no synchronisation.
        var settled = false
        let finish = {
            if settled { return }
            settled = true
            body()
        }

        // Always answer. A manager that never reports its state must not turn
        // into a JS promise that never settles; `capabilities()` will then say
        // "iOS has not reported the state of the Bluetooth radio yet", which is
        // both true and actionable.
        queue.asyncAfter(deadline: .now() + CourierGatt.stateSettleTimeout) { finish() }

        central.onStateSettled { [weak self] in
            guard let self else { return }
            self.peripheral.onStateSettled { finish() }
        }
    }
}

// MARK: - Events

extension CourierBlePlugin: CourierEventSink {
    /// Packet contents are NEVER logged, here or anywhere else in this
    /// directory. They are scouting records belonging to minors' teams, they are
    /// signed but not encrypted, and `os.Logger` output is readable by anyone
    /// with the device on a cable. Lifecycle only.
    func emitPacketReceived(peerId: String, base64: String) {
        // `retainUntilConsumed` matters here. `openLink()` in transport.ts calls
        // `connect()` and only then attaches its listeners, so a peer that
        // starts notifying immediately can produce a packet in the window before
        // anything in JS is listening. Without retention that packet is dropped,
        // the reassembler never sees sequence 0, and the sync stalls on a frame
        // that will never complete. Retaining costs memory bounded by what a
        // peer sends before its own 15-second stall timeout fires.
        notify("packetReceived", ["peerId": peerId, "packet": base64], retain: true)
    }

    func emitReadyToWrite(peerId: String) {
        // Not retained: a refusal can only follow a `write()`, which can only
        // follow the listener being attached.
        notify("readyToWrite", ["peerId": peerId], retain: false)
    }

    func emitPeerFound(peerId: String, label: String, rssi: Int?) {
        var data: [String: Any] = ["peerId": peerId, "label": label]
        if let rssi { data["rssi"] = rssi }
        // Not retained: a peer discovered before anyone was listening is stale
        // by the time a listener arrives, and the next scan will find it again.
        notify("peerFound", data, retain: false)
    }

    func emitDisconnected(peerId: String, reason: String?) {
        var data: [String: Any] = ["peerId": peerId]
        if let reason { data["reason"] = reason }
        // Retained for the same reason as packets, and with worse consequences
        // if dropped: a link that misses its disconnect waits on `receive()`
        // forever. On an event floor a peer walking away is the ordinary case.
        notify("disconnected", data, retain: true)
    }

    /// All four events funnel through here so the ordering argument lives in one
    /// place.
    ///
    /// Every emission is enqueued from the single serial BLE queue onto the main
    /// queue, and both are FIFO, so events reach JavaScript in the order Core
    /// Bluetooth produced them. That is load-bearing: `Reassembler` rejects an
    /// out-of-order packet rather than splicing it, so a reordering here would
    /// cost a frame every time it happened.
    private func notify(_ event: String, _ data: [String: Any], retain: Bool) {
        DispatchQueue.main.async { [weak self] in
            self?.notifyListeners(event, data: data, retainUntilConsumed: retain)
        }
    }
}
