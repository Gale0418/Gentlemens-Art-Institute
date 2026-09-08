import Foundation
@main struct CommercePolicyChecks {
 static func main() {
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
