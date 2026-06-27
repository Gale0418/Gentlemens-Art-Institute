import SwiftRs
import Tauri
import UIKit
import UniformTypeIdentifiers

class StartAccessingArgs: Decodable {
  let bookmark: String
}

class StopAccessingArgs: Decodable {
  let bookmark: String
}

class ExamplePlugin: Plugin, UIDocumentPickerDelegate {
  var activePickers: [UIDocumentPickerViewController: Invoke] = [:]
  var activeAccesses: [String: URL] = [:]

  @objc public func pickFolder(_ invoke: Invoke) throws {
    DispatchQueue.main.async {
      if #available(iOS 14.0, *) {
        let picker = UIDocumentPickerViewController(forOpeningContentTypes: [.folder], asCopy: false)
        picker.delegate = self
        picker.allowsMultipleSelection = false
        
        self.activePickers[picker] = invoke
        
        var root: UIViewController? = nil
        if let scene = UIApplication.shared.connectedScenes.first(where: { $0.activationState == .foregroundActive }) as? UIWindowScene,
           let window = scene.windows.first(where: { $0.isKeyWindow }) {
           root = window.rootViewController
        } else {
           root = UIApplication.shared.windows.first?.rootViewController
        }

        if let root = root {
          root.present(picker, animated: true)
        } else {
          invoke.reject("Cannot find root view controller")
        }
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
    
    do {
      let bookmarkData = try url.bookmarkData(options: .minimalBookmark, includingResourceValuesForKeys: nil, relativeTo: nil)
      let base64 = bookmarkData.base64EncodedString()
      let folderName = url.lastPathComponent
      url.stopAccessingSecurityScopedResource()
      
      invoke.resolve([
        "bookmark": base64,
        "name": folderName
      ])
    } catch {
      url.stopAccessingSecurityScopedResource()
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
    
    if let existingUrl = activeAccesses[bookmark] {
      invoke.resolve(["path": existingUrl.path])
      return
    }
    
    guard let data = Data(base64Encoded: bookmark) else {
      invoke.reject("Invalid bookmark base64")
      return
    }
    
    do {
      var isStale = false
      let url = try URL(resolvingBookmarkData: data, bookmarkDataIsStale: &isStale)
      
      let accessed = url.startAccessingSecurityScopedResource()
      if !accessed {
        invoke.reject("Failed to start accessing")
        return
      }
      
      activeAccesses[bookmark] = url
      invoke.resolve(["path": url.path])
    } catch {
      invoke.reject("Failed to resolve bookmark: \(error)")
    }
  }

  @objc public func stopAccessing(_ invoke: Invoke) throws {
    let args = try invoke.parseArgs(StopAccessingArgs.self)
    let bookmark = args.bookmark
    
    if let url = activeAccesses.removeValue(forKey: bookmark) {
      url.stopAccessingSecurityScopedResource()
    }
    
    invoke.resolve([:])
  }
}

@_cdecl("init_plugin_tauri_plugin_ios_folder")
func initPlugin() -> Plugin {
  return ExamplePlugin()
}
