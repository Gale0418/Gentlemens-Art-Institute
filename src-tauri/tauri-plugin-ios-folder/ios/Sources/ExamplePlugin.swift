import SwiftRs
import Tauri
import UIKit
import UniformTypeIdentifiers

@_silgen_name("gai_memory_pressure")
private func gaiMemoryPressure(_ level: UInt8)

class StartAccessingArgs: Decodable {
  let bookmark: String
}

class StopAccessingArgs: Decodable {
  let bookmark: String
}

class EnsureAvailableArgs: Decodable {
  let bookmark: String
  let path: String
}

class ExamplePlugin: Plugin, UIDocumentPickerDelegate {
  var activePickers: [UIDocumentPickerViewController: Invoke] = [:]
  var activeAccesses: [String: URL] = [:]
  private let accessQueue = DispatchQueue(label: "com.windsheep.gai.security-scope")
  #if os(iOS)
  private var memoryPressureSource: DispatchSourceMemoryPressure?
  private var memoryWarningObserver: NSObjectProtocol?

  override init() {
    super.init()
    startMemoryPressureMonitoring()
    if #available(iOS 15.0, *) {
      Task { await CommerceManager.shared.startTransactionListener() }
    }
  }

  deinit {
    memoryWarningObserver.map(NotificationCenter.default.removeObserver)
    memoryPressureSource?.cancel()
    let urls = accessQueue.sync { () -> [URL] in
      let values = Array(activeAccesses.values)
      activeAccesses.removeAll()
      return values
    }
    for url in urls {
      url.stopAccessingSecurityScopedResource()
    }
    activePickers.removeAll()
  }

  private func startMemoryPressureMonitoring() {
    let source = DispatchSource.makeMemoryPressureSource(
      eventMask: [.normal, .warning, .critical],
      queue: DispatchQueue.global(qos: .utility)
    )
    memoryPressureSource = source
    source.setEventHandler { [weak self] in
      guard let events = self?.memoryPressureSource?.data else { return }
      if events.contains(.critical) {
        gaiMemoryPressure(2)
      } else if events.contains(.warning) {
        gaiMemoryPressure(1)
      } else {
        gaiMemoryPressure(0)
      }
    }
    source.resume()

    memoryWarningObserver = NotificationCenter.default.addObserver(
      forName: UIApplication.didReceiveMemoryWarningNotification,
      object: nil,
      queue: nil
    ) { _ in
      gaiMemoryPressure(2)
    }
  }
  #endif

  private func presentationController() -> UIViewController? {
    var root: UIViewController?
    if let scene = UIApplication.shared.connectedScenes.first(where: { $0.activationState == .foregroundActive }) as? UIWindowScene,
       let window = scene.windows.first(where: { $0.isKeyWindow }) {
      root = window.rootViewController
    } else {
      root = UIApplication.shared.windows.first?.rootViewController
    }
    while let presented = root?.presentedViewController {
      root = presented
    }
    return root
  }

  @objc public func pickFolder(_ invoke: Invoke) throws {
    DispatchQueue.main.async {
      if #available(iOS 14.0, *) {
        let picker = UIDocumentPickerViewController(forOpeningContentTypes: [.folder], asCopy: false)
        picker.delegate = self
        picker.allowsMultipleSelection = false
        self.activePickers[picker] = invoke

        guard let root = self.presentationController() else {
          self.activePickers.removeValue(forKey: picker)
          invoke.reject("Cannot find root view controller")
          return
        }
        root.present(picker, animated: true)
      } else {
        invoke.reject("Requires iOS 14.0 or newer")
      }
    }
  }

  public func documentPicker(_ controller: UIDocumentPickerViewController, didPickDocumentsAt urls: [URL]) {
    guard let invoke = activePickers.removeValue(forKey: controller) else { return }
    guard let url = urls.first else {
      invoke.reject("No URL selected")
      return
    }

    let accessed = url.startAccessingSecurityScopedResource()
    if !accessed {
      invoke.reject("Cannot access security scoped resource")
      return
    }

    defer { url.stopAccessingSecurityScopedResource() }
    do {
      let bookmarkData = try url.bookmarkData(options: .minimalBookmark, includingResourceValuesForKeys: nil, relativeTo: nil)
      invoke.resolve([
        "bookmark": bookmarkData.base64EncodedString(),
        "name": url.lastPathComponent
      ])
    } catch {
      invoke.reject("Failed to create bookmark: \(error)")
    }
  }

  public func documentPickerWasCancelled(_ controller: UIDocumentPickerViewController) {
    if let invoke = activePickers.removeValue(forKey: controller) {
      invoke.reject("User cancelled")
    }
  }

  @objc public func startAccessing(_ invoke: Invoke) throws {
    let args = try invoke.parseArgs(StartAccessingArgs.self)
    let bookmark = args.bookmark

    // The check, scope acquisition and registration must be one serialized
    // operation. Two concurrent callers otherwise both acquire a scope, then
    // overwrite the same dictionary entry, leaving one acquisition impossible
    // to balance with stopAccessingSecurityScopedResource().
    let resolution: (url: URL?, stale: Bool, error: String?) = accessQueue.sync {
      if let existingURL = activeAccesses[bookmark] {
        return (existingURL, false, nil)
      }
      guard let data = Data(base64Encoded: bookmark) else {
        return (nil, false, "Invalid bookmark base64")
      }

      do {
        var isStale = false
        let url = try URL(resolvingBookmarkData: data, bookmarkDataIsStale: &isStale)
        guard url.startAccessingSecurityScopedResource() else {
          return (nil, false, "Failed to start accessing")
        }
        activeAccesses[bookmark] = url
        return (url, isStale, nil)
      } catch {
        return (nil, false, "Failed to resolve bookmark: \(error)")
      }
    }

    if let url = resolution.url {
      invoke.resolve(["path": url.path, "stale": resolution.stale])
    } else {
      invoke.reject(resolution.error ?? "Failed to start accessing")
    }
  }

  @objc public func stopAccessing(_ invoke: Invoke) throws {
    let args = try invoke.parseArgs(StopAccessingArgs.self)
    let bookmark = args.bookmark
    if let url = accessQueue.sync(execute: { activeAccesses.removeValue(forKey: bookmark) }) {
      url.stopAccessingSecurityScopedResource()
    }
    invoke.resolve([:])
  }

  @objc public func ensureAvailable(_ invoke: Invoke) throws {
    let args = try invoke.parseArgs(EnsureAvailableArgs.self)
    guard let rootURL = accessQueue.sync(execute: { activeAccesses[args.bookmark] }) else {
      invoke.reject("Security-scoped bookmark is not active")
      return
    }

    let root = rootURL.standardizedFileURL.resolvingSymlinksInPath()
    let candidate = URL(fileURLWithPath: args.path).standardizedFileURL.resolvingSymlinksInPath()
    let rootPath = root.path.hasSuffix("/") ? root.path : root.path + "/"
    guard candidate.path == root.path || candidate.path.hasPrefix(rootPath) else {
      invoke.reject("Requested path is outside the selected folder")
      return
    }

    DispatchQueue.global(qos: .userInitiated).async {
      do {
        if FileManager.default.isUbiquitousItem(at: candidate) {
          var values = try candidate.resourceValues(forKeys: [
            .ubiquitousItemDownloadingStatusKey,
            .ubiquitousItemDownloadingErrorKey
          ])
          if values.ubiquitousItemDownloadingStatus == .notDownloaded {
            try FileManager.default.startDownloadingUbiquitousItem(at: candidate)
          }

          let deadline = Date().addingTimeInterval(30)
          while values.ubiquitousItemDownloadingStatus == .notDownloaded && Date() < deadline {
            Thread.sleep(forTimeInterval: 0.2)
            values = try candidate.resourceValues(forKeys: [
              .ubiquitousItemDownloadingStatusKey,
              .ubiquitousItemDownloadingErrorKey
            ])
            if let error = values.ubiquitousItemDownloadingError {
              throw error
            }
          }
          if values.ubiquitousItemDownloadingStatus == .notDownloaded {
            throw NSError(
              domain: "com.windsheep.gai",
              code: 408,
              userInfo: [NSLocalizedDescriptionKey: "Timed out waiting for iCloud download"]
            )
          }
        }

        var coordinationError: NSError?
        var accessError: Error?
        NSFileCoordinator().coordinate(readingItemAt: candidate, options: [], error: &coordinationError) { coordinatedURL in
          var isDirectory: ObjCBool = false
          guard FileManager.default.fileExists(atPath: coordinatedURL.path, isDirectory: &isDirectory) else {
            accessError = CocoaError(.fileNoSuchFile)
            return
          }
          if !isDirectory.boolValue {
            do {
              let handle = try FileHandle(forReadingFrom: coordinatedURL)
              try handle.close()
            } catch {
              accessError = error
            }
          }
        }

        if let error = coordinationError {
          throw error
        }
        if let error = accessError {
          throw error
        }
        invoke.resolve(["path": candidate.path])
      } catch {
        invoke.reject("File is not available: \(error.localizedDescription)")
      }
    }
  }
}

@_cdecl("init_plugin_tauri_plugin_ios_folder")
func initPlugin() -> Plugin {
  return ExamplePlugin()
}
