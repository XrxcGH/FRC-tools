require 'json'

package = JSON.parse(File.read(File.join(__dir__, 'package.json')))

Pod::Spec.new do |s|
  s.name = 'CourierBle'
  s.version = package['version']
  s.summary = package['description']
  s.license = package['license']
  s.homepage = 'https://github.com/XrxcGH/FRC-tools'
  s.author = 'FRC Tools contributors'
  s.source = { :git => 'https://github.com/XrxcGH/FRC-tools.git', :tag => s.version.to_s }

  # Only the plugin sources. The TypeScript half is delivered by npm.
  s.source_files = 'ios/Sources/CourierBlePlugin/**/*.{swift,h,m,c,cc,mm,cpp}'

  # Core Bluetooth's peripheral role is the reason this plugin exists at all:
  # Web Bluetooth has no GATT server role on any platform, so a PWA cannot be
  # discovered by a peer. iOS 13 is the floor for the CBPeripheralManager
  # behaviour relied on here.
  s.ios.deployment_target = '13.0'
  s.dependency 'Capacitor'
  s.swift_version = '5.5'
  s.frameworks = 'CoreBluetooth'
end
