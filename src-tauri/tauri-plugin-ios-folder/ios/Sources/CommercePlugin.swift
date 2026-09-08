//
//  CommercePlugin.swift
//  tauri-plugin-ios-folder
//
//  原生 StoreKit 2 一次買斷 Pro 核心實作
//

import Foundation
import StoreKit
import Tauri

@available(iOS 15.0, *)
actor CommerceManager {
    static let shared = CommerceManager()

    private var updatesTask: Task<Void, Never>?
    private var isBusy: Bool = false
    private var cachedDisplayPrice: String? = nil

    private init() {}

    deinit {
        updatesTask?.cancel()
    }

    /// 背景監聽外部交易變更（如 Ask to Buy 核准、Family Sharing 授予、跨設備恢復或撤銷）
    public func startTransactionListener() {
        guard updatesTask == nil else { return }
        updatesTask = Task.detached(priority: .background) {
            for await verificationResult in Transaction.updates {
                switch verificationResult {
                case .verified(let transaction):
                    if transaction.productID == CommercePolicy.proProductId {
                        await transaction.finish()
                    }
                case .unverified:
                    // 未經 StoreKit JWS 驗證之交易絕不進行 finish，亦不解鎖
                    break
                }
            }
        }
    }

    /// 核心權益檢查：直接讀取 StoreKit 2 signed entitlements
    /// 離線時由 StoreKit 本機快取支援；嚴格不讀取/寫入任何 UserDefaults 或前端傳入 receipt
    public func checkProEntitlement() async -> Bool {
        startTransactionListener()
        for await verificationResult in Transaction.currentEntitlements {
            switch verificationResult {
            case .verified(let transaction):
                let isEligible = CommercePolicy.evaluateEntitlement(
                    productID: transaction.productID,
                    expectedProductID: CommercePolicy.proProductId,
                    isNonConsumable: transaction.productType == .nonConsumable,
                    isRevoked: transaction.revocationDate != nil,
                    isVerified: true
                )
                if isEligible {
                    return true
                }
            case .unverified:
                continue
            }
        }
        return false
    }

    /// 查詢商務狀態：重新檢驗權益並嘗試獲取價格
    /// 若網路價格獲取失敗（離線或 ASC 尚未啟用），既有 pro 依然依據 currentEntitlements 維持 true
    public func getCommerce() async -> [String: Any] {
        var price: String? = nil
        var fetchSuccess = false

        do {
            let products = try await Product.products(for: [CommercePolicy.proProductId])
            if let product = products.first(where: { $0.id == CommercePolicy.proProductId }) {
                price = product.displayPrice
                cachedDisplayPrice = price
                fetchSuccess = true
            }
        } catch {
            // 網路請求失敗或未發布商品，不改動 isPro
        }

        let isPro = await checkProEntitlement()
        let status = CommercePolicy.determineStatus(
            isPro: isPro,
            hasProduct: fetchSuccess
        )

        let message: String?
        if !isPro && !fetchSuccess && price == nil {
            message = "暫時無法取得商品資訊，請稍後再試"
        } else {
            message = nil
        }

        return CommercePolicy.buildCommercePayload(
            supported: true,
            pro: isPro,
            productId: CommercePolicy.proProductId,
            displayPrice: price,
            status: status,
            message: message
        )
    }

    /// 執行 Pro 一次性購買
    /// 並行串行化：若正在購買或恢復中，拒絕重入並返回 pending
    public func purchasePro() async -> [String: Any] {
        if isBusy {
            let currentPro = await checkProEntitlement()
            return CommercePolicy.buildCommercePayload(
                supported: true,
                pro: currentPro,
                productId: CommercePolicy.proProductId,
                displayPrice: cachedDisplayPrice,
                status: .pending,
                message: "購買或恢復正在處理，請稍候"
            )
        }

        isBusy = true
        defer { isBusy = false }

        let currentPro = await checkProEntitlement()
        if currentPro {
            return CommercePolicy.buildCommercePayload(
                supported: true,
                pro: true,
                productId: CommercePolicy.proProductId,
                displayPrice: cachedDisplayPrice,
                status: .purchased,
                message: "已解鎖 G.A.I Pro"
            )
        }

        // 載入商品資訊
        let product: Product
        do {
            let products = try await Product.products(for: [CommercePolicy.proProductId])
            guard let foundProduct = products.first(where: { $0.id == CommercePolicy.proProductId }) else {
                return CommercePolicy.buildCommercePayload(
                    supported: true,
                    pro: false,
                    productId: CommercePolicy.proProductId,
                    displayPrice: cachedDisplayPrice,
                    status: .unavailable,
                    message: "此商品目前尚未開放購買"
                )
            }
            product = foundProduct
            cachedDisplayPrice = product.displayPrice
        } catch {
            return CommercePolicy.buildCommercePayload(
                supported: true,
                pro: false,
                productId: CommercePolicy.proProductId,
                displayPrice: cachedDisplayPrice,
                status: .unavailable,
                message: "暫時無法取得 Apple 商品資訊，請稍後再試"
            )
        }

        // 呼叫系統原生付款 Sheet
        do {
            let result = try await product.purchase()
            switch result {
            case .success(let verification):
                switch verification {
                case .verified(let transaction):
                    let isEligible = CommercePolicy.evaluateEntitlement(
                        productID: transaction.productID,
                        expectedProductID: CommercePolicy.proProductId,
                        isNonConsumable: transaction.productType == .nonConsumable,
                        isRevoked: transaction.revocationDate != nil,
                        isVerified: true
                    )
                    if isEligible {
                        await transaction.finish()
                        return CommercePolicy.buildCommercePayload(
                            supported: true,
                            pro: true,
                            productId: CommercePolicy.proProductId,
                            displayPrice: product.displayPrice,
                            status: .purchased,
                            message: nil
                        )
                    } else {
                        return CommercePolicy.buildCommercePayload(
                            supported: true,
                            pro: false,
                            productId: CommercePolicy.proProductId,
                            displayPrice: product.displayPrice,
                            status: .unavailable,
                            message: "無法驗證這筆購買，未解鎖 Pro"
                        )
                    }
                case .unverified:
                    return CommercePolicy.buildCommercePayload(
                        supported: true,
                        pro: false,
                        productId: CommercePolicy.proProductId,
                        displayPrice: product.displayPrice,
                        status: .unavailable,
                        message: "無法驗證這筆購買，未解鎖 Pro"
                    )
                }

            case .userCancelled:
                let pro = await checkProEntitlement()
                return CommercePolicy.buildCommercePayload(
                    supported: true,
                    pro: pro,
                    productId: CommercePolicy.proProductId,
                    displayPrice: product.displayPrice,
                    status: .cancelled,
                    message: "已取消購買"
                )

            case .pending:
                let pro = await checkProEntitlement()
                return CommercePolicy.buildCommercePayload(
                    supported: true,
                    pro: pro,
                    productId: CommercePolicy.proProductId,
                    displayPrice: product.displayPrice,
                    status: .pending,
                    message: "購買正在等待核准，完成後會更新權益"
                )

            @unknown default:
                let pro = await checkProEntitlement()
                return CommercePolicy.buildCommercePayload(
                    supported: true,
                    pro: pro,
                    productId: CommercePolicy.proProductId,
                    displayPrice: product.displayPrice,
                    status: .unavailable,
                    message: "暫時無法確認購買結果，請使用恢復購買"
                )
            }
        } catch StoreKitError.userCancelled {
            let pro = await checkProEntitlement()
            return CommercePolicy.buildCommercePayload(
                supported: true,
                pro: pro,
                productId: CommercePolicy.proProductId,
                displayPrice: product.displayPrice,
                status: .cancelled,
                message: "已取消購買"
            )
        } catch {
            let pro = await checkProEntitlement()
            return CommercePolicy.buildCommercePayload(
                supported: true,
                pro: pro,
                productId: CommercePolicy.proProductId,
                displayPrice: product.displayPrice,
                status: .unavailable,
                message: "購買暫時失敗，請稍後再試"
            )
        }
    }

    /// 恢復購買：只有此明確動作才會觸發 AppStore.sync()
    public func restorePro() async -> [String: Any] {
        if isBusy {
            let currentPro = await checkProEntitlement()
            return CommercePolicy.buildCommercePayload(
                supported: true,
                pro: currentPro,
                productId: CommercePolicy.proProductId,
                displayPrice: cachedDisplayPrice,
                status: .pending,
                message: "購買或恢復正在處理，請稍候"
            )
        }

        isBusy = true
        defer { isBusy = false }

        do {
            try await AppStore.sync()
        } catch {
            return CommercePolicy.buildCommercePayload(
                supported: true, pro: await checkProEntitlement(),
                productId: CommercePolicy.proProductId, displayPrice: nil,
                status: .unavailable, message: "恢復購買暫時失敗，請確認網路後再試；既有權益仍保留")
        }

        let isPro = await checkProEntitlement()
        if isPro {
            return CommercePolicy.buildCommercePayload(
                supported: true,
                pro: true,
                productId: CommercePolicy.proProductId,
                displayPrice: cachedDisplayPrice,
                status: .restored,
                message: "已恢復 G.A.I Pro"
            )
        } else {
            return CommercePolicy.buildCommercePayload(
                supported: true,
                pro: false,
                productId: CommercePolicy.proProductId,
                displayPrice: cachedDisplayPrice,
                status: .ready,
                message: "目前的 Apple 帳號沒有可恢復的 Pro 購買"
            )
        }
    }
}

// MARK: - ExamplePlugin Commerce Extension
extension ExamplePlugin {
    @objc public func getCommerce(_ invoke: Invoke) {
        guard #available(iOS 15.0, *) else {
            invoke.resolve(CommercePolicy.unsupportedPayload)
            return
        }
        Task {
            let payload = await CommerceManager.shared.getCommerce()
            invoke.resolve(payload)
        }
    }

    @objc public func purchasePro(_ invoke: Invoke) {
        guard #available(iOS 15.0, *) else {
            invoke.resolve(CommercePolicy.unsupportedPayload)
            return
        }
        Task {
            let payload = await CommerceManager.shared.purchasePro()
            invoke.resolve(payload)
        }
    }

    @objc public func restorePro(_ invoke: Invoke) {
        guard #available(iOS 15.0, *) else {
            invoke.resolve(CommercePolicy.unsupportedPayload)
            return
        }
        Task {
            let payload = await CommerceManager.shared.restorePro()
            invoke.resolve(payload)
        }
    }

    @objc public func checkPro(_ invoke: Invoke) {
        guard #available(iOS 15.0, *) else {
            invoke.resolve(CommercePolicy.buildCheckProPayload(pro: false))
            return
        }
        Task {
            let isPro = await CommerceManager.shared.checkProEntitlement()
            invoke.resolve(CommercePolicy.buildCheckProPayload(pro: isPro))
        }
    }
}
