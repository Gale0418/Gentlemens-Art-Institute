//
//  CommercePolicy.swift
//  tauri-plugin-ios-folder
//
//  純決策邏輯、JSON 契約定義與安全過濾
//

import Foundation

public enum CommerceStatus: String {
    case ready = "ready"
    case unavailable = "unavailable"
    case purchased = "purchased"
    case restored = "restored"
    case cancelled = "cancelled"
    case pending = "pending"
}

public struct CommercePolicy {
    /// 固定一次買斷產品 ID（本地擬定待 ASC 建立）
    public static let proProductId = "com.windsheep.gai.pro.v1"

    /// 純決策判定：是否給予 Pro 授權
    /// 規則：StoreKit JWS 簽名驗證通過、商品 ID 相符、非消耗型且無撤銷日期 (revocationDate == nil)
    public static func evaluateEntitlement(
        productID: String,
        expectedProductID: String = proProductId,
        isNonConsumable: Bool,
        isRevoked: Bool,
        isVerified: Bool
    ) -> Bool {
        guard isVerified else { return false }
        guard productID == expectedProductID else { return false }
        guard isNonConsumable else { return false }
        guard !isRevoked else { return false }
        return true
    }

    /// 根據目前權益與商品資訊決定回傳狀態
    public static func determineStatus(
        isPro: Bool,
        hasProduct: Bool,
        overrideStatus: CommerceStatus? = nil
    ) -> CommerceStatus {
        if let override = overrideStatus {
            return override
        }
        if isPro {
            return .purchased
        }
        return hasProduct ? .ready : .unavailable
    }

    /// 打包 getCommerce, purchasePro, restorePro 的 JSON 字典契約
    public static func buildCommercePayload(
        supported: Bool,
        pro: Bool,
        productId: String = proProductId,
        displayPrice: String?,
        status: CommerceStatus,
        message: String?
    ) -> [String: Any] {
        var dict: [String: Any] = [
            "supported": supported,
            "pro": pro,
            "productId": productId,
            "status": status.rawValue
        ]
        
        if let displayPrice = displayPrice {
            dict["displayPrice"] = displayPrice
        } else {
            dict["displayPrice"] = NSNull()
        }
        
        if let message = message {
            dict["message"] = sanitizeMessage(message)
        } else {
            dict["message"] = NSNull()
        }
        
        return dict
    }

    /// 打包 checkPro 的極簡 JSON 字典契約 { "pro": Bool }
    public static func buildCheckProPayload(pro: Bool) -> [String: Any] {
        return ["pro": pro]
    }

    /// iOS 15 以下不支援設備的回傳 payload
    public static var unsupportedPayload: [String: Any] {
        return buildCommercePayload(
            supported: false,
            pro: false,
            productId: proProductId,
            displayPrice: nil,
            status: .unavailable,
            message: "購買功能需要 iOS 15 或更新版本"
        )
    }

    /// 過濾 message 中的敏感資訊，防止洩漏 transaction ID 或 secrets
    public static func sanitizeMessage(_ message: String) -> String {
        var sanitized = message
        // 遮蔽 UUID 或 64-bit transaction ID 模式
        let uuidPattern = "[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}"
        if let regex = try? NSRegularExpression(pattern: uuidPattern) {
            sanitized = regex.stringByReplacingMatches(
                in: sanitized,
                range: NSRange(location: 0, length: sanitized.utf16.count),
                withTemplate: "[REDACTED]"
            )
        }
        return sanitized
    }
}
