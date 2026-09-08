import StoreKitTest
import XCTest
@testable import tauri_plugin_ios_folder

@available(iOS 15.0, *)
final class CommerceStoreKitTests: XCTestCase {
    private var session: SKTestSession!

    override func setUpWithError() throws {
        try super.setUpWithError()
#if SWIFT_PACKAGE
        let configurationURL = try XCTUnwrap(Bundle.module.url(
            forResource: "GAI",
            withExtension: "storekit"
        ), "Missing bundled GAI.storekit")
#else
        let configurationURL = try XCTUnwrap(Bundle(for: CommerceStoreKitTests.self).url(
            forResource: "GAI",
            withExtension: "storekit"
        ), "Missing bundled GAI.storekit")
#endif

        session = try SKTestSession(contentsOf: configurationURL)
        session.resetToDefaultState()
        session.clearTransactions()
        session.disableDialogs = true
    }

    override func tearDownWithError() throws {
        if let activeSession = session {
            activeSession.clearTransactions()
            activeSession.resetToDefaultState()
        }
        session = nil
        try super.tearDownWithError()
    }

    /// Exercises the production CommerceManager against StoreKitTest's local server.
    func testPurchaseCurrentEntitlementAndRevocation() async throws {
        let initiallyPro = await CommerceManager.shared.checkProEntitlement()
        XCTAssertFalse(initiallyPro)

        let purchase = await CommerceManager.shared.purchasePro()
        XCTAssertEqual(purchase["status"] as? String, CommerceStatus.purchased.rawValue)
        XCTAssertEqual(purchase["pro"] as? Bool, true)

        let currentPro = await CommerceManager.shared.checkProEntitlement()
        XCTAssertTrue(currentPro)

        guard let transaction = session.allTransactions().first(where: {
            $0.productIdentifier == CommercePolicy.proProductId
        }) else {
            XCTFail("StoreKitTest did not create a transaction")
            return
        }

        try session.refundTransaction(identifier: transaction.identifier)

        var revoked = false
        for _ in 0..<20 {
            if !(await CommerceManager.shared.checkProEntitlement()) {
                revoked = true
                break
            }
            try await Task.sleep(nanoseconds: 100_000_000)
        }
        XCTAssertTrue(revoked, "currentEntitlements should stop granting a refunded non-consumable")
    }
}
