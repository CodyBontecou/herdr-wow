// Lossless window capture for the pixel strip. Build with:
// xcrun swiftc -parse-as-library -O mac-capture.swift -o mac-capture
import AppKit
import ScreenCaptureKit

@available(macOS 14.0, *)
@main struct MacCapture {
  @MainActor static func main() async {
    do {
      let app = NSApplication.shared
      app.setActivationPolicy(.prohibited)
      let args = CommandLine.arguments
      if args.count == 2 && args[1] == "self-test" {
        print("mac-capture ready")
        return
      }
      if args.count == 2 && args[1] == "permission" {
        guard CGRequestScreenCaptureAccess() else { throw CaptureError.message("Screen Recording access was not granted. Enable it in System Settings > Privacy & Security, then restart the bridge.") }
        return
      }
      guard args.count >= 3, let pid = Int32(args[2]), ["strip", "screenshot"].contains(args[1]) else {
        throw CaptureError.message("usage: mac-capture strip|screenshot PID")
      }
      // Do not invoke a picker or take input focus. Permission is granted by the
      // user in System Settings, never by simulated input.
      guard CGPreflightScreenCaptureAccess() else {
        throw CaptureError.message("Screen Recording permission is required. Grant access to the bridge's terminal/helper in System Settings > Privacy & Security, then restart the bridge.")
      }
      let content = try await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: true)
      let windows = content.windows.filter { $0.owningApplication?.processID == pid && $0.windowLayer == 0 && $0.frame.width > 100 && $0.frame.height > 100 }
      guard let window = windows.max(by: { $0.frame.width * $0.frame.height < $1.frame.width * $1.frame.height }) else {
        throw CaptureError.message("no-window")
      }
      let filter = SCContentFilter(desktopIndependentWindow: window)
      let scale = CGFloat(filter.pointPixelScale)
      let config = SCStreamConfiguration()
      config.showsCursor = false
      config.ignoreShadowsSingleWindow = true
      config.captureResolution = .best
      config.colorSpaceName = CGColorSpace.sRGB
      if args[1] == "strip" {
        let width = min(672, Int(window.frame.width * scale))
        let height = min(192, Int(window.frame.height * scale))
        config.sourceRect = CGRect(x: 0, y: 0, width: CGFloat(width) / scale, height: CGFloat(height) / scale)
        config.width = width
        config.height = height
      } else {
        config.width = Int(window.frame.width * scale)
        config.height = Int(window.frame.height * scale)
      }
      let image = try await SCScreenshotManager.captureImage(contentFilter: filter, configuration: config)
      let output: Data
      if args[1] == "screenshot" {
        guard let jpeg = NSBitmapImageRep(cgImage: image).representation(using: .jpeg, properties: [.compressionFactor: 0.85]) else {
          throw CaptureError.message("could not encode screenshot")
        }
        output = jpeg
      } else {
        let width = image.width, height = image.height
        var rgba = [UInt8](repeating: 0, count: width * height * 4)
        let rendered = rgba.withUnsafeMutableBytes { bytes -> Bool in
          guard let ctx = CGContext(data: bytes.baseAddress, width: width, height: height, bitsPerComponent: 8, bytesPerRow: width * 4, space: CGColorSpace(name: CGColorSpace.sRGB)!, bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue | CGBitmapInfo.byteOrder32Big.rawValue) else { return false }
          ctx.draw(image, in: CGRect(x: 0, y: 0, width: width, height: height))
          return true
        }
        guard rendered else { throw CaptureError.message("could not read captured pixels") }
        var ppm = Data("P6\n\(width) \(height)\n255\n".utf8)
        ppm.reserveCapacity(ppm.count + width * height * 3)
        for pixel in 0..<(width * height) { ppm.append(contentsOf: rgba[(pixel * 4)..<(pixel * 4 + 3)]) }
        output = ppm
      }
      FileHandle.standardOutput.write(output)
    } catch {
      FileHandle.standardError.write(Data("\(error.localizedDescription)\n".utf8))
      exit(1)
    }
  }
}

enum CaptureError: LocalizedError {
  case message(String)
  var errorDescription: String? { if case .message(let text) = self { return text }; return nil }
}
