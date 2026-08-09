//
//  CourierCentral.swift
//  @courier/capacitor
//
//  The central half: scan for the Courier service, connect, discover the two
//  characteristics, subscribe to TX, write packets to RX.
//
//  The MTU this file reports is the one the whole framing layer sizes packets
//  against, so `mtu(for:)` is worth reading closely — iOS does not give you an
//  ATT MTU, it gives you a payload length, and the two differ by three bytes.
//
//  Backpressure on this side is `canSendWriteWithoutResponse` /
//  `peripheralIsReady(toSend:)`, which is the same contract as the peripheral
//  role's `updateValue` returning false: a refusal means the packet was NOT
//  sent, and the TypeScript side retries the same bytes after `readyToWrite`.
//
//  Not compiled, not run, no device.
//

import CoreBluetooth
import Foundation
import os

final class CourierCentral: NSObject {
    private let queue: DispatchQueue
    private weak var sink: CourierEventSink?
    private let log = Logger(subsystem: CourierGatt.logSubsystem, category: "central")

    private var manager: CBCentralManager?

    private struct Peer {
        /// Retained here for the lifetime of the session. Core Bluetooth does
        /// NOT hold on to a discovered peripheral for you: drop the last
        /// reference and the connection dies, usually looking like a peer that
        /// randomly vanished mid-sync.
        let peripheral: CBPeripheral
        var rx: CBCharacteristic?
        var tx: CBCharacteristic?
        var writeType: CBCharacteristicWriteType = .withoutResponse
        var mtu: Int = CourierGatt.minMtu
        var connected = false
        var ready = false
        /// A `.withResponse` write is outstanding; only one at a time.
        var responseWriteInFlight = false
        /// This peer was refused and is owed a `readyToWrite`.
        var awaitingReady = false
        var readyPollArmed = false
    }

    private var peers: [String: Peer] = [:]
    /// `CBPeripheral.identifier` → handle. Deliberately separate from the
    /// peripheral controller's table; see the note there.
    private var handles: [UUID: String] = [:]

    private struct PendingConnect {
        let token: UUID
        let completion: (Result<Int, Error>) -> Void
    }
    private var pendingConnects: [String: PendingConnect] = [:]
    private var stateWaiters: [() -> Void] = []
    private var wantScan = false

    init(queue: DispatchQueue, sink: CourierEventSink) {
        self.queue = queue
        self.sink = sink
        super.init()
    }

    // MARK: - Lifecycle

    var state: CBManagerState {
        manager?.state ?? .unknown
    }

    func ensureManager() {
        dispatchPrecondition(condition: .onQueue(queue))
        guard manager == nil else { return }
        manager = CBCentralManager(
            delegate: self,
            queue: queue,
            options: [
                // See the peripheral controller: this plugin reports the power
                // state itself, in a sentence an operator can act on.
                CBCentralManagerOptionShowPowerAlertKey: false,
                // Deliberately no CBCentralManagerOptionRestoreIdentifierKey.
                // See ios/README.md.
            ])
    }

    func onStateSettled(_ block: @escaping () -> Void) {
        dispatchPrecondition(condition: .onQueue(queue))
        ensureManager()
        if state != .unknown {
            block()
        } else {
            stateWaiters.append(block)
        }
    }

    func shutdown() {
        dispatchPrecondition(condition: .onQueue(queue))
        wantScan = false
        manager?.stopScan()
        for (peerId, peer) in peers where peer.connected {
            manager?.cancelPeripheralConnection(peer.peripheral)
            sink?.emitDisconnected(peerId: peerId, reason: "the app tore down its Bluetooth stack")
        }
        failAllPendingConnects(CourierBleError("the Bluetooth stack was torn down"))
        peers.removeAll()
        handles.removeAll()
        stateWaiters.removeAll()
        manager = nil
    }

    // MARK: - Scanning

    /// Starts scanning. Returns an error to report instead of starting, or nil.
    func startScan() -> Error? {
        dispatchPrecondition(condition: .onQueue(queue))
        ensureManager()
        guard let manager else {
            return CourierBleError("the Bluetooth central could not be created")
        }
        guard manager.state == .poweredOn else {
            // Calling scanForPeripherals while powered off does nothing except
            // log a warning to the console, which nobody in the stands will see.
            return CourierBleError(Self.unavailableSentence(for: manager.state))
        }
        wantScan = true
        manager.scanForPeripherals(
            withServices: [CourierGatt.serviceUUID],
            options: [
                // One `peerFound` per device per scan. Duplicates would only be
                // useful for a live RSSI readout, and they cost battery on a
                // device that has to last a full competition day. (iOS also
                // ignores this option entirely when scanning in the background.)
                CBCentralManagerScanOptionAllowDuplicatesKey: false
            ])
        log.info("scanning for the Courier service")
        return nil
    }

    func stopScan() {
        dispatchPrecondition(condition: .onQueue(queue))
        wantScan = false
        manager?.stopScan()
        log.info("stopped scanning")
        // Discovered peripherals are kept, not pruned: their handles have
        // already been handed to JavaScript and must keep resolving. The set is
        // bounded by the number of devices advertising the Courier service in
        // radio range, because the scan is filtered by service UUID — an FRC
        // venue is full of Bluetooth, but almost none of it is this.
    }

    // MARK: - Peers

    func knows(peerId: String) -> Bool {
        dispatchPrecondition(condition: .onQueue(queue))
        return peers[peerId] != nil
    }

    func connect(peerId: String, completion: @escaping (Result<Int, Error>) -> Void) {
        dispatchPrecondition(condition: .onQueue(queue))
        guard let peer = peers[peerId] else {
            completion(.failure(CourierBleError("that peer was never discovered by this device")))
            return
        }
        guard let manager, manager.state == .poweredOn else {
            completion(.failure(CourierBleError(Self.unavailableSentence(for: state))))
            return
        }
        // Already up: hand back the MTU rather than tearing down a working link.
        if peer.connected, peer.ready {
            completion(.success(peer.mtu))
            return
        }
        guard pendingConnects[peerId] == nil else {
            completion(.failure(CourierBleError("a connection to that peer is already opening")))
            return
        }

        let token = UUID()
        pendingConnects[peerId] = PendingConnect(token: token, completion: completion)
        peer.peripheral.delegate = self
        manager.connect(peer.peripheral, options: nil)
        log.info("connecting to peer \(peerId, privacy: .public)")

        // Core Bluetooth's connect has no timeout of its own — it waits for the
        // peer to come back into range, forever. A scout who walked to the pit
        // must not leave a promise pending for the rest of the day.
        queue.asyncAfter(deadline: .now() + CourierGatt.connectTimeout) { [weak self] in
            guard let self, self.pendingConnects[peerId]?.token == token else { return }
            if let peripheral = self.peers[peerId]?.peripheral {
                self.manager?.cancelPeripheralConnection(peripheral)
            }
            self.finishConnect(
                peerId: peerId,
                result: .failure(
                    CourierBleError(
                        "the peer did not answer within \(Int(CourierGatt.connectTimeout)) "
                            + "seconds. It has probably moved out of range.")))
        }
    }

    /// Returns false if the handle is not one of ours, so the caller can try the
    /// peripheral role.
    @discardableResult
    func disconnect(peerId: String) -> Bool {
        dispatchPrecondition(condition: .onQueue(queue))
        guard let peer = peers[peerId] else { return false }

        failPendingConnect(peerId, CourierBleError("the connection was cancelled by this device"))

        if peer.connected {
            // `didDisconnectPeripheral` emits the event.
            manager?.cancelPeripheralConnection(peer.peripheral)
        } else {
            // Nothing to cancel, but the caller asked for the link to be over,
            // and a link that never hears about it waits on `receive()` forever.
            resetPeerState(peerId)
            sink?.emitDisconnected(peerId: peerId, reason: "this device closed the link")
        }
        return true
    }

    // MARK: - Writing

    func write(peerId: String, data: Data) -> CourierWriteOutcome {
        dispatchPrecondition(condition: .onQueue(queue))
        guard let peer = peers[peerId], peer.connected, peer.ready, let rx = peer.rx else {
            return .unknownPeer
        }

        // Always the without-response length, whichever write type is in use.
        // For `.withResponse` iOS reports 512 — the long-write ceiling reached by
        // splitting the value across several ATT PDUs with increasing offsets —
        // and that is emphatically not the ATT MTU. Sizing packets against it
        // would produce writes the far side receives as offset fragments, which
        // the peripheral role deliberately refuses.
        let maximum = peer.peripheral.maximumWriteValueLength(for: .withoutResponse)
        if data.count > maximum {
            return .tooLarge(max: maximum)
        }

        if peer.writeType == .withoutResponse {
            // Apple's guidance: check this before every write and wait for
            // `peripheralIsReady(toSend:)` when it is false. This is the central
            // half of the same backpressure the peripheral half gets from
            // `updateValue` returning false — the packet is not sent, not
            // buffered here, and not lost, because the TypeScript side still has
            // it.
            guard peer.peripheral.canSendWriteWithoutResponse else {
                peers[peerId]?.awaitingReady = true
                armReadyPoll(peerId)
                return .refused
            }
            peer.peripheral.writeValue(data, for: rx, type: .withoutResponse)
            return .accepted
        }

        // Fallback path: the peer's RX characteristic does not support
        // write-without-response. Flow control is then one write at a time,
        // released by `didWriteValueFor`.
        if peer.responseWriteInFlight {
            peers[peerId]?.awaitingReady = true
            return .refused
        }
        peers[peerId]?.responseWriteInFlight = true
        peer.peripheral.writeValue(data, for: rx, type: .withResponse)
        return .accepted
    }

    /// A safety net around `peripheralIsReady(toSend:)`.
    ///
    /// Apple documents that callback as firing when the peripheral is "again"
    /// ready, which leaves it ambiguous whether it fires at all if
    /// `canSendWriteWithoutResponse` was false before this plugin ever attempted
    /// a write — a state that has been reported in the field immediately after a
    /// connection comes up. I cannot test that without a device. If the callback
    /// never comes, the link stalls for 15 seconds and then fails, which would
    /// be a miserable thing to debug at an event, so readiness is also polled
    /// while a peer is owed a signal. The poll stops as soon as either path
    /// fires.
    private func armReadyPoll(_ peerId: String) {
        guard peers[peerId]?.readyPollArmed == false else { return }
        peers[peerId]?.readyPollArmed = true
        scheduleReadyPoll(peerId)
    }

    private func scheduleReadyPoll(_ peerId: String) {
        queue.asyncAfter(deadline: .now() + 0.1) { [weak self] in
            guard let self, let peer = self.peers[peerId] else { return }
            guard peer.awaitingReady, peer.connected, peer.writeType == .withoutResponse else {
                self.peers[peerId]?.readyPollArmed = false
                return
            }
            if peer.peripheral.canSendWriteWithoutResponse {
                self.peers[peerId]?.readyPollArmed = false
                self.signalReady(peerId)
                return
            }
            self.scheduleReadyPoll(peerId)
        }
    }

    private func signalReady(_ peerId: String) {
        guard peers[peerId]?.awaitingReady == true else { return }
        peers[peerId]?.awaitingReady = false
        sink?.emitReadyToWrite(peerId: peerId)
    }

    // MARK: - Internals

    private func handle(for peripheral: CBPeripheral) -> String {
        if let existing = handles[peripheral.identifier] { return existing }
        let peerId = CourierPeerHandle.make()
        handles[peripheral.identifier] = peerId
        return peerId
    }

    private func peerId(for peripheral: CBPeripheral) -> String? {
        handles[peripheral.identifier]
    }

    private func finishConnect(peerId: String, result: Result<Int, Error>) {
        guard let pending = pendingConnects.removeValue(forKey: peerId) else { return }
        pending.completion(result)
    }

    private func failPendingConnect(_ peerId: String, _ error: Error) {
        finishConnect(peerId: peerId, result: .failure(error))
    }

    private func failAllPendingConnects(_ error: Error) {
        let pending = pendingConnects
        pendingConnects.removeAll()
        for (_, entry) in pending { entry.completion(.failure(error)) }
    }

    /// Clears everything connection-scoped but keeps the peer's identity, so a
    /// reconnect during the same session reuses the same `peerId`.
    private func resetPeerState(_ peerId: String) {
        peers[peerId]?.rx = nil
        peers[peerId]?.tx = nil
        peers[peerId]?.connected = false
        peers[peerId]?.ready = false
        peers[peerId]?.responseWriteInFlight = false
        peers[peerId]?.awaitingReady = false
        peers[peerId]?.readyPollArmed = false
    }

    private func abandon(peerId: String, peripheral: CBPeripheral, because message: String) {
        log.info("peer \(peerId, privacy: .public) rejected: \(message, privacy: .public)")
        manager?.cancelPeripheralConnection(peripheral)
        failPendingConnect(peerId, CourierBleError(message))
    }

    private static func unavailableSentence(for state: CBManagerState) -> String {
        switch state {
        case .poweredOff:
            return "Bluetooth is turned off, so this device cannot look for other devices. "
                + "Turn it on in Control Centre or in Settings."
        case .unauthorized:
            return "This app is not allowed to use Bluetooth. Enable it in "
                + "Settings › Privacy & Security › Bluetooth."
        case .unsupported:
            return "This device has no Bluetooth Low Energy radio. Move data by USB or QR."
        case .resetting:
            return "The Bluetooth system is restarting. Try again in a few seconds."
        default:
            return "Bluetooth is not ready yet. Try again in a moment."
        }
    }
}

// MARK: - CBCentralManagerDelegate

extension CourierCentral: CBCentralManagerDelegate {
    func centralManagerDidUpdateState(_ central: CBCentralManager) {
        log.info("central manager state: \(central.state.rawValue, privacy: .public)")

        if central.state == .poweredOn {
            if wantScan { _ = startScan() }
        } else {
            // Every connection is gone. Announce them all: a link that never
            // hears about the disconnect blocks on `receive()` forever, and on
            // an event floor "the radio went away" is an ordinary Tuesday.
            for (peerId, peer) in peers where peer.connected {
                resetPeerState(peerId)
                sink?.emitDisconnected(peerId: peerId, reason: "Bluetooth became unavailable")
            }
            failAllPendingConnects(CourierBleError(Self.unavailableSentence(for: central.state)))
        }

        let waiters = stateWaiters
        stateWaiters = []
        for waiter in waiters { waiter() }
    }

    func centralManager(
        _ central: CBCentralManager, didDiscover peripheral: CBPeripheral,
        advertisementData: [String: Any], rssi RSSI: NSNumber
    ) {
        let peerId = handle(for: peripheral)
        if peers[peerId] == nil {
            peers[peerId] = Peer(peripheral: peripheral)
        }

        // Prefer the name in this advertisement over `peripheral.name`, which is
        // the cached GAP name and can be stale or absent.
        let label =
            (advertisementData[CBAdvertisementDataLocalNameKey] as? String)
            ?? peripheral.name
            ?? ""

        // 127 is Core Bluetooth's "RSSI unavailable"; a non-negative value is
        // meaningless for a received signal. Omit rather than report a number
        // that would show up as a full-strength bar.
        let raw = RSSI.intValue
        let rssi: Int? = (raw >= 0) ? nil : raw

        log.info("found peer \(peerId, privacy: .public)")
        sink?.emitPeerFound(peerId: peerId, label: label, rssi: rssi)
    }

    func centralManager(_ central: CBCentralManager, didConnect peripheral: CBPeripheral) {
        guard let peerId = peerId(for: peripheral) else { return }
        peers[peerId]?.connected = true
        peripheral.delegate = self
        log.info("connected to peer \(peerId, privacy: .public), discovering the Courier service")
        peripheral.discoverServices([CourierGatt.serviceUUID])
    }

    func centralManager(
        _ central: CBCentralManager, didFailToConnect peripheral: CBPeripheral, error: Error?
    ) {
        guard let peerId = peerId(for: peripheral) else { return }
        resetPeerState(peerId)
        let detail = error?.localizedDescription ?? "no reason given"
        log.info("connection to peer \(peerId, privacy: .public) failed: \(detail, privacy: .public)")
        failPendingConnect(peerId, CourierBleError("could not connect to that peer: " + detail))
    }

    func centralManager(
        _ central: CBCentralManager, didDisconnectPeripheral peripheral: CBPeripheral, error: Error?
    ) {
        guard let peerId = peerId(for: peripheral) else { return }
        let wasConnected = peers[peerId]?.connected ?? false
        resetPeerState(peerId)

        let reason = error?.localizedDescription
        let detail = reason ?? "closed cleanly"
        log.info("peer \(peerId, privacy: .public) disconnected: \(detail, privacy: .public)")

        if pendingConnects[peerId] != nil {
            // The connection died while it was still being set up; the rejected
            // promise is the signal, and an extra `disconnected` for a link that
            // was never handed out would be noise.
            failPendingConnect(
                peerId,
                CourierBleError("the connection dropped before it was ready: "
                    + (reason ?? "no reason given")))
            return
        }

        if wasConnected {
            sink?.emitDisconnected(peerId: peerId, reason: reason)
        }
    }
}

// MARK: - CBPeripheralDelegate

extension CourierCentral: CBPeripheralDelegate {
    func peripheral(_ peripheral: CBPeripheral, didDiscoverServices error: Error?) {
        guard let peerId = peerId(for: peripheral) else { return }
        if let error {
            abandon(
                peerId: peerId, peripheral: peripheral,
                because: "could not read the peer's Bluetooth services: " + error.localizedDescription)
            return
        }
        guard let service = peripheral.services?.first(where: { $0.uuid == CourierGatt.serviceUUID })
        else {
            abandon(
                peerId: peerId, peripheral: peripheral,
                because: "that device does not publish the Courier service, so it is not a "
                    + "Courier device")
            return
        }
        peripheral.discoverCharacteristics(
            [CourierGatt.rxUUID, CourierGatt.txUUID], for: service)
    }

    func peripheral(
        _ peripheral: CBPeripheral, didDiscoverCharacteristicsFor service: CBService, error: Error?
    ) {
        guard let peerId = peerId(for: peripheral) else { return }
        guard service.uuid == CourierGatt.serviceUUID else { return }
        if let error {
            abandon(
                peerId: peerId, peripheral: peripheral,
                because: "could not read the Courier service on that device: "
                    + error.localizedDescription)
            return
        }

        let characteristics = service.characteristics ?? []
        guard let rx = characteristics.first(where: { $0.uuid == CourierGatt.rxUUID }),
            let tx = characteristics.first(where: { $0.uuid == CourierGatt.txUUID })
        else {
            abandon(
                peerId: peerId, peripheral: peripheral,
                because: "that device publishes the Courier service but not both of its "
                    + "characteristics, so it is running an incompatible build")
            return
        }

        // Write-without-response is the only type with usable throughput; the
        // with-response path exists so an implementation that offers only
        // `.write` still works, slowly, rather than silently dropping every
        // packet.
        let writeType: CBCharacteristicWriteType
        if rx.properties.contains(.writeWithoutResponse) {
            writeType = .withoutResponse
        } else if rx.properties.contains(.write) {
            writeType = .withResponse
            log.info(
                "peer \(peerId, privacy: .public) has no write-without-response; using acknowledged writes"
            )
        } else {
            abandon(
                peerId: peerId, peripheral: peripheral,
                because: "that device's Courier receive characteristic cannot be written to")
            return
        }

        peers[peerId]?.rx = rx
        peers[peerId]?.tx = tx
        peers[peerId]?.writeType = writeType
        // See `write` for why this is always the without-response length.
        peers[peerId]?.mtu = max(
            CourierGatt.minMtu,
            peripheral.maximumWriteValueLength(for: .withoutResponse) + CourierGatt.attOverhead)

        // The link is not usable until notifications are on: without this,
        // nothing the peer sends ever arrives.
        peripheral.setNotifyValue(true, for: tx)
    }

    func peripheral(
        _ peripheral: CBPeripheral, didUpdateNotificationStateFor characteristic: CBCharacteristic,
        error: Error?
    ) {
        guard let peerId = peerId(for: peripheral) else { return }
        guard characteristic.uuid == CourierGatt.txUUID else { return }

        if let error {
            abandon(
                peerId: peerId, peripheral: peripheral,
                because: "could not subscribe to that device's notifications: "
                    + error.localizedDescription)
            return
        }

        guard characteristic.isNotifying else {
            // Notifications turned off. During teardown that is expected; with a
            // connect in flight it means the link never came up.
            failPendingConnect(
                peerId, CourierBleError("that device turned notifications off before the link was ready"))
            return
        }

        peers[peerId]?.ready = true
        let mtu = peers[peerId]?.mtu ?? CourierGatt.minMtu
        log.info("peer \(peerId, privacy: .public) ready, ATT MTU \(mtu, privacy: .public)")
        finishConnect(peerId: peerId, result: .success(mtu))
    }

    func peripheral(
        _ peripheral: CBPeripheral, didUpdateValueFor characteristic: CBCharacteristic, error: Error?
    ) {
        guard let peerId = peerId(for: peripheral) else { return }
        guard characteristic.uuid == CourierGatt.txUUID else { return }
        if let error {
            // No contents, no length: lifecycle only. A lost notification costs
            // one frame, which the reassembler discards and the peer re-offers
            // on the next round, because the store is grow-only.
            let detail = error.localizedDescription
            log.info("notification from peer \(peerId, privacy: .public) failed: \(detail, privacy: .public)")
            return
        }
        guard let value = characteristic.value, !value.isEmpty else { return }
        sink?.emitPacketReceived(peerId: peerId, base64: value.base64EncodedString())
    }

    /// The central-role counterpart of
    /// `peripheralManagerIsReady(toUpdateSubscribers:)`.
    func peripheralIsReady(toSend peripheral: CBPeripheral) {
        guard let peerId = peerId(for: peripheral) else { return }
        peers[peerId]?.readyPollArmed = false
        signalReady(peerId)
    }

    func peripheral(
        _ peripheral: CBPeripheral, didWriteValueFor characteristic: CBCharacteristic, error: Error?
    ) {
        guard let peerId = peerId(for: peripheral) else { return }
        guard characteristic.uuid == CourierGatt.rxUUID else { return }
        peers[peerId]?.responseWriteInFlight = false

        if let error {
            // Only reachable on the acknowledged-write fallback path, and it is
            // an honest gap: this plugin already told JavaScript `accepted: true`
            // for these bytes and cannot take that back. The consequence is one
            // abandoned frame on the far side, not a corrupt store — the peer
            // re-offers the same records next round.
            let detail = error.localizedDescription
            log.info("write to peer \(peerId, privacy: .public) failed: \(detail, privacy: .public)")
        }
        signalReady(peerId)
    }
}
