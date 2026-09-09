import Foundation
@main struct CommercePolicyChecks {
 static func main() {
  precondition(CommercePolicy.sanitizeMessage("Transaction 123456789012345 and 550e8400-e29b-41d4-a716-446655440000") == "Transaction [REDACTED] and [REDACTED]")
  precondition(CommercePolicy.sanitizeMessage("Error 500 on iOS 15") == "Error 500 on iOS 15")
  let id = CommercePolicy.proProductId
  for verified in [false, true] {
   for correct in [false, true] {
    for nonConsumable in [false, true] {
     for revoked in [false, true] {
      let actual = CommercePolicy.evaluateEntitlement(productID: correct ? id : "other", isNonConsumable: nonConsumable, isRevoked: revoked, isVerified: verified)
      precondition(actual == (verified && correct && nonConsumable && !revoked))
     }
    }
   }
  }
  let payload = CommercePolicy.buildCommercePayload(supported: true, pro: true, productId: id, displayPrice: nil, status: .purchased, message: nil)
  precondition(JSONSerialization.isValidJSONObject(payload))
  print("PASS: 16 StoreKit entitlement policy combinations and offline payload serialization")
 }
}
