//
//  CourierPeripheral.swift
//  @courier/capacitor
//
//  The peripheral (GATT server) half: publish the Courier service, advertise it
//  so peers can find this device, notify packets out on TX, take packets in on
//  RX.
//
//  This is the half a PWA cannot do — no browser implements the peripheral role
//  — and it is the reason the plugin exists at all. Two devices in the stands
//  need one of them to advertise.
//
//  The important part of this file is `write` / `peripheralManagerIsReady`.
//  `CBPeripheralManager.updateValue` returns false when the stack's queue is
//  full, and when it does, THE PACKET WAS NOT SENT. Everything else here is
//  bookkeeping around that fact.
//
//  Not compiled, not run, no device. Behavioural claims are from Apple's
//  documentation and are marked where they matter.
//

import CoreBluetooth
import Foundation
import os

final class CourierPeripheral: NSObject {
    private let queue: DispatchQueue
    private weak var sink: CourierEventSink?
    private let log = Logger(subsystem: CourierGatt.logSubsystem, category: "peripheral")

    private var manager: CBPeripheralManager?
    /// Held because `updateValue` needs the mutable characteristic object; the
    /// RX characteristic needs no reference, since writes arrive as ATT requests.
    private var txCharacteristic: CBMutableCharacteristic?

    private enum ServicePublication {
        case absent
        case adding
        case present
    }
    private var servicePublication: ServicePublication = .absent

    /// Non-nil means "we want to be advertising, under this label". Kept so
    /// advertising can be resumed after the radio comes back, which iOS does not
    /// do for us.
    private var desiredLabel: String?

    private struct AdvertiseWaiter {
        let token: UUID
        let completion: (Error?) -> Void
    }
    private var advertiseWaiters: [AdvertiseWaiter] = []
    private var stateWaiters: [() -> Void] = []

    /// Centrals that have subscribed to TX, by the handle we assigned them.
    private var centrals: [String: CBCentral] = [:]
    /// `CBCentral.identifier` → handle. Separate from the central controller's
    /// table on purpose: one physical device can be simultaneously a peripheral
    /// we connected to and a central that connected to us, and those are two
    /// different links that must not collapse onto one `peerId`.
    private var handles: [UUID: String] = [:]
    /// Peers whose last `updateValue` was refused. Emptied by
    /// `peripheralManagerIsReady(toUpdateSubscribers:)`.
    private var awaitingReady: Set<String> = []

    init(queue: DispatchQueue, sink: CourierEventSink) {
        self.queue = queue
        self.sink = sink
        super.init()
    }

    // MARK: - Lifecycle

    var state: CBManagerState {
        manager?.state ?? .unknown
    }

    /// Builds the manager on first use. See `CourierBlePlugin.load()` for why
    /// this is not done at plugin load.
    func ensureManager() {
        dispatchPrecondition(condition: .onQueue(queue))
        guard manager == nil else { return }
        manager = CBPeripheralManager(
            delegate: self,
            queue: queue,
            options: [
                // No system "Bluetooth is off" alert. This plugin reports the
                // power state through `capabilities().limitations` in a sentence
                // the operator can act on, and an OS alert appearing at an
                // arbitrary moment during a match is worse than a line of text
                // in the app that says the same thing.
                CBPeripheralManagerOptionShowPowerAlertKey: false,
                // Deliberately no CBPeripheralManagerOptionRestoreIdentifierKey.
                // State restoration is not implemented; see ios/README.md for
                // what adopting it would require.
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
        desiredLabel = nil
        if manager?.isAdvertising == true { manager?.stopAdvertising() }
        manager?.removeAllServices()
        servicePublication = .absent
        // Anything still subscribed is now unreachable; say so rather than
        // leaving links waiting on a receive that cannot arrive.
        dropAllCentrals(reason: "the app tore down its Bluetooth stack")
        settleAdvertiseWaiters(CourierBleError("the Bluetooth stack was torn down"))
        stateWaiters.removeAll()
        manager = nil
    }

    // MARK: - Advertising

    func startAdvertising(label: String, completion: @escaping (Error?) -> Void) {
        dispatchPrecondition(condition: .onQueue(queue))
        ensureManager()
        guard let manager else {
            completion(CourierBleError("the Bluetooth peripheral could not be created"))
            return
        }
        guard manager.state == .poweredOn else {
            completion(CourierBleError(Self.unavailableSentence(for: manager.state)))
            return
        }
        // Already advertising under this exact label: the caller wants a state
        // it is already in.
        if manager.isAdvertising, desiredLabel == label {
            completion(nil)
            return
        }
        desiredLabel = label
        addAdvertiseWaiter(completion)
        beginAdvertisingIfWanted()
    }

    func stopAdvertising() {
        dispatchPrecondition(condition: .onQueue(queue))
        desiredLabel = nil
        if manager?.isAdvertising == true {
            manager?.stopAdvertising()
            log.info("stopped advertising")
        }
        // The published service stays. Stopping advertising means "stop being
        // discoverable", not "drop the peers already talking to me" — and iOS
        // gives no way to drop them anyway (see `forget`).
    }

    private func beginAdvertisingIfWanted() {
        dispatchPrecondition(condition: .onQueue(queue))
        guard let manager, manager.state == .poweredOn, let label = desiredLabel else { return }

        switch servicePublication {
        case .absent:
            publishService()
            return  // resumed from peripheralManager(_:didAdd:error:)
        case .adding:
            return
        case .present:
            break
        }

        if manager.isAdvertising { manager.stopAdvertising() }
        manager.startAdvertising([
            CBAdvertisementDataServiceUUIDsKey: [CourierGatt.serviceUUID],
            // The label is what a peer shows in its device list. Two notes, both
            // from Apple's documentation rather than observation:
            //
            //  * A BLE advertisement is 31 bytes and a 128-bit service UUID eats
            //    18 of them, so iOS moves the local name into the scan response.
            //    A long label may be truncated. "pit-laptop" and
            //    "stands-tablet-3" are fine; a sentence is not.
            //  * In the background iOS DROPS the local name entirely and moves
            //    the service UUID into a special "overflow" area that only an
            //    iOS device explicitly scanning for that exact UUID can see.
            //    Backgrounded advertising is therefore close to useless for this
            //    use case and this plugin does not declare a background mode.
            //    See ios/README.md.
            CBAdvertisementDataLocalNameKey: label,
        ])
    }

    private func publishService() {
        dispatchPrecondition(condition: .onQueue(queue))
        guard let manager, manager.state == .poweredOn else { return }

        // Peripheral notifies here. Notify-only: nothing meaningful can be read
        // from it, but a characteristic that supports notification is declared
        // readable, and `didReceiveRead` below answers with an empty value.
        let tx = CBMutableCharacteristic(
            type: CourierGatt.txUUID,
            properties: [.notify],
            value: nil,
            permissions: [.readable])

        // Central writes here. Both write types are advertised: a Courier
        // central uses write-without-response, which is the only one with usable
        // throughput, and `.write` is offered as a fallback for a stack that
        // does not do write-without-response.
        //
        // No `.readEncryptionRequired` / `.writeEncryptionRequired`: those force
        // pairing and a system PIN dance between two devices in the stands
        // during a match. Courier's trust model does not rest on the link — every
        // record is individually signed and verified above this layer, and a
        // forged record bounces off the store. What the link does NOT get is
        // confidentiality; see ios/README.md.
        let rx = CBMutableCharacteristic(
            type: CourierGatt.rxUUID,
            properties: [.write, .writeWithoutResponse],
            value: nil,
            permissions: [.writeable])

        let service = CBMutableService(type: CourierGatt.serviceUUID, primary: true)
        service.characteristics = [tx, rx]

        txCharacteristic = tx
        servicePublication = .adding
        // Idempotent: this is only reached when nothing of ours is published, so
        // clearing first makes a second publication after a radio restart safe
        // rather than a duplicate-UUID add.
        manager.removeAllServices()
        manager.add(service)
    }

    private func addAdvertiseWaiter(_ completion: @escaping (Error?) -> Void) {
        let token = UUID()
        advertiseWaiters.append(AdvertiseWaiter(token: token, completion: completion))
        // `startAdvertising` resolves from a delegate callback, and a delegate
        // callback that never arrives would leave a JS promise pending for the
        // rest of the session.
        queue.asyncAfter(deadline: .now() + CourierGatt.advertiseTimeout) { [weak self] in
            guard let self,
                let index = self.advertiseWaiters.firstIndex(where: { $0.token == token })
            else { return }
            let waiter = self.advertiseWaiters.remove(at: index)
            waiter.completion(
                CourierBleError(
                    "iOS did not confirm that advertising started within "
                        + "\(Int(CourierGatt.advertiseTimeout)) seconds. Other devices probably "
                        + "cannot see this one; try turning Bluetooth off and on again."))
        }
    }

    private func settleAdvertiseWaiters(_ error: Error?) {
        let waiters = advertiseWaiters
        advertiseWaiters = []
        for waiter in waiters { waiter.completion(error) }
    }

    // MARK: - Peers

    /// The ATT MTU for a subscribed central, or nil if it is not one of ours.
    func mtu(forPeerId peerId: String) -> Int? {
        dispatchPrecondition(condition: .onQueue(queue))
        guard let central = centrals[peerId] else { return nil }
        return Self.attMtu(fromPayloadLength: central.maximumUpdateValueLength)
    }

    /// iOS never hands out the negotiated ATT MTU. `maximumUpdateValueLength` is
    /// the largest value that fits in one notification, which is `ATT_MTU - 3`
    /// (the notification PDU spends 1 byte on the opcode and 2 on the handle).
    /// So the ATT MTU the framing layer wants is that plus 3 — and `split()` in
    /// `framing.ts` subtracts the same 3 straight back off, plus its own 5-byte
    /// header. Round-tripping it this way keeps one definition of "MTU" across
    /// the bridge instead of two conventions that differ by three bytes.
    ///
    /// Documented behaviour, not measured.
    ///
    /// No floor at `minMtu`, deliberately. Clamping upward reports a capacity
    /// the connection does not have: `payloadPerPacket()` would then size
    /// packets against 23, every one of them would exceed
    /// `maximumUpdateValueLength`, `send` would return `.tooLarge`, the call
    /// would reject, and `PluginGattTransport` would treat that as a disconnect
    /// — so the link dies pointing at the wrong thing.
    ///
    /// BLE guarantees an ATT MTU of at least 23, so a payload below 20 means
    /// something is already wrong. Reporting it honestly lets `meshBlockers()`
    /// say so; inventing 23 hides it until the first write.
    private static func attMtu(fromPayloadLength payload: Int) -> Int {
        payload + CourierGatt.attOverhead
    }

    /// Forget a central. Returns false if the handle is not one of ours.
    ///
    /// Core Bluetooth gives a peripheral NO way to drop a connected central —
    /// there is no `cancelConnection` on `CBPeripheralManager`. So `disconnect()`
    /// for this role means "stop tracking this peer and tell the JS side the
    /// link is over"; the radio connection lives until the central closes it or
    /// walks out of range. If that same central later writes or re-subscribes it
    /// is treated as a new peer and gets a new handle, which is honest: from
    /// this side it is a new session.
    @discardableResult
    func forget(peerId: String) -> Bool {
        dispatchPrecondition(condition: .onQueue(queue))
        guard let central = centrals.removeValue(forKey: peerId) else { return false }
        handles.removeValue(forKey: central.identifier)
        awaitingReady.remove(peerId)
        log.info("released central \(peerId, privacy: .public)")
        sink?.emitDisconnected(peerId: peerId, reason: "this device closed the link")
        return true
    }

    /// A peer in this role is a central SUBSCRIBED to TX, and nothing else.
    ///
    /// Handles are minted here and only here. That single definition removes an
    /// otherwise nasty ordering problem: a central that wrote before subscribing
    /// would either be announced twice, or be announced as a peer this device
    /// has no way to notify back. A Courier central always enables notifications
    /// during `connect` before it writes anything, so nothing legitimate is lost.
    private func handle(forSubscribed central: CBCentral) -> String {
        if let existing = handles[central.identifier] { return existing }
        let peerId = CourierPeerHandle.make()
        handles[central.identifier] = peerId
        centrals[peerId] = central
        // A central has no name. `CBCentral` exposes an identifier and a maximum
        // value length and nothing else — the GAP name belongs to whoever is
        // advertising, and a central is not. Rather than invent a label, the
        // label is empty and the UI should render "unnamed device". Adding a
        // characteristic for the peer to publish its name would mean adding to
        // the GATT profile in `gatt.ts`, which is fixed.
        sink?.emitPeerFound(peerId: peerId, label: "", rssi: nil)
        return peerId
    }

    private func dropAllCentrals(reason: String) {
        let peerIds = Array(centrals.keys)
        centrals.removeAll()
        handles.removeAll()
        awaitingReady.removeAll()
        for peerId in peerIds {
            sink?.emitDisconnected(peerId: peerId, reason: reason)
        }
    }

    private static func unavailableSentence(for state: CBManagerState) -> String {
        switch state {
        case .poweredOff:
            return "Bluetooth is turned off, so this device cannot be found by other devices. "
                + "Turn it on in Control Centre or in Settings."
        case .unauthorized:
            return "This app is not allowed to use Bluetooth, so it cannot be found by other "
                + "devices. Enable it in Settings › Privacy & Security › Bluetooth."
        case .unsupported:
            return "This device has no Bluetooth Low Energy radio. Move data by USB or QR."
        case .resetting:
            return "The Bluetooth system is restarting. Try again in a few seconds."
        default:
            return "Bluetooth is not ready yet. Try again in a moment."
        }
    }

    // MARK: - Writing

    /// Send one packet to one subscribed central.
    ///
    /// The only interesting line in this file is the `updateValue` call, and the
    /// only interesting thing about it is that when it returns false the packet
    /// was NOT sent and nothing here retains a copy. The TypeScript side keeps
    /// the packet at the head of its queue and re-sends the same bytes after
    /// `readyToWrite`; buffering it here as well would put two queues in series
    /// and reorder packets the moment they disagreed.
    func write(peerId: String, data: Data) -> CourierWriteOutcome {
        dispatchPrecondition(condition: .onQueue(queue))
        guard let manager, manager.state == .poweredOn,
            let tx = txCharacteristic,
            let central = centrals[peerId]
        else {
            return .unknownPeer
        }

        // A notification longer than this is silently truncated by iOS
        // (documented). Truncation would corrupt exactly one packet and the far
        // side would abandon the frame with no idea why, so refuse loudly
        // instead. In normal operation this cannot fire: the value reported by
        // `connect()` is derived from this same number.
        let maximum = central.maximumUpdateValueLength
        if data.count > maximum {
            return .tooLarge(max: maximum)
        }

        if manager.updateValue(data, for: tx, onSubscribedCentrals: [central]) {
            return .accepted
        }

        // Queue full. Remember that THIS peer is owed a readiness signal.
        awaitingReady.insert(peerId)
        return .refused
    }
}

// MARK: - CBPeripheralManagerDelegate

extension CourierPeripheral: CBPeripheralManagerDelegate {
    func peripheralManagerDidUpdateState(_ peripheral: CBPeripheralManager) {
        log.info("peripheral manager state: \(peripheral.state.rawValue, privacy: .public)")

        switch peripheral.state {
        case .poweredOn:
            // Republish and resume advertising if that is what the app asked
            // for. Core Bluetooth drops published services when the radio goes
            // down and does not restore them, so without this, turning Bluetooth
            // off and on mid-event leaves a device silently undiscoverable —
            // advertising nothing, with the app showing no error at all.
            beginAdvertisingIfWanted()

        default:
            servicePublication = .absent
            txCharacteristic = nil
            dropAllCentrals(reason: "Bluetooth became unavailable on this device")
            settleAdvertiseWaiters(CourierBleError(Self.unavailableSentence(for: peripheral.state)))
        }

        let waiters = stateWaiters
        stateWaiters = []
        for waiter in waiters { waiter() }
    }

    func peripheralManager(_ peripheral: CBPeripheralManager, didAdd service: CBService, error: Error?) {
        guard service.uuid == CourierGatt.serviceUUID else { return }
        if let error {
            servicePublication = .absent
            log.error("failed to publish the Courier service: \(error.localizedDescription, privacy: .public)")
            settleAdvertiseWaiters(
                CourierBleError(
                    "iOS refused to publish the Courier Bluetooth service: "
                        + error.localizedDescription))
            return
        }
        servicePublication = .present
        log.info("published the Courier service")
        beginAdvertisingIfWanted()
    }

    func peripheralManagerDidStartAdvertising(_ peripheral: CBPeripheralManager, error: Error?) {
        if let error {
            log.error("advertising failed: \(error.localizedDescription, privacy: .public)")
            settleAdvertiseWaiters(
                CourierBleError("iOS could not start advertising: " + error.localizedDescription))
        } else {
            // The label is not logged: it is a device label by contract, but it
            // is also operator-supplied free text and there is no way to be sure
            // from here that nobody typed a name into it.
            log.info("advertising the Courier service")
            settleAdvertiseWaiters(nil)
        }
    }

    func peripheralManager(
        _ peripheral: CBPeripheralManager, central: CBCentral,
        didSubscribeTo characteristic: CBCharacteristic
    ) {
        guard characteristic.uuid == CourierGatt.txUUID else { return }
        let peerId = handle(forSubscribed: central)
        // Refresh the stored instance: Core Bluetooth does not promise the same
        // CBCentral object across callbacks, and `maximumUpdateValueLength` is
        // read off whichever one is current.
        centrals[peerId] = central
        log.info(
            "central \(peerId, privacy: .public) subscribed, payload \(central.maximumUpdateValueLength, privacy: .public) bytes"
        )
    }

    func peripheralManager(
        _ peripheral: CBPeripheralManager, central: CBCentral,
        didUnsubscribeFrom characteristic: CBCharacteristic
    ) {
        guard characteristic.uuid == CourierGatt.txUUID else { return }
        guard let peerId = handles[central.identifier] else { return }
        centrals.removeValue(forKey: peerId)
        handles.removeValue(forKey: central.identifier)
        awaitingReady.remove(peerId)
        log.info("central \(peerId, privacy: .public) unsubscribed")
        sink?.emitDisconnected(peerId: peerId, reason: "the peer closed the link")
    }

    /// The backpressure release valve, and the reason the whole plugin surface
    /// has a `readyToWrite` event.
    ///
    /// Apple documents this as "the peripheral manager is again ready to send
    /// characteristic value updates", and it is invoked after a failed
    /// `updateValue`. It says nothing about WHICH central drained, so the signal
    /// goes to exactly the peers whose last write was refused. Signalling every
    /// subscriber instead would wake links that were never blocked; signalling
    /// none would stall a sync until its 15-second timeout.
    func peripheralManagerIsReady(toUpdateSubscribers peripheral: CBPeripheralManager) {
        let owed = awaitingReady
        awaitingReady.removeAll()
        for peerId in owed {
            sink?.emitReadyToWrite(peerId: peerId)
        }
    }

    func peripheralManager(_ peripheral: CBPeripheralManager, didReceiveWrite requests: [CBATTRequest]) {
        guard let first = requests.first else { return }

        // Apple's documentation requires exactly one response per invocation,
        // using the first request, and requires it even when there is nothing to
        // report. Whether responding is also correct for a write-WITHOUT-response
        // request — which arrives through this same callback — is not something I
        // can verify without a device; Apple's wording does not distinguish, so
        // this responds unconditionally.
        var result: CBATTError.Code = .success

        for request in requests {
            guard request.characteristic.uuid == CourierGatt.rxUUID else {
                result = .requestNotSupported
                break
            }
            // A value longer than the ATT MTU allows arrives as several requests
            // at increasing offsets (a "long write"). Reassembling those would be
            // framing logic, and framing logic lives in TypeScript — and more to
            // the point, a correct Courier peer never sends one, because it sizes
            // packets from the MTU this plugin reported. Refuse rather than
            // hand up a fragment that would look like a corrupt packet.
            guard request.offset == 0 else {
                result = .invalidOffset
                break
            }
            guard let value = request.value, !value.isEmpty else { continue }

            // Only a subscribed central is a peer (see `handle(forSubscribed:)`).
            // A write from anything else cannot be answered — this device has no
            // way to notify back — so it is refused rather than handed up as
            // half a conversation.
            guard let peerId = handles[request.central.identifier] else {
                log.info("write from a central that has not subscribed to TX; refused")
                result = .requestNotSupported
                break
            }
            sink?.emitPacketReceived(peerId: peerId, base64: value.base64EncodedString())
        }

        peripheral.respond(to: first, withResult: result)
    }

    func peripheralManager(_ peripheral: CBPeripheralManager, didReceiveRead request: CBATTRequest) {
        // TX carries notifications only; there is no stored value to read. An
        // empty success is friendlier to a central that probes the profile than
        // an error, and it leaks nothing.
        if request.characteristic.uuid == CourierGatt.txUUID {
            request.value = Data()
            peripheral.respond(to: request, withResult: .success)
        } else {
            peripheral.respond(to: request, withResult: .requestNotSupported)
        }
    }
}
