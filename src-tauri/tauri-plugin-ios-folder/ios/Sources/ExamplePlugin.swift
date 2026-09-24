import SwiftRs
import Tauri
import UIKit
import UniformTypeIdentifiers
import Security

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

class AiKeyArgs: Decodable {
  let provider: String
  let apiKey: String?
}

class ExamplePlugin: Plugin, UIDocumentPickerDelegate {
  private let aiKeychainService = "com.windsheep.gai.ai-api-key"
  private let bookmarkAliasesDefaultsKey = "com.windsheep.gai.external-bookmark-aliases"
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

  private func bookmarkAlias(for bookmark: String) -> String? {
    (UserDefaults.standard.dictionary(forKey: bookmarkAliasesDefaultsKey) as? [String: String])?[bookmark]
  }

  private func saveBookmarkAlias(_ alias: String, for bookmark: String) {
    var aliases = UserDefaults.standard.dictionary(forKey: bookmarkAliasesDefaultsKey) as? [String: String] ?? [:]
    aliases[bookmark] = alias
    UserDefaults.standard.set(aliases, forKey: bookmarkAliasesDefaultsKey)
  }

  private func removeBookmarkAlias(for bookmark: String) {
    guard var aliases = UserDefaults.standard.dictionary(forKey: bookmarkAliasesDefaultsKey) as? [String: String] else {
      return
    }
    aliases.removeValue(forKey: bookmark)
    UserDefaults.standard.set(aliases, forKey: bookmarkAliasesDefaultsKey)
  }
  #endif

  private func presentationController() -> UIViewController? {
    let scenes = UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }
    let foregroundWindows = scenes
      .filter { $0.activationState == .foregroundActive }
      .flatMap(\.windows)
    let allWindows = scenes.flatMap(\.windows)
    let window = foregroundWindows.first(where: { $0.isKeyWindow })
      ?? foregroundWindows.first(where: { $0.rootViewController != nil })
      ?? allWindows.first(where: { $0.isKeyWindow })
      ?? allWindows.first(where: { $0.rootViewController != nil })
    var root = window?.rootViewController
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
          invoke.reject("FOLDER_ROOT_VIEW_CONTROLLER_NOT_FOUND")
          return
        }
        root.present(picker, animated: true)
      } else {
        invoke.reject("FOLDER_IOS_VERSION_UNSUPPORTED")
      }
    }
  }

  public func documentPicker(_ controller: UIDocumentPickerViewController, didPickDocumentsAt urls: [URL]) {
    guard let invoke = activePickers.removeValue(forKey: controller) else { return }
    guard let url = urls.first else {
      invoke.reject("FOLDER_SELECTION_EMPTY")
      return
    }

    let accessed = url.startAccessingSecurityScopedResource()
    if !accessed {
      invoke.reject("FOLDER_SECURITY_SCOPE_ACCESS_FAILED")
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
      invoke.reject("FOLDER_BOOKMARK_CREATE_FAILED")
    }
  }

  public func documentPickerWasCancelled(_ controller: UIDocumentPickerViewController) {
    if let invoke = activePickers.removeValue(forKey: controller) {
      invoke.reject("FOLDER_PICKER_CANCELLED")
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
      let candidates = [bookmarkAlias(for: bookmark), bookmark].compactMap { $0 }
      var lastError = "FOLDER_BOOKMARK_ACCESS_FAILED"
      for candidate in candidates {
        guard let data = Data(base64Encoded: candidate) else {
          lastError = "FOLDER_BOOKMARK_INVALID_BASE64"
          continue
        }

        do {
          var isStale = false
          let url = try URL(resolvingBookmarkData: data, bookmarkDataIsStale: &isStale)
          guard url.startAccessingSecurityScopedResource() else {
            lastError = "FOLDER_BOOKMARK_ACCESS_FAILED"
            continue
          }

          // On iOS, `.withSecurityScope` is unavailable. A stale minimal
          // bookmark can still be refreshed while its scope is active. Keep
          // the original bookmark as the stable external source ID and store
          // refreshed data under that ID for the next launch.
          if isStale {
            do {
              let refreshed = try url.bookmarkData(
                options: .minimalBookmark,
                includingResourceValuesForKeys: nil,
                relativeTo: nil
              )
              saveBookmarkAlias(refreshed.base64EncodedString(), for: bookmark)
            } catch {
              // The current access remains usable; retry refresh next launch.
            }
          }
          activeAccesses[bookmark] = url
          return (url, isStale, nil)
        } catch {
          lastError = "FOLDER_BOOKMARK_RESOLVE_FAILED"
        }
      }
      return (nil, false, lastError)
    }

    if let url = resolution.url {
      invoke.resolve(["path": url.path, "stale": resolution.stale])
    } else {
      invoke.reject(resolution.error ?? "FOLDER_ACCESS_START_FAILED")
    }
  }

  @objc public func stopAccessing(_ invoke: Invoke) throws {
    let args = try invoke.parseArgs(StopAccessingArgs.self)
    let bookmark = args.bookmark
    if let url = accessQueue.sync(execute: { activeAccesses.removeValue(forKey: bookmark) }) {
      url.stopAccessingSecurityScopedResource()
    }
    accessQueue.sync { removeBookmarkAlias(for: bookmark) }
    invoke.resolve([:])
  }

  @objc public func saveAiKey(_ invoke: Invoke) throws {
    let args = try invoke.parseArgs(AiKeyArgs.self)
    guard Self.isAiProvider(args.provider) else {
      invoke.reject("AI_PROVIDER_INVALID")
      return
    }
    guard let apiKey = args.apiKey,
          apiKey.utf8.count >= 16, apiKey.utf8.count <= 512,
          !apiKey.unicodeScalars.contains(where: { CharacterSet.controlCharacters.contains($0) }) else {
      invoke.reject("AI_KEY_INVALID")
      return
    }
    let query = aiKeychainQuery(provider: args.provider)
    let attributes: [String: Any] = [
      kSecValueData as String: Data(apiKey.utf8),
      kSecAttrAccessible as String: kSecAttrAccessibleWhenUnlockedThisDeviceOnly
    ]
    let status = SecItemUpdate(query as CFDictionary, attributes as CFDictionary)
    if status == errSecItemNotFound {
      var item = query
      item.merge(attributes) { _, new in new }
      let addStatus = SecItemAdd(item as CFDictionary, nil)
      guard addStatus == errSecSuccess else {
        invoke.reject("AI_KEY_SAVE_FAILED")
        return
      }
    } else if status != errSecSuccess {
      invoke.reject("AI_KEY_SAVE_FAILED")
      return
    }
    invoke.resolve([:])
  }

  @objc public func loadAiKey(_ invoke: Invoke) throws {
    let args = try invoke.parseArgs(AiKeyArgs.self)
    guard Self.isAiProvider(args.provider) else {
      invoke.reject("AI_PROVIDER_INVALID")
      return
    }
    var query = aiKeychainQuery(provider: args.provider)
    query[kSecReturnData as String] = true
    query[kSecMatchLimit as String] = kSecMatchLimitOne
    var result: CFTypeRef?
    let status = SecItemCopyMatching(query as CFDictionary, &result)
    guard status == errSecSuccess else {
      if status == errSecItemNotFound {
        invoke.reject("AI_KEY_NOT_FOUND")
      } else {
        invoke.reject("AI_KEY_READ_FAILED")
      }
      return
    }
    guard let data = result as? Data,
          let apiKey = String(data: data, encoding: .utf8), !apiKey.isEmpty else {
      invoke.reject("AI_KEY_NOT_FOUND")
      return
    }
    invoke.resolve(["apiKey": apiKey])
  }

  @objc public func hasAiKey(_ invoke: Invoke) throws {
    let args = try invoke.parseArgs(AiKeyArgs.self)
    guard Self.isAiProvider(args.provider) else {
      invoke.reject("AI_PROVIDER_INVALID")
      return
    }
    let status = SecItemCopyMatching(aiKeychainQuery(provider: args.provider) as CFDictionary, nil)
    if status == errSecSuccess {
      invoke.resolve(["present": true])
    } else if status == errSecItemNotFound {
      invoke.resolve(["present": false])
    } else {
      invoke.reject("AI_KEY_READ_FAILED")
    }
  }

  @objc public func deleteAiKey(_ invoke: Invoke) throws {
    let args = try invoke.parseArgs(AiKeyArgs.self)
    guard Self.isAiProvider(args.provider) else {
      invoke.reject("AI_PROVIDER_INVALID")
      return
    }
    let status = SecItemDelete(aiKeychainQuery(provider: args.provider) as CFDictionary)
    guard status == errSecSuccess || status == errSecItemNotFound else {
      invoke.reject("AI_KEY_DELETE_FAILED")
      return
    }
    invoke.resolve([:])
  }

  private func aiKeychainQuery(provider: String) -> [String: Any] {
    [
      kSecClass as String: kSecClassGenericPassword,
      kSecAttrService as String: aiKeychainService,
      kSecAttrAccount as String: provider
    ]
  }

  private static func isAiProvider(_ provider: String) -> Bool {
    provider == "openai" || provider == "google"
  }

  @objc public func ensureAvailable(_ invoke: Invoke) throws {
    let args = try invoke.parseArgs(EnsureAvailableArgs.self)
    guard let rootURL = accessQueue.sync(execute: { activeAccesses[args.bookmark] }) else {
      invoke.reject("FOLDER_BOOKMARK_NOT_ACTIVE")
      return
    }

    let root = rootURL.standardizedFileURL.resolvingSymlinksInPath()
    let candidate = URL(fileURLWithPath: args.path).standardizedFileURL.resolvingSymlinksInPath()
    let rootPath = root.path.hasSuffix("/") ? root.path : root.path + "/"
    guard candidate.path == root.path || candidate.path.hasPrefix(rootPath) else {
      invoke.reject("FOLDER_PATH_OUTSIDE_SELECTED_FOLDER")
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
        invoke.reject("FOLDER_FILE_UNAVAILABLE")
      }
    }
  }
}

@_cdecl("init_plugin_tauri_plugin_ios_folder")
func initPlugin() -> Plugin {
  return ExamplePlugin()
}
