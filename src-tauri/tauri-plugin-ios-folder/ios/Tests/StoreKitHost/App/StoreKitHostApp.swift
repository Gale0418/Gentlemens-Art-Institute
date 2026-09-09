import SwiftUI
@testable import tauri_plugin_ios_folder

@MainActor
final class StoreKitHostModel: ObservableObject {
    @Published private(set) var isPro = false
    @Published private(set) var result = "尚未驗證"
    @Published private(set) var status = "尚未載入"
    @Published private(set) var message = "啟動後會直接讀取 StoreKit currentEntitlements。"
    @Published private(set) var displayPrice: String?
    @Published private(set) var productId = CommercePolicy.proProductId
    @Published private(set) var isBusy = false

    func loadCommerce() {
        run { await CommerceManager.shared.getCommerce() }
    }

    func purchase() {
        run { await CommerceManager.shared.purchasePro() }
    }

    func restore() {
        run { await CommerceManager.shared.restorePro() }
    }

    private func run(_ operation: @escaping () async -> [String: Any]) {
        guard !isBusy else { return }
        isBusy = true
        Task { @MainActor in
            defer { isBusy = false }
            apply(await operation())
        }
    }

    private func apply(_ payload: [String: Any]) {
        isPro = payload["pro"] as? Bool ?? false
        status = payload["status"] as? String ?? "unknown"
        result = resultText(status: status, isPro: isPro)
        message = payload["message"] as? String
            ?? "生產 CommerceManager 未提供訊息。"
        displayPrice = payload["displayPrice"] as? String
        productId = payload["productId"] as? String ?? CommercePolicy.proProductId
    }

    private func resultText(status: String, isPro: Bool) -> String {
        switch status {
        case CommerceStatus.purchased.rawValue, CommerceStatus.restored.rawValue:
            return isPro ? "成功：Pro 已啟用" : "失敗：交易未授予 Pro"
        case CommerceStatus.ready.rawValue:
            return "成功：商品可用，目前未啟用 Pro"
        case CommerceStatus.cancelled.rawValue:
            return "已取消購買"
        case CommerceStatus.pending.rawValue:
            return "處理中：等待購買核准"
        default:
            return "失敗：StoreKit 商品或權益暫時無法使用"
        }
    }
}

struct StoreKitHostView: View {
    @ObservedObject var model: StoreKitHostModel

    var body: some View {
        NavigationView {
            Form {
                Section("權益") {
                    valueRow("Pro", model.isPro ? "已啟用" : "未啟用")
                    valueRow("結果", model.result)
                    valueRow("狀態", model.status)
                    valueRow("商品", model.productId)
                    if let displayPrice = model.displayPrice {
                        valueRow("價格", displayPrice)
                    }
                    Text(model.message)
                        .font(.footnote)
                        .foregroundColor(.secondary)
                }

                Section("StoreKit 驗收") {
                    Button("重新整理權益") { model.loadCommerce() }
                    Button("購買 Pro") { model.purchase() }
                    Button("恢復購買") { model.restore() }
                }
            }
            .navigationTitle("G.A.I StoreKit Host")
            .overlay {
                if model.isBusy {
                    ProgressView("處理中…")
                        .padding()
                        .background(.regularMaterial)
                        .clipShape(RoundedRectangle(cornerRadius: 12))
                }
            }
        }
    }

    private func valueRow(_ title: String, _ value: String) -> some View {
        HStack {
            Text(title)
            Spacer()
            Text(value)
                .foregroundColor(.secondary)
                .multilineTextAlignment(.trailing)
        }
    }
}

@main
struct StoreKitHostApp: App {
    @StateObject private var model = StoreKitHostModel()

    var body: some Scene {
        WindowGroup {
            StoreKitHostView(model: model)
                .task {
                    model.loadCommerce()
                }
        }
    }
}
