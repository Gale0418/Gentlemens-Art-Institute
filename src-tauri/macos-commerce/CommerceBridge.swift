import AppKit
import Foundation
import StoreKit

@available(macOS 12.0, *)
@MainActor
func purchaseOnMac(_ product: Product) async throws -> Product.PurchaseResult {
    if #available(macOS 15.2, *), let window = NSApp.keyWindow ?? NSApp.mainWindow {
        return try await product.purchase(confirmIn: window)
    }
    return try await product.purchase()
}

public typealias CommerceCompletion = @convention(c) (UnsafeMutableRawPointer?, UnsafePointer<UInt8>?, Int) -> Void

@_cdecl("gai_macos_storekit_request")
public func requestCommerce(
    _ action: Int32,
    _ context: UnsafeMutableRawPointer?,
    _ completion: CommerceCompletion
) {
    func reply(_ payload: [String: Any]) {
        guard let data = try? JSONSerialization.data(withJSONObject: payload) else {
            completion(context, nil, 0)
            return
        }
        data.withUnsafeBytes { bytes in
            completion(context, bytes.bindMemory(to: UInt8.self).baseAddress, bytes.count)
        }
    }

    // The action values are shared with StoreKitRequest in Rust.
    guard #available(macOS 12.0, *) else {
        completion(context, nil, 0)
        return
    }

    Task {
        switch action {
        case 0: reply(await CommerceManager.shared.getCommerce())
        case 1: reply(await CommerceManager.shared.purchasePro())
        case 2: reply(await CommerceManager.shared.restorePro())
        case 3: reply(CommercePolicy.buildCheckProPayload(pro: await CommerceManager.shared.checkProEntitlement()))
        default: completion(context, nil, 0)
        }
    }
}
